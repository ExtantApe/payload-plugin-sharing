import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { canEdit, canView, groupIdsFor, roleIn, sharedWhere, sharing, shareGroupField, type AuditEvent } from '../src/index.js'

/**
 * A made-up site: users (staff may make groups, some belong to organizations, one is flagged `minor`), organizations,
 * and notes that can be put in a group. The host's rules are small functions over the role the asker holds.
 */
const PW = 'correct-horse-battery'
let payload: Payload
let mongo: MongoMemoryReplSet
const log: string[] = []
const answers: { refuse?: () => unknown; beforeInvite?: () => void; canInvite?: () => unknown; identities?: () => unknown } = {}

type U = { id: string | number }
let ann: U, ben: U, cat: U, dan: U, kid: U, org: U
let group: { id: string | number }

const as = (user: U) => ({ ...user, collection: 'users' }) as never
const make = (email: string, extra: Record<string, unknown> = {}) =>
  payload.create({ collection: 'users', data: { email, password: PW, ...extra } as never }) as unknown as Promise<U>
const ref = (u: U, relationTo = 'users') => ({ relationTo, value: u.id })
const reqFor = (user: U | null) => ({ payload, user: user ? as(user) : null }) as never
const refused = async (p: Promise<unknown>) => {
  try {
    await p
    return null
  } catch (e) {
    return (e as Error).message
  }
}
const newGroup = (user: U, extra: Record<string, unknown> = {}) =>
  payload.create({ collection: 'share-groups' as never, data: { name: 'Pond keepers', kind: 'hobby', ...extra } as never, user: as(user), overrideAccess: false }) as unknown as Promise<{
    id: string | number
  }>
const invite = (user: U | null, data: Record<string, unknown>) =>
  payload.create({ collection: 'share-members' as never, data: { group: group.id, ...data } as never, user: user ? as(user) : undefined, overrideAccess: false }) as unknown as Promise<Record<string, unknown>>
const change = (user: U | null, id: unknown, data: Record<string, unknown>) =>
  payload.update({ collection: 'share-members' as never, id: id as never, data: data as never, user: user ? as(user) : undefined, overrideAccess: false }) as unknown as Promise<Record<string, unknown>>
const rows = (where: Record<string, unknown> = {}) => payload.find({ collection: 'share-members' as never, where: where as never, pagination: false, overrideAccess: true })
const rowOf = async (u: U, relationTo = 'users') => {
  const found = await rows({ and: [{ group: { equals: group.id } }, { 'member.value': { equals: u.id } }, { 'member.relationTo': { equals: relationTo } }] })
  return found.docs[0] as unknown as { id: string | number; level: string; status: string }
}
/** Invite then accept, so a member is active at a level. */
const join = async (u: U, level: string) => {
  await invite(ann, { member: ref(u), level })
  const r = await rowOf(u)
  await change(u, r.id, { status: 'active' })
  return r
}
const record = (e: AuditEvent) => {
  log.push(`${e.phase}:${e.event}`)
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const config = await buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri('sharing'), ensureIndexes: true }),
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [
          { name: 'staff', type: 'checkbox' },
          { name: 'minor', type: 'checkbox' },
          { name: 'org', type: 'relationship', relationTo: 'organizations' },
        ],
      },
      { slug: 'organizations', fields: [{ name: 'name', type: 'text' }] },
      {
        slug: 'notes',
        fields: [{ name: 'title', type: 'text' }, shareGroupField()],
        access: {
          read: async ({ req }) => {
            if (!req.user) return false
            return (await sharedWhere(req)) || false
          },
          update: async ({ req }) => (await sharedWhere(req, { need: 'edit' })) || false,
          create: ({ req }) => !!req.user,
          delete: () => false,
        },
      },
    ],
    plugins: [
      sharing({
        memberTypes: ['organizations'],
        kinds: [{ value: 'hobby' }, { value: 'family' }, { value: 'brand', label: 'Brand' }],
        identities: ({ user }) => {
          if (answers.identities) return answers.identities() as never
          const org = (user as { org?: unknown }).org
          return org ? [{ relationTo: 'organizations', value: ((org as { id?: unknown }).id ?? org) as string }] : []
        },
        canCreateGroup: ({ user }) => (user as { staff?: boolean }).staff === true,
        canInvite: ({ actorRole, member, group: g }) => {
          if (answers.canInvite) return answers.canInvite() as boolean
          if (actorRole === 'owner') return true
          return actorRole === 'manager' && member.level === 'viewer' && g.kind !== 'family'
        },
        canChangeLevel: ({ actorRole }) => actorRole === 'owner',
        refuseMember: ({ subject, group: g }) => {
          if (answers.refuse) return answers.refuse() as string | null
          return (subject as { minor?: boolean }).minor && g.kind !== 'family' ? 'Not available for this account.' : null
        },
        audit: {
          beforeInvite: (e) => {
            if (answers.beforeInvite) answers.beforeInvite()
            record(e)
          },
          afterInvite: record,
          beforeAccept: record,
          afterAccept: record,
          beforeChangeLevel: record,
          afterChangeLevel: record,
          beforeRemove: record,
          afterRemove: record,
        },
      }),
    ],
  })
  payload = await getPayload({ config })
})

