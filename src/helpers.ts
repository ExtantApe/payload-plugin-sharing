import type { Field, PayloadRequest, Where } from 'payload'

import { GROUPS, MEMBERS, type MemberRef, type ResolvedSharing, type Role, type ShareMember } from './types.js'

/** The id of a document given as a document, an id, or nothing. */
export const idOf = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return idOf((value as { id?: unknown }).id)
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

/** A member reference from `{ relationTo, value }` where value may be an id or a populated document. */
export const refOf = (value: unknown): MemberRef | null => {
  if (!value || typeof value !== 'object') return null
  const v = value as { relationTo?: unknown; value?: unknown }
  const id = idOf(v.value)
  return typeof v.relationTo === 'string' && id !== null ? { relationTo: v.relationTo, value: id } : null
}

export const sameRef = (a: MemberRef, b: MemberRef) => a.relationTo === b.relationTo && String(a.value) === String(b.value)

export function settings(req: Pick<PayloadRequest, 'payload'>): ResolvedSharing {
  const s = (req.payload.config.custom as { sharing?: ResolvedSharing } | undefined)?.sharing
  if (!s) throw new Error('payload-plugin-sharing is not installed')
  return s
}

export const roleOf = (s: ResolvedSharing, level: unknown): Role | null =>
  (Object.keys(s.levels) as Role[]).find((r) => s.levels[r].value === level) ?? null

/** The signed-in user, only if they come from the users collection. */
export const signedIn = (req: PayloadRequest, s: ResolvedSharing) => {
  const user = req.user as ({ id: string | number; collection?: string } & Record<string, unknown>) | null
  return user && user.collection === s.users && idOf(user) !== null ? user : null
}

/** The user plus whatever the host's `identities` hook adds. Throws if the hook throws; callers fail closed. */
export async function identitiesOf(req: PayloadRequest, s = settings(req)): Promise<MemberRef[]> {
  const user = signedIn(req, s)
  if (!user) return []
  const refs: MemberRef[] = [{ relationTo: s.users, value: user.id }]
  if (s.identities) {
    for (const raw of await s.identities({ req, user })) {
      const ref = refOf(raw)
      if (ref && s.memberTypes.includes(ref.relationTo) && !refs.some((r) => sameRef(r, ref))) refs.push(ref)
    }
  }
  return refs
}

export const whereRefs = (refs: MemberRef[]): Where =>
  ({ or: refs.map((r) => ({ and: [{ 'member.relationTo': { equals: r.relationTo } }, { 'member.value': { equals: r.value } }] })) }) as unknown as Where

export type Membership = { id: string | number; group: string | number; level: string; role: Role }

/** The active memberships the signed-in user has, directly or through an identity. Throws on a read error. */
export async function membershipsOf(req: PayloadRequest, options: { group?: string | number } = {}): Promise<Membership[]> {
  const s = settings(req)
  const refs = await identitiesOf(req, s)
  if (!refs.length) return []
  const and: Where[] = [{ status: { equals: 'active' } }, whereRefs(refs)]
  if (options.group !== undefined) and.push({ group: { equals: options.group } })
  const found = await req.payload.find({ collection: MEMBERS as never, where: { and }, pagination: false, depth: 0, overrideAccess: true, req })
  const out: Membership[] = []
  for (const d of found.docs as unknown as ShareMember[]) {
    const role = roleOf(s, d.level)
    const group = idOf(d.group)
    if (role && group !== null) out.push({ id: d.id as string | number, group, level: d.level, role })
  }
  return out
}

const RANK: Record<Role, number> = { viewer: 1, manager: 2, owner: 3 }
const best = (rows: Membership[]): Role | null => rows.reduce<Role | null>((a, m) => (a === null || RANK[m.role] > RANK[a] ? m.role : a), null)

/** The highest role the signed-in user holds in one group, or null. Throws on a read error. */
export async function roleIn(req: PayloadRequest, group: string | number): Promise<Role | null> {
  return best(await membershipsOf(req, { group }))
}

type Need = 'view' | 'edit' | 'own'
const allows = (role: Role, need: Need) => (need === 'view' ? true : need === 'edit' ? role !== 'viewer' : role === 'owner')

/** Ids of the groups where the signed-in user has at least this much access. Throws on a read error. */
export async function groupIdsFor(req: PayloadRequest, need: Need = 'view'): Promise<(string | number)[]> {
  const ids = new Set<string | number>()
  for (const m of await membershipsOf(req)) if (allows(m.role, need)) ids.add(m.group)
  return [...ids]
}

export type HelperOptions = { /** The field on the record that holds its group or groups. Default `shareGroup`. */ field?: string }

const groupsOf = (doc: unknown, field: string): (string | number)[] => {
  const v = doc && typeof doc === 'object' ? (doc as Record<string, unknown>)[field] : null
  return (Array.isArray(v) ? v : [v]).map(idOf).filter((x): x is string | number => x !== null)
}

async function can(req: PayloadRequest, doc: unknown, need: Need, field: string): Promise<boolean> {
  try {
    const groups = groupsOf(doc, field)
    if (!groups.length) return false
    const mine = new Set((await groupIdsFor(req, need)).map(String))
    return groups.some((g) => mine.has(String(g)))
  } catch {
    return false
  }
}

/** Whether the signed-in user may see a record, because they are active in one of its groups. Any error is false. */
export const canView = (req: PayloadRequest, doc: unknown, options: HelperOptions = {}) => can(req, doc, 'view', options.field ?? 'shareGroup')

/** Whether the signed-in user may edit a record: Owner or Manager in one of its groups. Any error is false. */
export const canEdit = (req: PayloadRequest, doc: unknown, options: HelperOptions = {}) => can(req, doc, 'edit', options.field ?? 'shareGroup')

/**
 * A `where` for the host's read or update access: the records in groups the user may view (or edit). Returns false when
 * there are none or on any error. Combine it with the host's own rules using `or`.
 */
export async function sharedWhere(req: PayloadRequest, options: HelperOptions & { need?: 'view' | 'edit' } = {}): Promise<Where | false> {
  try {
    const ids = await groupIdsFor(req, options.need ?? 'view')
    return ids.length ? ({ [options.field ?? 'shareGroup']: { in: ids } } as Where) : false
  } catch {
    return false
  }
}

/**
 * The field a host collection adds to put its records in a group. Setting or changing it needs Owner or Manager in the
 * group the record goes into and in the one it leaves. A change that isn't allowed is dropped, not applied.
 */
export function shareGroupField(options: { name?: string; hasMany?: boolean; label?: string } = {}): Field {
  const name = options.name ?? 'shareGroup'
  const allowed = async ({ req, siblingData, doc }: { req: PayloadRequest; siblingData?: unknown; doc?: unknown }) => {
    try {
      const next = groupsOf(siblingData, name)
      const now = groupsOf(doc, name)
      const touched = [...next, ...now]
      if (!touched.length) return true
      if (next.length === now.length && next.every((g) => now.some((n) => String(n) === String(g)))) return true
      const mine = new Set((await groupIdsFor(req, 'edit')).map(String))
      return touched.every((g) => mine.has(String(g)))
    } catch {
      return false
    }
  }
  return {
    name,
    type: 'relationship',
    relationTo: GROUPS,
    hasMany: options.hasMany ?? false,
    index: true,
    label: options.label ?? 'Shared with',
    access: { create: allowed as never, update: allowed as never },
    admin: { description: 'The share group this record belongs to. Members of the group see it at their level.' },
  } as Field
}
