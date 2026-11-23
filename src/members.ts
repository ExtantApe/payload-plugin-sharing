import { Forbidden, type CollectionConfig, type PayloadRequest, type Where } from 'payload'

import { exactlyTrue, needTransaction, refuse } from './groups.js'
import { idOf, identitiesOf, refOf, roleIn, roleOf, sameRef, signedIn, whereRefs, groupIdsFor } from './helpers.js'
import {
  EVENTS,
  GROUPS,
  MEMBERS,
  type AuditEvent,
  type AuditHook,
  type RefuseArgs,
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

// The left-out list is private to the plugin: it names people the veto refused, so it never goes to the host's audit hooks or hooks' arguments.
const normalize = (doc: Record<string, unknown>): ShareMember => ({
  ...(({ vetoedPeople: _left, ...rest }) => rest)(doc as Record<string, unknown>) as unknown as ShareMember,
  group: idOf(doc.group) as string | number,
  member: refOf(doc.member) as MemberRef,
  invitedBy: idOf(doc.invitedBy),
  removedBy: idOf(doc.removedBy),
})

/** Ids and member references as plain values, whatever shape the client or server code sent them in. */
const plain = (data: Record<string, unknown> | undefined): Partial<ShareMember> => {
  const d = { ...(data ?? {}) } as Record<string, unknown>
  if ('group' in d) d.group = idOf(d.group)
  if ('member' in d) d.member = refOf(d.member)
  if ('invitedBy' in d) d.invitedBy = idOf(d.invitedBy)
  if ('removedBy' in d) d.removedBy = idOf(d.removedBy)
  return d as Partial<ShareMember>
}

export function membersCollection(s: ResolvedSharing, opts: SharingOptions): CollectionConfig {
  const levels = Object.values(s.levels)
  // Only a user from the users collection counts as the actor; a user from another auth collection is recorded as no one.
  const by = (req: PayloadRequest) => signedIn(req, s)?.id ?? null

  const loadGroup = async (req: PayloadRequest, id: unknown): Promise<GroupDoc | null> => {
    const gid = idOf(id)
    if (gid === null) return null
    return (await req.payload
      .findByID({ collection: GROUPS as never, id: gid, depth: 0, overrideAccess: true, req })
      .catch(() => null)) as unknown as GroupDoc | null
  }

  /** The asker's hook, with the group and their own role in it. No signed-in user, no hook, or no exact true is a no. */
  const ask = async (
    fn: ((a: MemberArgs) => boolean | Promise<boolean>) | undefined,
    req: PayloadRequest,
    member: Partial<ShareMember>,
    extra: { id?: string | number; data?: Partial<ShareMember>; to?: string } = {},
  ) => {
    const user = signedIn(req, s)
    if (!user || !fn) return false
    try {
      const group = await loadGroup(req, member.group)
      if (!group) return false
      const actorRole = await roleIn(req, group.id) // a throw (the identities hook, say) is a no, below
      return await exactlyTrue(() => fn({ req, user, group, id: extra.id, member, data: extra.data ?? member, actorRole, to: extra.to }))
    } catch {
      return false
    }
  }

  /** Notes and who invited or removed someone are for the group's Owners and Managers. Everyone else, a child included, doesn't get them. */
  const staffOnly = async ({ req, doc }: { req: PayloadRequest; doc?: Record<string, unknown> }) => {
    try {
      const gid = idOf(doc?.group)
      if (gid === null || !signedIn(req, s)) return false
      const role = await roleIn(req, gid)
      return role === 'owner' || role === 'manager'
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

  /**
   * The host's veto. Only `null` or nothing goes ahead. With `quiet`, a person behind an organization who is refused is left out
   * instead of stopping the organization: their ids come back, and the reason is never kept or shown.
   */
  async function vetoed(req: PayloadRequest, group: GroupDoc, ref: MemberRef, level: string, action: 'invite' | 'accept' | 'change-level', quiet = false): Promise<string[]> {
    const veto = opts.refuseMember
    const left: string[] = []
    if (!veto) return left
    const actor = signedIn(req, s) as RefuseArgs['actor']
    const ask1 = async (target: MemberRef, via?: MemberRef) => {
      const subject = await req.payload.findByID({ collection: target.relationTo as never, id: target.value, depth: 0, overrideAccess: true, req }).catch(() => null)
      if (!subject) throw refuse(GENERAL)
      let why: unknown
      try {
        why = await veto({ req, group, subject: subject as never, ref: target, level, action, actor, via })
      } catch {
        throw refuse(GENERAL)
      }
      if (why === null || why === undefined) return
      throw refuse(typeof why === 'string' && why.trim() ? why : GENERAL)
    }
    await ask1(ref)
    // An organization isn't one person: ask for each person behind it too, so the veto can't be walked around.
    if (ref.relationTo !== s.users && opts.peopleOf) {
      let people: unknown
      try {
        people = await opts.peopleOf({ req, organization: ref })
      } catch {
        throw refuse(GENERAL)
      }
      if (!Array.isArray(people)) throw refuse(GENERAL)
      for (const raw of people) {
        const person = refOf(raw)
        if (!person || person.relationTo !== s.users) throw refuse(GENERAL)
        if (!quiet) await ask1(person, ref)
        else {
          try {
            await ask1(person, ref)
          } catch {
            left.push(String(person.value))
          }
        }
      }
    }
    return left
  }

  /**
   * Takes the group's lock and checks that an Owner is left once this one goes. Writing the group first means two
   * Owners leaving or demoting each other at once collide, and one of them is turned back.
   */
  async function keepAnOwner(req: PayloadRequest, group: GroupDoc, leaving: string | number) {
    await needTransaction(req, s)
    try {
      const fresh = (await req.payload.findByID({ collection: GROUPS as never, id: group.id, depth: 0, overrideAccess: true, req })) as unknown as { lock?: number }
      await req.payload.update({ collection: GROUPS as never, id: group.id, data: { lock: (fresh.lock ?? 0) + 1 } as never, overrideAccess: true, req })
      const others = await req.payload.find({
        collection: MEMBERS as never,
        where: { and: [{ group: { equals: group.id } }, { status: { equals: 'active' } }, { level: { equals: s.levels.owner.value } }, { id: { not_equals: leaving } }] },
        limit: 1,
        pagination: false, // only the rows are used; a count query beside it can break a transaction's first query
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
      create: ({ req, data }) => {
        const d = plain(data as Record<string, unknown>)
        return ask(opts.canInvite, req, d, { data: d })
      },
      update: async ({ req, id, data }) => {
        try {
          if (id === undefined || id === null || !signedIn(req, s)) return false
          const doc = (await req.payload.findByID({ collection: MEMBERS as never, id, depth: 0, overrideAccess: true, req })) as unknown as Record<string, unknown>
          const before = normalize(doc)
          const next = plain(data as Record<string, unknown>)
          const ctx = { id: before.id, data: next }
          const asks: Promise<boolean>[] = []
          if (next.level !== undefined && next.level !== before.level) asks.push(ask(opts.canChangeLevel, req, before, { ...ctx, to: String(next.level) }))
          if (next.status !== undefined && next.status !== before.status) {
            if (next.status === 'active') {
              // A user accepts only their own invitation, never on their behalf. canAccept is for organization members only.
              if (before.member.relationTo === s.users) asks.push(Promise.resolve(isSelf(req, before.member)))
              else asks.push(ask(opts.canAccept, req, before, ctx))
            }
            else if (next.status === 'removed') asks.push(isSelf(req, before.member) ? Promise.resolve(true) : ask(opts.canRemove ?? opts.canChangeLevel, req, before, ctx))
            else return false
          }
          if (!asks.length) return ask(opts.canChangeLevel, req, before, { ...ctx, to: before.level })
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
          const refs = await identitiesOf(req, s)
          const staffed = await groupIdsFor(req, 'edit')
          const viewed = await groupIdsFor(req, 'view')
          // Owners and Managers see every row in their groups. A Viewer sees only the Owners and Managers, and their own row.
          const base = {
            or: [
              whereRefs(refs),
              ...(staffed.length ? [{ group: { in: staffed } }] : []),
              ...(viewed.length ? [{ and: [{ group: { in: viewed } }, { level: { in: [s.levels.owner.value, s.levels.manager.value] } }, { status: { equals: 'active' } }] }] : []),
            ],
          } as unknown as Where
          if (!opts.canRead) return base
          // The host can only add rows. Its `where` is ORed with the default rules, which always apply. `true`, `false`, an
          // empty `where` and a throw add nothing, so no answer can hand out every row, a child's included.
          let extra: unknown = null
          try {
            extra = await opts.canRead({ req, user })
          } catch {
            extra = null
          }
          if (extra && typeof extra === 'object' && !Array.isArray(extra) && Object.keys(extra).length) return { or: [base, extra as Where] } as unknown as Where
          return base
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
      { name: 'invitedBy', type: 'relationship', relationTo: s.users, admin: { readOnly: true }, access: { read: staffOnly } },
      { name: 'acceptedAt', type: 'date', admin: { readOnly: true } },
      { name: 'removedAt', type: 'date', admin: { readOnly: true } },
      { name: 'removedBy', type: 'relationship', relationTo: s.users, admin: { readOnly: true }, access: { read: staffOnly } },
      { name: 'notes', type: 'textarea', maxLength: 500, access: { read: staffOnly }, admin: { description: 'Seen by the group’s Owners and Managers only.' } },
      // Makes a second live membership for the same group and member fail in the database, not just in a check.
      // Who behind an organization the veto left out when it joined. Nobody can read it through the API, not even staff; it only takes access away.
      { name: 'vetoedPeople', type: 'json', admin: { disabled: true }, access: { read: () => false } },
      { name: 'liveKey', type: 'text', unique: true, index: true, hidden: true, admin: { disabled: true } },
    ],
    hooks: {
      // A bulk update can run each row in its own transaction, which would split a change from its history row.
      beforeOperation: [
        ({ args, operation }) => {
          if (operation === 'update' && (args as { id?: unknown }).id === undefined) throw refuse('Memberships are changed one at a time.')
          return args
        },
      ],
      // Nothing is ever deleted, not even by server code that skips access.
      beforeDelete: [
        () => {
          throw refuse('Memberships are never deleted. Set the status to Removed.')
        },
      ],
      beforeChange: [
        async ({ data, originalDoc, operation, req }) => {
          await needTransaction(req, s)
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
            // Notes are for staff. Someone who isn't an Owner or Manager of the group can't set them, even if the host lets them invite.
            if ('notes' in data && signedIn(req, s)) {
              let staff = false
              try {
                const r = await roleIn(req, group.id)
                staff = r === 'owner' || r === 'manager'
              } catch {
                staff = false
              }
              if (!staff) delete data.notes
            }
            data.group = group.id
            data.member = ref
            data.status = founding ? 'active' : 'invited'
            data.acceptedAt = founding ? now : null
            data.removedAt = null
            data.removedBy = null
            data.invitedBy = asker
            // The veto is not asked when someone invites: an inviter could learn from the answer who it refuses (a minor, say). It is asked
            // when the member accepts, where the answer goes to that person. Server code and a group's founding Owner are still asked here.
            // An organization founding a group, or joining by a signed-in person's hand, is never refused for a person behind it: that
            // person is left out of it instead, so the acting adult sees the same result whoever is behind the organization.
            data.vetoedPeople = []
            if (founding || !signedIn(req, s)) data.vetoedPeople = await vetoed(req, group, ref, data.level, 'invite', !!signedIn(req, s))
            const dup = await req.payload.find({
              collection: MEMBERS as never,
              where: { and: [{ group: { equals: group.id } }, { 'member.relationTo': { equals: ref.relationTo } }, { 'member.value': { equals: ref.value } }, { status: { in: LIVE } }] },
              limit: 1,
              pagination: false, // only the rows are used; see keepAnOwner
              depth: 0,
              overrideAccess: true,
              req,
            })
            if (dup.docs.length) {
              // Say "already in this group" only to someone who can read that row. To anyone else a hidden invited row looks the same
              // for every person, so the answer can't tell a minor from an adult.
              let visible = !signedIn(req, s)
              if (!visible) {
                const seen = await req.payload
                  .find({ collection: MEMBERS as never, where: { id: { equals: (dup.docs[0] as { id: unknown }).id } } as never, limit: 1, pagination: false, depth: 0, overrideAccess: false, req })
                  .catch(() => null)
                visible = !!seen?.docs.length
              }
              throw refuse(visible ? 'That member is already in this group.' : GENERAL)
            }
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
          for (const f of ['liveKey', 'acceptedAt', 'removedAt', 'removedBy', 'vetoedPeople']) delete data[f]
          // A signed-in person who isn't an Owner or Manager of the group can't write notes: not on their own row when they accept
          // or leave, and not on an organization's row they act for. Server code can.
          if ('notes' in data && signedIn(req, s)) {
            let staff = false
            try {
              const r = await roleIn(req, before.group)
              staff = r === 'owner' || r === 'manager'
            } catch {
              staff = false
            }
            if (!staff) delete data.notes
          }
          const level: string = data.level ?? before.level
          const status = (data.status ?? before.status) as MemberStatus
          if (!roleOf(s, level)) throw refuse('Unknown level.')
          if (!['invited', 'active', 'removed'].includes(status)) throw refuse('Unknown status.')
          const levelChanged = level !== before.level
          const statusChanged = status !== before.status
          if (!levelChanged && !statusChanged) return data
          if (before.status === 'removed') throw refuse('A removed member is final. Invite them again.')
          if (status === 'removed' && levelChanged) throw refuse('Change the level and remove in separate steps.')
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
            data.vetoedPeople = await vetoed(req, group, before.member, level, 'accept', !!signedIn(req, s))
            await run(opts.audit?.beforeAccept, { event: 'accept', phase: 'before', membership: after, previous: before, by: asker, req }, true)
          }
          if (levelChanged) {
            // A signed-in person changing someone's level isn't told why the veto refused: it would answer for any account. On an
            // invited row the veto isn't asked at all, and acceptance decides. Server code still sees the reason.
            if (!signedIn(req, s)) await vetoed(req, group, before.member, level, 'change-level')
            else if (before.status === 'active') {
              // Quiet: a person behind an organization who is newly refused is left out, and the change goes ahead, so the Owner
              // gets the same answer whoever is behind it. Only a refusal of the member itself (or a broken peopleOf) is the plain 403.
              try {
                const now = await vetoed(req, group, before.member, level, 'change-level', true)
                const kept = Array.isArray(originalDoc.vetoedPeople) ? (originalDoc.vetoedPeople as unknown[]).map(String) : []
                const all = [...new Set([...kept, ...now])]
                if (all.length !== kept.length) data.vetoedPeople = all
              } catch {
                throw new Forbidden(req.t)
              }
            }
            await run(opts.audit?.beforeChangeLevel, { event: 'change-level', phase: 'before', membership: after, previous: before, by: asker, req }, true)
          }
          return data
        },
      ],
      afterChange: [
        async ({ doc, previousDoc, operation, req }) => {
          const membership = normalize(doc)
          const asker = by(req)
          // The history row is written in the same transaction, so a change without its record is rolled back.
          const note = async (event: string, previous?: ShareMember) => {
            const ref = membership.member
            await req.payload.create({
              collection: EVENTS as never,
              data: {
                group: membership.group,
                membership: doc.id,
                memberType: ref.relationTo,
                memberId: String(ref.value),
                event,
                level: membership.level,
                previousLevel: previous?.level ?? null,
                status: membership.status,
                previousStatus: previous?.status ?? null,
                by: asker,
              } as never,
              overrideAccess: true,
              req,
            })
          }
          if (operation === 'create') {
            await note('invite')
            await run(opts.audit?.afterInvite, { event: 'invite', phase: 'after', membership, by: asker, req }, false)
            return doc
          }
          if (!previousDoc) return doc
          const previous = normalize(previousDoc)
          if (previous.status !== membership.status) {
            await note(membership.status === 'removed' ? 'remove' : 'accept', previous)
            if (membership.status === 'removed') await run(opts.audit?.afterRemove, { event: 'remove', phase: 'after', membership, previous, by: asker, req }, false)
            else if (membership.status === 'active') await run(opts.audit?.afterAccept, { event: 'accept', phase: 'after', membership, previous, by: asker, req }, false)
          }
          if (previous.level !== membership.level && membership.status !== 'removed') {
            await note('change-level', previous)
            await run(opts.audit?.afterChangeLevel, { event: 'change-level', phase: 'after', membership, previous, by: asker, req }, false)
          }
          return doc
        },
      ],
    },
  }
}

export type { Role }

/** The append-only history: one row per invitation, acceptance, level change and removal. Never edited, never deleted. */
export function eventsCollection(s: ResolvedSharing, opts: SharingOptions): CollectionConfig {
  const stop = (what: string) => () => {
    throw refuse(`The history can’t be ${what}.`)
  }
  return {
    slug: EVENTS,
    labels: { singular: 'Share member event', plural: 'Share member events' },
    admin: { group: opts.adminGroup ?? 'Sharing', defaultColumns: ['group', 'event', 'memberType', 'memberId', 'createdAt'], description: 'What changed in each group’s membership, and who changed it. Append-only.' },
    access: {
      create: () => false,
      update: () => false,
      delete: () => false,
      read: async ({ req }) => {
        try {
          if (!signedIn(req, s)) return false
          const owned = await groupIdsFor(req, 'own')
          return owned.length ? { group: { in: owned } } : false
        } catch {
          return false
        }
      },
    },
    fields: [
      { name: 'group', type: 'relationship', relationTo: GROUPS, required: true, index: true },
      { name: 'membership', type: 'relationship', relationTo: MEMBERS, required: true, index: true },
      { name: 'memberType', type: 'text', required: true },
      { name: 'memberId', type: 'text', required: true },
      { name: 'event', type: 'select', required: true, options: ['invite', 'accept', 'change-level', 'remove'] },
      { name: 'level', type: 'text' },
      { name: 'previousLevel', type: 'text' },
      { name: 'status', type: 'text' },
      { name: 'previousStatus', type: 'text' },
      { name: 'by', type: 'relationship', relationTo: s.users },
    ],
    hooks: { beforeDelete: [stop('deleted')], beforeChange: [({ operation, data }) => { if (operation !== 'create') throw refuse('The history can’t be edited.'); return data }] },
  }
}