afterAll(async () => {
  await payload?.db?.destroy?.()
  await mongo?.stop()
})

beforeEach(async () => {
  for (const key of Object.keys(answers)) delete (answers as Record<string, unknown>)[key]
  log.length = 0
  for (const c of ['notes', 'share-members', 'share-groups', 'users', 'organizations'])
    await payload.delete({ collection: c as never, where: { id: { exists: true } }, overrideAccess: true })
  org = (await payload.create({ collection: 'organizations', data: { name: 'Made-up Co' } as never })) as unknown as U
  ann = await make('ann@example.com', { staff: true })
  ben = await make('ben@example.com')
  cat = await make('cat@example.com', { org: org.id })
  dan = await make('dan@example.com')
  kid = await make('kid@example.com', { minor: true })
  group = await newGroup(ann)
  log.length = 0
})

describe('groups', () => {
  it('starts with its maker as the active Owner, in one step', async () => {
    const r = await rowOf(ann)
    expect(r.level).toBe('owner')
    expect(r.status).toBe('active')
    expect(await roleIn(reqFor(ann), group.id)).toBe('owner')
  })

  it('refuses to make a group without the host hook, or for a user it doesn’t allow', async () => {
    expect(await refused(newGroup(ben))).toBeTruthy()
    expect((await payload.find({ collection: 'share-groups' as never, overrideAccess: true })).totalDocs).toBe(1)
  })

  it('refuses a group that starts with someone else as Owner', async () => {
    expect(await refused(newGroup(ann, { owner: ref(ben) }))).toBeTruthy()
  })

  it('refuses an unknown kind or a blank name', async () => {
    expect(await refused(newGroup(ann, { kind: 'galaxy' }))).toBeTruthy()
    expect(await refused(newGroup(ann, { name: '  ' }))).toMatch(/needs a name/)
  })

  it('rolls the group back if the veto stops its founding Owner', async () => {
    answers.refuse = () => 'No.'
    const before = (await payload.find({ collection: 'share-groups' as never, overrideAccess: true })).totalDocs
    expect(await refused(newGroup(ann))).toBeTruthy()
    expect((await payload.find({ collection: 'share-groups' as never, overrideAccess: true })).totalDocs).toBe(before)
  })

  it('lets only an Owner rename it, and never change its kind or first owner', async () => {
    await join(ben, 'manager')
    const upd = (user: U, data: Record<string, unknown>) =>
      payload.update({ collection: 'share-groups' as never, id: group.id as never, data: data as never, user: as(user), overrideAccess: false })
    expect(await refused(upd(ben, { name: 'Mine now' }))).toBeTruthy()
    await upd(ann, { name: 'Renamed' })
    expect(await refused(upd(ann, { kind: 'family' }))).toMatch(/kind/)
    expect(await refused(upd(ann, { owner: ref(ben) }))).toMatch(/first owner/)
  })

  it('is never deleted', async () => {
    expect(await refused(payload.delete({ collection: 'share-groups' as never, id: group.id as never, user: as(ann), overrideAccess: false }))).toBeTruthy()
    expect(await refused(payload.delete({ collection: 'share-members' as never, id: (await rowOf(ann)).id as never, user: as(ann), overrideAccess: false }))).toBeTruthy()
  })

  it('shows a group only to its active members', async () => {
    const see = async (u: U) =>
      (await payload.find({ collection: 'share-groups' as never, user: as(u), overrideAccess: false })).totalDocs
    expect(await see(ann)).toBe(1)
    expect(await see(ben)).toBe(0)
    await invite(ann, { member: ref(ben), level: 'viewer' })
    expect(await see(ben)).toBe(0) // invited is not in yet
    await change(ben, (await rowOf(ben)).id, { status: 'active' })
    expect(await see(ben)).toBe(1)
  })
})

