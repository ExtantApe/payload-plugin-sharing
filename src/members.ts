import type { CollectionConfig, PayloadRequest, Where } from 'payload'

import { exactlyTrue, refuse } from './groups.js'
import { idOf, identitiesOf, refOf, roleIn, roleOf, sameRef, signedIn, whereRefs, groupIdsFor } from './helpers.js'
import {
  GROUPS,
  MEMBERS,
  type AuditEvent,
  type AuditHook,
  type MemberArgs,
  type MemberRef,
  type MemberStatus,
  type ResolvedSharing,
  type Role,
  type ShareGroup,
  type ShareMember,
  type SharingOptions,
} from './types.js'

const GENERAL = 'This person can’t be added to this group.'
const LIVE: MemberStatus[] = ['invited', 'active']
type GroupDoc = ShareGroup & { id: string | number }

const normalize = (doc: Record<string, unknown>): ShareMember => ({
  ...(doc as unknown as ShareMember),
  group: idOf(doc.group) as string | number,
  member: refOf(doc.member) as MemberRef,
  invitedBy: idOf(doc.invitedBy),
  removedBy: idOf(doc.removedBy),
})

export function membersCollection(s: ResolvedSharing, opts: SharingOptions): CollectionConfig {
  const levels = Object.values(s.levels)
  const by = (req: PayloadRequest) => idOf(req.user)

  const loadGroup = async (req: PayloadRequest, id: unknown): Promise<GroupDoc | null> => {
    const gid = idOf(id)
    if (gid === null) return null
    return (await req.payload
      .findByID({ collection: GROUPS as never, id: gid, depth: 0, overrideAccess: true, req })
      .catch(() => null)) as unknown as GroupDoc | null
  }

  /** The asker's hook, with the group and their own role in it. No signed-in user, no hook, or no exact true is a no. */
  const ask = async (fn: ((a: MemberArgs) => boolean | Promise<boolean>) | undefined, req: PayloadRequest, member: Partial<ShareMember>, to?: string) => {
    const user = signedIn(req, s)
    if (!user || !fn) return false
    try {
      const group = await loadGroup(req, member.group)
      if (!group) return false
      const actorRole = await roleIn(req, group.id).catch(() => null)
      return await exactlyTrue(() => fn({ req, user, group, member, actorRole, to }))
    } catch {
      return false
    }
  }

  const isSelf = (req: PayloadRequest, ref: MemberRef) => {
    const user = signedIn(req, s)
    return !!user && ref.relationTo === s.users && String(ref.value) === String(user.id)
  }

  const run = async (hook: AuditHook | undefined, event: AuditEvent, mustPass: boolean) => {
    if (!hook) return
    try {
      await hook(event)
    } catch (error) {
      if (mustPass) throw refuse('This change can’t be recorded right now, so it wasn’t made.')
      event.req.payload.logger.error(`sharing: the ${event.event} audit hook failed: ${(error as Error).message}`)
    }
  }

  /** The host's veto. Only `null` or nothing goes ahead. */
  async function vetoed(req: PayloadRequest, group: GroupDoc, ref: MemberRef, level: string, action: 'invite' | 'accept' | 'change-level') {
    if (!opts.refuseMember) return
    const subject = await req.payload.findByID({ collection: ref.relationTo as never, id: ref.value, depth: 0, overrideAccess: true, req }).catch(() => null)
    if (!subject) throw refuse(GENERAL)
    let why: unknown
    try {
      why = await opts.refuseMember({ req, group, subject: subject as never, ref, level, action })
    } catch {
      throw refuse(GENERAL)
    }
    if (why === null || why === undefined) return
    throw refuse(typeof why === 'string' && why.trim() ? why : GENERAL)
  }

  /**
   * Takes the group's lock and checks that an Owner is left once this one goes. Writing the group first means two
   * Owners leaving or demoting each other at once collide, and one of them is turned back.
   */
  async function keepAnOwner(req: PayloadRequest, group: GroupDoc, leaving: string | number) {
    try {
      const fresh = (await req.payload.findByID({ collection: GROUPS as never, id: group.id, depth: 0, overrideAccess: true, req })) as unknown as { lock?: number }
      await req.payload.update({ collection: GROUPS as never, id: group.id, data: { lock: (fresh.lock ?? 0) + 1 } as never, overrideAccess: true, req })
      const others = await req.payload.find({
        collection: MEMBERS as never,
        where: { and: [{ group: { equals: group.id } }, { status: { equals: 'active' } }, { level: { equals: s.levels.owner.value } }, { id: { not_equals: leaving } }] },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        req,
      })
      if (!others.docs.length) throw refuse('A group always keeps an Owner. Make someone else an Owner first.')
    } catch (error) {
      if ((error as { isPublic?: boolean }).isPublic) throw error
      throw refuse('This group is changing right now. Try again in a moment.')
    }
  }

  return {
    slug: MEMBERS,
    labels: { singular: 'Share member', plural: 'Share members' },
    admin: {
      group: opts.adminGroup ?? 'Sharing',
      useAsTitle: 'level',
      defaultColumns: ['group', 'member', 'level', 'status'],
      description: 'Who is in which group, and at what level. Leave by setting the status to Removed; rows are never deleted, so the record stays.',
    },
    access: {
      create: ({ req, data }) => ask(opts.canInvite, req, (data ?? {}) as Partial<ShareMember>),
      update: async ({ req, id, data }) => {
        try {
          if (id === undefined || id === null || !signedIn(req, s)) return false
          const doc = (await req.payload.findByID({ collection: MEMBERS as never, id, depth: 0, overrideAccess: true, req })) as unknown as Record<string, unknown>
          const before = normalize(doc)
          const next = (data ?? {}) as Partial<ShareMember>
          const asks: Promise<boolean>[] = []
          if (next.level !== undefined && next.level !== before.level) asks.push(ask(opts.canChangeLevel, req, before, String(next.level)))
          if (next.status !== undefined && next.status !== before.status) {
            if (next.status === 'active') asks.push(isSelf(req, before.member) ? Promise.resolve(true) : ask(opts.canAccept, req, before))
            else if (next.status === 'removed') asks.push(isSelf(req, before.member) ? Promise.resolve(true) : ask(opts.canRemove ?? opts.canChangeLevel, req, before))
            else return false
          }
          if (!asks.length) return ask(opts.canChangeLevel, req, before, before.level)
          return (await Promise.all(asks)).every(Boolean)
        } catch {
          return false
        }
      },
      delete: () => false,
      read: async ({ req }) => {
        const user = signedIn(req, s)
        if (!user) return false
        try {
          if (opts.canRead) {
            const answer = await opts.canRead({ req, user })
            return answer === true ? true : answer && typeof answer === 'object' ? answer : false
          }
          const refs = await identitiesOf(req, s)
          const groups = await groupIdsFor(req, 'view')
          return { or: [whereRefs(refs), ...(groups.length ? [{ group: { in: groups } }] : [])] } as Where
        } catch {
          return false
        }
      },
    },
    fields: [
      { name: 'group', type: 'relationship', relationTo: GROUPS, required: true, index: true },
      {
        name: 'member',
        type: 'relationship',
        relationTo: s.memberTypes,
        required: true,
        index: true,
        admin: { description: 'A user or an organization.' },
      },
      {
        name: 'level',
        type: 'select',
        required: true,
        index: true,
        options: levels.map((l) => ({ label: l.label, value: l.value })),
      },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'invited',
        index: true,
        options: [
          { label: 'Invited', value: 'invited' },
          { label: 'Active', value: 'active' },
          { label: 'Removed', value: 'removed' },
        ],
        admin: { description: 'An invited member gets nothing until they accept. Removed is final: invite again to bring them back.' },
      },
      { name: 'invitedBy', type: 'relationship', relationTo: s.users, admin: { readOnly: true } },
      { name: 'acceptedAt', type: 'date', admin: { readOnly: true } },
      { name: 'removedAt', type: 'date', admin: { readOnly: true } },
      { name: 'removedBy', type: 'relationship', relationTo: s.users, admin: { readOnly: true } },
      { name: 'notes', type: 'textarea' },
      // Makes a second live membership for the same group and member fail in the database, not just in a check.
      { name: 'liveKey', type: 'text', unique: true, index: true, hidden: true, admin: { disabled: true } },
    ],
    hooks: {
      beforeChange: [
        async ({ data, originalDoc, operation, req }) => {
          const now = new Date().toISOString()
          if (operation === 'create') {
            const group = await loadGroup(req, data.group)
            if (!group) throw refuse('Unknown group.')
            const ref = refOf(data.member)
            if (!ref || !s.memberTypes.includes(ref.relationTo)) throw refuse('Unknown member.')
            if (!roleOf(s, data.level)) throw refuse('Unknown level.')
            const asker = by(req)
            const owner = refOf(group.owner)
            const empty = !(await req.payload.count({ collection: MEMBERS as never, where: { group: { equals: group.id } }, overrideAccess: true, req })).totalDocs
            // The founding Owner is the only member who starts active: the first row of a new group, for its owner.
            const founding = empty && !!owner && sameRef(owner, ref) && data.level === s.levels.owner.value
            data.group = group.id
            data.member = ref
            data.status = founding ? 'active' : 'invited'
            data.acceptedAt = founding ? now : null
            data.removedAt = null
            data.removedBy = null
            if (asker !== null) data.invitedBy = asker
            const dup = await req.payload.find({
              collection: MEMBERS as never,
              where: { and: [{ group: { equals: group.id } }, { 'member.relationTo': { equals: ref.relationTo } }, { 'member.value': { equals: ref.value } }, { status: { in: LIVE } }] },
              limit: 1,
              depth: 0,
              overrideAccess: true,
              req,
            })
            if (dup.docs.length) throw refuse('That member is already in this group.')
            await vetoed(req, group, ref, data.level, 'invite')
            // The database's unique index on this key is what stops two requests at once.
            data.liveKey = JSON.stringify([group.id, ref.relationTo, ref.value])
            await run(opts.audit?.beforeInvite, { event: 'invite', phase: 'before', membership: normalize(data), by: asker, req }, true)
            return data
          }

          // An update. Group, member and who invited never change; only level, status and notes do.
          const before = normalize(originalDoc)
          for (const f of ['group', 'member', 'invitedBy'] as const) {
            if (!(f in data)) continue
            const a = f === 'member' ? refOf(data[f]) : idOf(data[f])
            const b = before[f]
            const same = f === 'member' ? !!a && !!b && sameRef(a as MemberRef, b as MemberRef) : String(a ?? '') === String(b ?? '')
            if (!same) throw refuse('Only the level, status and notes can be changed.')
          }
          for (const f of ['liveKey', 'acceptedAt', 'removedAt', 'removedBy']) delete data[f]
          const level: string = data.level ?? before.level
          const status = (data.status ?? before.status) as MemberStatus
          if (!roleOf(s, level)) throw refuse('Unknown level.')
          if (!['invited', 'active', 'removed'].includes(status)) throw refuse('Unknown status.')
          const levelChanged = level !== before.level
          const statusChanged = status !== before.status
          if (!levelChanged && !statusChanged) return data
          if (before.status === 'removed') throw refuse('A removed member is final. Invite them again.')
          if (statusChanged && !(before.status === 'invited' && (status === 'active' || status === 'removed')) && !(before.status === 'active' && status === 'removed'))
            throw refuse('That status change isn’t allowed.')
          const group = await loadGroup(req, before.group)
          if (!group) throw refuse('Unknown group.')
          const asker = by(req)
          const wasOwner = before.status === 'active' && before.level === s.levels.owner.value
          if (wasOwner && (status === 'removed' || level !== before.level)) await keepAnOwner(req, group, before.id as string | number)
          const after = { ...before, ...normalize({ ...originalDoc, ...data }), level, status }
          if (status === 'removed') {
            data.liveKey = `ended:${String(originalDoc.id)}`
            data.removedAt = now
            data.removedBy = asker
            await run(opts.audit?.beforeRemove, { event: 'remove', phase: 'before', membership: after, previous: before, by: asker, req }, true)
            return data
          }
          if (status === 'active' && statusChanged) {
            data.acceptedAt = now
            await vetoed(req, group, before.member, level, 'accept')
            await run(opts.audit?.beforeAccept, { event: 'accept', phase: 'before', membership: after, previous: before, by: asker, req }, true)
          }
          if (levelChanged) {
            await vetoed(req, group, before.member, level, 'change-level')
            await run(opts.audit?.beforeChangeLevel, { event: 'change-level', phase: 'before', membership: after, previous: before, by: asker, req }, true)
          }
          return data
        },
      ],
      afterChange: [
        async ({ doc, previousDoc, operation, req }) => {
          const membership = normalize(doc)
          const asker = by(req)
          if (operation === 'create') {
            await run(opts.audit?.afterInvite, { event: 'invite', phase: 'after', membership, by: asker, req }, false)
            return doc
          }
          if (!previousDoc) return doc
          const previous = normalize(previousDoc)
          if (previous.status !== membership.status) {
            if (membership.status === 'removed') await run(opts.audit?.afterRemove, { event: 'remove', phase: 'after', membership, previous, by: asker, req }, false)
            else if (membership.status === 'active') await run(opts.audit?.afterAccept, { event: 'accept', phase: 'after', membership, previous, by: asker, req }, false)
          }
          if (previous.level !== membership.level && membership.status !== 'removed')
            await run(opts.audit?.afterChangeLevel, { event: 'change-level', phase: 'after', membership, previous, by: asker, req }, false)
          return doc
        },
      ],
    },
  }
}

export type { Role }