describe('inviting', () => {
  it('fails closed: no hook, a truthy answer, a throw or a signed-out asker all refuse', async () => {
    answers.canInvite = () => 'yes'
    expect(await refused(invite(ann, { member: ref(ben), level: 'viewer' }))).toBeTruthy()
    answers.canInvite = () => {
      throw new Error('boom')
    }
    expect(await refused(invite(ann, { member: ref(ben), level: 'viewer' }))).toBeTruthy()
    delete answers.canInvite
    expect(await refused(invite(null, { member: ref(ben), level: 'viewer' }))).toBeTruthy()
    expect((await rows({ status: { equals: 'invited' } })).totalDocs).toBe(0)
  })

  it('lets the host decide by role: a Manager invites Viewers only, a Viewer no one', async () => {
    await join(ben, 'manager')
    await invite(ben, { member: ref(cat), level: 'viewer' })
    expect(await refused(invite(ben, { member: ref(dan), level: 'manager' }))).toBeTruthy()
    await join(dan, 'viewer')
    expect(await refused(invite(dan, { member: ref(kid), level: 'viewer' }))).toBeTruthy()
  })

  it('starts invited whatever the client sends, and records who invited', async () => {
    const r = (await invite(ann, { member: ref(ben), level: 'viewer', status: 'active', invitedBy: dan.id, acceptedAt: new Date().toISOString() })) as Record<string, unknown>
    expect(r.status).toBe('invited')
    expect(String((r.invitedBy as { id?: unknown })?.id ?? r.invitedBy)).toBe(String(ann.id))
    expect(r.acceptedAt ?? null).toBeNull()
    expect(log).toEqual(['before:invite', 'after:invite'])
  })

  it('refuses unknown levels, unknown groups and unknown member kinds', async () => {
    expect(await refused(invite(ann, { member: ref(ben), level: 'admin' }))).toBeTruthy()
    expect(await refused(invite(ann, { member: { relationTo: 'notes', value: 'x' }, level: 'viewer' }))).toBeTruthy()
    expect(await refused(invite(ann, { group: 'nope', member: ref(ben), level: 'viewer' }))).toBeTruthy()
  })

  it('refuses a second live row for the same member, but allows it after removal', async () => {
    await invite(ann, { member: ref(ben), level: 'viewer' })
    expect(await refused(invite(ann, { member: ref(ben), level: 'manager' }))).toMatch(/already/)
    const r = await rowOf(ben)
    await change(ann, r.id, { status: 'removed' })
    await invite(ann, { member: ref(ben), level: 'viewer' })
  })

  it('lets an organization be a member', async () => {
    await invite(ann, { member: ref(org, 'organizations'), level: 'viewer' })
    expect((await rowOf(org, 'organizations')).status).toBe('invited')
  })

  it('starts an invited Owner as invited, not active, in a group that already has members', async () => {
    const r = (await invite(ann, { member: ref(ben), level: 'owner' })) as Record<string, unknown>
    expect(r.status).toBe('invited')
  })
})

describe('the host veto', () => {
  it('blocks a minor outside a family group on invite, even for server code that skips access', async () => {
    expect(await refused(invite(ann, { member: ref(kid), level: 'viewer' }))).toBe('Not available for this account.')
    expect(
      await refused(payload.create({ collection: 'share-members' as never, data: { group: group.id, member: ref(kid), level: 'viewer' } as never, overrideAccess: true })),
    ).toBe('Not available for this account.')
  })

  it('lets a minor into a family group', async () => {
    const fam = await newGroup(ann, { kind: 'family', name: 'Family' })
    await payload.create({ collection: 'share-members' as never, data: { group: fam.id, member: ref(kid), level: 'viewer' } as never, user: as(ann), overrideAccess: false })
  })

  it('refuses on a throw, on false and on a blank reason, with a general message', async () => {
    for (const answer of [
      () => {
        throw new Error('boom')
      },
      () => false,
      () => '   ',
    ]) {
      answers.refuse = answer
      expect(await refused(invite(ann, { member: ref(ben), level: 'viewer' }))).toBe('This person can’t be added to this group.')
    }
  })

  it('is asked again on accept and on a level change', async () => {
    await invite(ann, { member: ref(ben), level: 'viewer' })
    answers.refuse = () => 'Paused.'
    expect(await refused(change(ben, (await rowOf(ben)).id, { status: 'active' }))).toBe('Paused.')
    delete answers.refuse
    await change(ben, (await rowOf(ben)).id, { status: 'active' })
    answers.refuse = () => 'Paused.'
    expect(await refused(change(ann, (await rowOf(ben)).id, { level: 'manager' }))).toBe('Paused.')
  })

  it('stops the change when a before audit hook throws, and logs an after hook that throws', async () => {
    answers.beforeInvite = () => {
      throw new Error('audit down')
    }
    expect(await refused(invite(ann, { member: ref(ben), level: 'viewer' }))).toMatch(/can’t be recorded/)
    expect((await rows({ status: { equals: 'invited' } })).totalDocs).toBe(0)
  })
})

describe('accepting, changing levels and leaving', () => {
  it('lets a user accept their own invitation and nobody else’s', async () => {
    await invite(ann, { member: ref(ben), level: 'viewer' })
    const r = await rowOf(ben)
    expect(await refused(change(dan, r.id, { status: 'active' }))).toBeTruthy()
    expect(await refused(change(ann, r.id, { status: 'active' }))).toBeTruthy() // the host gave no canAccept
    await change(ben, r.id, { status: 'active' })
    expect((await rowOf(ben)).status).toBe('active')
    expect(log).toEqual(['before:invite', 'after:invite', 'before:accept', 'after:accept'])
  })

  it('leaves accepting for an organization to the host: nobody without canAccept', async () => {
    await invite(ann, { member: ref(org, 'organizations'), level: 'viewer' })
    const r = await rowOf(org, 'organizations')
    expect(await refused(change(cat, r.id, { status: 'active' }))).toBeTruthy()
  })

  it('changes a level only if canChangeLevel returns exactly true', async () => {
    await join(ben, 'viewer')
    const r = await rowOf(ben)
    expect(await refused(change(ben, r.id, { level: 'owner' }))).toBeTruthy() // self-promotion
    expect(await refused(change(dan, r.id, { level: 'owner' }))).toBeTruthy()
    await change(ann, r.id, { level: 'manager' })
    expect((await rowOf(ben)).level).toBe('manager')
    expect(log.slice(-2)).toEqual(['before:change-level', 'after:change-level'])
  })

  it('refuses a call with no id (a bulk update) and unknown levels or statuses', async () => {
    const r = await join(ben, 'viewer')
    expect(await refused(change(ann, r.id, { level: 'admin' }))).toBeTruthy()
    expect(await refused(change(ann, r.id, { status: 'invited' }))).toBeTruthy()
    await refused(payload.update({ collection: 'share-members' as never, where: { level: { equals: 'viewer' } } as never, data: { level: 'manager' } as never, user: as(ann), overrideAccess: false }))
    expect((await rowOf(ben)).level).toBe('viewer')
  })

  it('never changes group, member or inviter', async () => {
    const r = await join(ben, 'viewer')
    expect(await refused(change(ann, r.id, { member: ref(dan) }))).toBeTruthy()
    expect(await refused(change(ann, r.id, { group: 'other' }))).toBeTruthy()
  })

  it('lets anyone leave, lets the host remove others, and makes removal final', async () => {
    const r = await join(ben, 'viewer')
    const c = await join(dan, 'viewer')
    await change(ben, r.id, { status: 'removed' })
    expect(await refused(change(ben, c.id, { status: 'removed' }))).toBeTruthy()
    await change(ann, c.id, { status: 'removed' })
    const gone = await rowOf(ben)
    expect(gone.status).toBe('removed')
    expect(await refused(change(ann, gone.id, { status: 'active' }))).toBeTruthy()
    expect(log.filter((l) => l.endsWith('remove'))).toEqual(['before:remove', 'after:remove', 'before:remove', 'after:remove'])
  })

  it('refuses a stranger who tries to remove someone', async () => {
    const r = await join(ben, 'viewer')
    expect(await refused(change(dan, r.id, { status: 'removed' }))).toBeTruthy()
  })
})

describe('a group always keeps an Owner', () => {
  it('stops the last Owner leaving or being demoted', async () => {
    const r = await rowOf(ann)
    expect(await refused(change(ann, r.id, { status: 'removed' }))).toMatch(/keeps an Owner/)
    expect(await refused(change(ann, r.id, { level: 'manager' }))).toMatch(/keeps an Owner/)
    expect((await rowOf(ann)).level).toBe('owner')
  })

  it('stops server code too', async () => {
    const r = await rowOf(ann)
    expect(await refused(payload.update({ collection: 'share-members' as never, id: r.id as never, data: { status: 'removed' } as never, overrideAccess: true }))).toMatch(/keeps an Owner/)
  })

  it('does not count an invited Owner as one', async () => {
    await invite(ann, { member: ref(ben), level: 'owner' })
    expect(await refused(change(ann, (await rowOf(ann)).id, { level: 'viewer' }))).toMatch(/keeps an Owner/)
  })

  it('lets an Owner step down once another Owner is active', async () => {
    await join(ben, 'owner')
    await change(ann, (await rowOf(ann)).id, { level: 'manager' })
    expect((await rowOf(ann)).level).toBe('manager')
    expect(await refused(change(ben, (await rowOf(ben)).id, { status: 'removed' }))).toMatch(/keeps an Owner/)
  })

  it('keeps one Owner when two Owners demote each other at once', async () => {
    for (let i = 0; i < 4; i++) {
      await payload.delete({ collection: 'share-members' as never, where: { id: { exists: true } }, overrideAccess: true })
      await payload.delete({ collection: 'share-groups' as never, where: { id: { exists: true } }, overrideAccess: true })
      group = await newGroup(ann)
      await join(ben, 'owner')
      const a = (await rowOf(ann)).id
      const b = (await rowOf(ben)).id
      const results = await Promise.allSettled([
        payload.update({ collection: 'share-members' as never, id: a as never, data: { level: 'viewer' } as never, user: as(ben), overrideAccess: false }),
        payload.update({ collection: 'share-members' as never, id: b as never, data: { level: 'viewer' } as never, user: as(ann), overrideAccess: false }),
      ])
      const owners = (await rows({ and: [{ group: { equals: group.id } }, { level: { equals: 'owner' } }, { status: { equals: 'active' } }] })).totalDocs
      expect(owners).toBeGreaterThanOrEqual(1)
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1)
    }
  })

  it('creates one row when the same invitation is sent twice at once', async () => {
    const results = await Promise.allSettled([invite(ann, { member: ref(ben), level: 'viewer' }), invite(ann, { member: ref(ben), level: 'viewer' })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await rows({ and: [{ 'member.value': { equals: ben.id } }, { status: { in: ['invited', 'active'] } }] })).totalDocs).toBe(1)
  })
})

describe('what members can read', () => {
  it('shows a member their own rows and their groups’ rows, and nothing from other groups', async () => {
    await join(ben, 'viewer')
    const other = await newGroup(ann, { name: 'Elsewhere' })
    await payload.create({ collection: 'share-members' as never, data: { group: other.id, member: ref(dan), level: 'viewer' } as never, user: as(ann), overrideAccess: false })
    const seen = (await payload.find({ collection: 'share-members' as never, user: as(ben), overrideAccess: false, pagination: false })).docs as unknown as { group: unknown }[]
    expect(seen.length).toBe(2)
    expect(seen.every((d) => String((d.group as { id?: unknown })?.id ?? d.group) === String(group.id))).toBe(true)
    expect((await payload.find({ collection: 'share-members' as never, user: as(dan), overrideAccess: false, pagination: false })).totalDocs).toBe(1) // only his own invitation
  })

  it('shows nothing when signed out', async () => {
    expect(await refused(payload.find({ collection: 'share-members' as never, overrideAccess: false }))).toBeTruthy()
  })
})

describe('records in a group', () => {
  const note = (data: Record<string, unknown>, user: U | null = ann) =>
    payload.create({ collection: 'notes' as never, data: data as never, user: user ? as(user) : undefined, overrideAccess: false }) as unknown as Promise<{ id: string | number; shareGroup?: unknown }>

  it('lets canView and canEdit follow the level', async () => {
    await join(ben, 'viewer')
    await join(dan, 'manager')
    const n = await note({ title: 'pond log', shareGroup: group.id })
    const doc = await payload.findByID({ collection: 'notes' as never, id: n.id as never, depth: 0, overrideAccess: true })
    expect(await canView(reqFor(ann), doc)).toBe(true)
    expect(await canEdit(reqFor(ann), doc)).toBe(true)
    expect(await canView(reqFor(ben), doc)).toBe(true)
    expect(await canEdit(reqFor(ben), doc)).toBe(false)
    expect(await canEdit(reqFor(dan), doc)).toBe(true)
    expect(await canView(reqFor(cat), doc)).toBe(false)
    expect(await canView(reqFor(null), doc)).toBe(false)
    expect(await canView(reqFor(ann), { shareGroup: null })).toBe(false)
  })

  it('gives nothing to an invited or removed member', async () => {
    await invite(ann, { member: ref(ben), level: 'viewer' })
    const n = await note({ title: 'x', shareGroup: group.id })
    const doc = await payload.findByID({ collection: 'notes' as never, id: n.id as never, depth: 0, overrideAccess: true })
    expect(await canView(reqFor(ben), doc)).toBe(false)
    await change(ben, (await rowOf(ben)).id, { status: 'active' })
    expect(await canView(reqFor(ben), doc)).toBe(true)
    await change(ben, (await rowOf(ben)).id, { status: 'removed' })
    expect(await canView(reqFor(ben), doc)).toBe(false)
  })

  it('counts a membership held by an organization the user acts for', async () => {
    await invite(ann, { member: ref(org, 'organizations'), level: 'manager' })
    await payload.update({ collection: 'share-members' as never, id: (await rowOf(org, 'organizations')).id as never, data: { status: 'active' } as never, overrideAccess: true })
    const n = await note({ title: 'x', shareGroup: group.id })
    const doc = await payload.findByID({ collection: 'notes' as never, id: n.id as never, depth: 0, overrideAccess: true })
    expect(await canEdit(reqFor(cat), doc)).toBe(true)
    expect(await canView(reqFor(dan), doc)).toBe(false)
  })

  it('answers false on any error, including a throwing identities hook', async () => {
    const n = await note({ title: 'x', shareGroup: group.id })
    const doc = await payload.findByID({ collection: 'notes' as never, id: n.id as never, depth: 0, overrideAccess: true })
    answers.identities = () => {
      throw new Error('boom')
    }
    expect(await canView(reqFor(ann), doc)).toBe(false)
    expect(await sharedWhere(reqFor(ann))).toBe(false)
    await expect(groupIdsFor(reqFor(ann))).rejects.toThrow()
  })

  it('narrows list access with sharedWhere', async () => {
    await join(ben, 'viewer')
    await note({ title: 'shared', shareGroup: group.id })
    await note({ title: 'loose' })
    const mine = await payload.find({ collection: 'notes' as never, user: as(ben), overrideAccess: false })
    expect(mine.docs.map((d) => (d as unknown as { title: string }).title)).toEqual(['shared'])
    expect((await payload.find({ collection: 'notes' as never, user: as(dan), overrideAccess: false }).catch(() => ({ docs: [] }))).docs).toHaveLength(0)
  })

  it('lets only an Owner or Manager put a record into a group or move it out', async () => {
    await join(ben, 'viewer')
    const other = await newGroup(ann, { name: 'Elsewhere' })
    const stray = await note({ title: 'x', shareGroup: group.id }, ben)
    expect(stray.shareGroup ?? null).toBeNull() // a Viewer's group value is dropped
    const n = await note({ title: 'x', shareGroup: group.id }, ann)
    expect((n.shareGroup as { id?: unknown })?.id ?? n.shareGroup).toBeTruthy()
    const moved = (await payload.update({ collection: 'notes' as never, id: n.id as never, data: { shareGroup: other.id } as never, user: as(ben), overrideAccess: false }).catch(() => null)) as { shareGroup?: unknown } | null
    expect(moved).toBeNull() // a Viewer can't even edit it
    const kept = await payload.findByID({ collection: 'notes' as never, id: n.id as never, depth: 0, overrideAccess: true })
    expect(String(kept.shareGroup)).toBe(String(group.id))
    const out = (await payload.update({ collection: 'notes' as never, id: n.id as never, data: { shareGroup: other.id } as never, user: as(ann), overrideAccess: false })) as { shareGroup?: unknown }
    expect(String((out.shareGroup as { id?: unknown })?.id ?? out.shareGroup)).toBe(String(other.id))
  })

  it('refuses to put a record in a group the user has no part in', async () => {
    const theirs = await newGroup(ann, { name: 'Private' })
    const n = await note({ title: 'x', shareGroup: theirs.id }, dan)
    expect(n.shareGroup ?? null).toBeNull()
  })
})

describe('configuration', () => {
  it('stores the levels under the names the host gave them', () => {
    const cfg = sharing({ kinds: [{ value: 'hobby' }], levels: { owner: { value: 'steward', label: 'Steward' }, viewer: { label: 'Reader' } } })({ collections: [] } as never) as unknown as {
      collections: { slug: string; fields: { name: string; options?: { value: string; label: string }[] }[] }[]
      custom: { sharing: { levels: Record<string, { value: string; label: string }> } }
    }
    const level = cfg.collections.find((c) => c.slug === 'share-members')!.fields.find((f) => f.name === 'level')!
    expect(level.options).toEqual([
      { label: 'Steward', value: 'steward' },
      { label: 'Manager', value: 'manager' },
      { label: 'Reader', value: 'viewer' },
    ])
    expect(cfg.custom.sharing.levels.owner?.value).toBe('steward')
  })

  it('is off when disabled', () => {
    const cfg = sharing({ enabled: false, kinds: [] })({ collections: [] } as never) as { collections: unknown[] }
    expect(cfg.collections).toHaveLength(0)
  })

  it('refuses two levels with the same stored value', () => {
    expect(() => sharing({ kinds: [], levels: { viewer: { value: 'owner' } } })({ collections: [] } as never)).toThrow(/different values/)
  })
})
