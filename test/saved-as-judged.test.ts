import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { configToSchema } from '@payloadcms/graphql'
import { graphql } from 'graphql'
import { buildConfig, createLocalReq, getPayload, handleEndpoints, type CollectionConfig, type Config, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { sharing, shareGroupField } from '../src/index.js'

/**
 * A made-up site with a second plugin after sharing. It turns Payload's duplicate switch back on, and it can change the
 * sharing records with a field default or a hook while they are being made.
 */
const PW = 'correct-horse-battery'
const SLUGS = ['share-groups', 'share-members', 'share-member-events']
let payload: Payload
let mongo: MongoMemoryReplSet
type Change = (data: Record<string, unknown>) => void
const tamper: { stage?: 'beforeValidate' | 'beforeChange'; slug?: string; change?: Change; ownerDefault?: unknown; fieldHook?: unknown } = {}

type U = { id: string }
let ann: U, ben: U, cat: U
let group: { id: string }
const as = (u: U) => ({ ...u, collection: 'users' }) as never
const ref = (u: U) => ({ relationTo: 'users', value: u.id })

const later = (config: Config): Config => ({
  ...config,
  collections: config.collections!.map((c): CollectionConfig => {
    if (!SLUGS.includes(c.slug)) return c
    const hook = (stage: 'beforeValidate' | 'beforeChange') => ({ data, operation }: { data?: Record<string, unknown>; operation?: string }) => {
      if (data && operation === 'create' && tamper.stage === stage && tamper.slug === c.slug) tamper.change!(data)
      return data
    }
    return {
      ...c,
      disableDuplicate: false,
      fields: c.fields.map((f) => {
        if (c.slug !== 'share-groups' || !('name' in f)) return f
        if (f.name === 'owner') return { ...f, defaultValue: () => tamper.ownerDefault } as typeof f
        if (f.name === 'kind') return { ...f, hooks: { beforeChange: [({ value }: { value?: unknown }) => tamper.fieldHook ?? value] } } as typeof f
        return f
      }),
      hooks: {
        ...c.hooks,
        beforeValidate: [...(c.hooks?.beforeValidate ?? []), hook('beforeValidate') as never],
        beforeChange: [...(c.hooks?.beforeChange ?? []), hook('beforeChange') as never],
      },
    }
  }),
})

const totals = async () => Promise.all(SLUGS.map(async (c) => (await payload.find({ collection: c as never, overrideAccess: true, pagination: false })).docs.length))
const answer = async (p: Promise<unknown>) => {
  const e = (await p.then(() => null, (err: unknown) => err)) as { status?: number; message?: string } | null
  return e ? `${e.status} ${e.message}` : null
}
const create = (collection: string, data: Record<string, unknown>) => payload.create({ collection: collection as never, data: data as never, user: as(ann), overrideAccess: false, depth: 0 }) as unknown as Promise<{ id: string }>
const NOT_JUDGED = '403 What would be saved isn’t what was checked, so it wasn’t made.'
const NO_COPY = '403 Sharing records can’t be duplicated.'

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const config = await buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri('judged'), ensureIndexes: true }),
    collections: [
      { slug: 'users', auth: true, fields: [] },
      // A host record with the field in a named group.
      { slug: 'files', fields: [{ name: 'meta', type: 'group', fields: [shareGroupField()] }], access: { read: () => true, create: () => true } },
    ],
    plugins: [sharing({ kinds: [{ value: 'hobby' }, { value: 'brand' }], canCreateGroup: () => true, canInvite: () => true, canChangeLevel: () => true, refuseMember: false }), later],
  })
  payload = await getPayload({ config })
})

afterAll(async () => {
  await payload?.db?.destroy?.()
  await mongo?.stop()
})

beforeEach(async () => {
  for (const k of Object.keys(tamper)) delete (tamper as Record<string, unknown>)[k]
  const db = payload.db as unknown as { collections: Record<string, { deleteMany: (f: object) => Promise<unknown> }> }
  for (const c of [...SLUGS, 'users', 'files']) await db.collections[c]!.deleteMany({})
  const make = (email: string) => payload.create({ collection: 'users', data: { email, password: PW } as never }) as unknown as Promise<U>
  ann = await make('ann@example.com')
  ben = await make('ben@example.com')
  cat = await make('cat@example.com')
  group = await create('share-groups', { name: 'Pond keepers', kind: 'hobby' })
})

describe('with Payload’s duplicate switch turned back on by a later plugin', () => {
  const sources = async (slug: string) => [
    String((await payload.find({ collection: slug as never, overrideAccess: true, depth: 0 })).docs[0]!.id),
    '0123456789abcdef01234567',
    'not-an-id',
  ]

  for (const slug of SLUGS) {
    it(`still refuses to duplicate ${slug} over REST, with one answer for any id`, async () => {
      const token = (await payload.login({ collection: 'users', data: { email: 'ann@example.com', password: PW } })).token
      const before = await totals()
      const seen = new Set<string>()
      for (const id of await sources(slug)) {
        const res = await handleEndpoints({
          config: payload.config,
          request: new Request(`http://localhost/api/${slug}/${id}/duplicate`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `JWT ${token}` }, body: '{}' }),
        })
        seen.add(`${res.status} ${await res.text()}`)
      }
      expect([...seen]).toHaveLength(1)
      expect([...seen][0]).toMatch(/^403 .*Sharing records can’t be duplicated/)
      expect(await totals()).toEqual(before)
    })

    it(`still refuses to duplicate ${slug} over GraphQL, with one answer for any id`, async () => {
      const before = await totals()
      const name = { 'share-groups': 'duplicateShareGroup', 'share-members': 'duplicateShareMember', 'share-member-events': 'duplicateShareMemberEvent' }[slug]!
      const { schema } = configToSchema(payload.config)
      // The mutation asks for the required fields, so each call sends some.
      const data = {
        'share-groups': 'name: "Copy", kind: hobby',
        'share-members': 'level: viewer, status: invited',
        'share-member-events': 'memberType: "users", memberId: "x", event: invite',
      }[slug]!
      expect(Object.keys(schema.getMutationType()!.getFields())).toContain(name)
      const seen = new Set<string>()
      for (const id of await sources(slug)) {
        const req = await createLocalReq({ user: as(ann) }, payload)
        req.payloadAPI = 'GraphQL'
        const res = (await graphql({ schema, source: `mutation { ${name}(id: "${id}", data: { ${data} }) { id } }`, contextValue: { req } })) as { errors?: { message: string }[] }
        seen.add(res.errors?.[0]?.message ?? 'made')
      }
      expect([...seen]).toEqual(['Sharing records can’t be duplicated.'])
      expect(await totals()).toEqual(before)
    })

    it(`still refuses a Local duplicate of ${slug}, server code included`, async () => {
      const before = await totals()
      for (const id of await sources(slug))
        expect(await answer(payload.duplicate({ collection: slug as never, id: id as never, overrideAccess: true }))).toBe(NO_COPY)
      expect(await totals()).toEqual(before)
    })
  }
})

describe('a create is saved as the access rules judged it, or not at all', () => {
  const groupData = () => ({ name: 'New group', kind: 'hobby' })
  const invitation = () => ({ group: group.id, member: ref(ben), level: 'viewer' })

  it('makes ordinary groups and invitations with the second plugin idle', async () => {
    const made = await create('share-groups', { name: '  Spaced  ', kind: 'brand' })
    await create('share-groups', { ...groupData(), owner: ref(ann) })
    await create('share-members', invitation())
    expect(((await payload.findByID({ collection: 'share-groups' as never, id: made.id as never, overrideAccess: true })) as unknown as { name: string }).name).toBe('Spaced')
    expect(await totals()).toEqual([3, 4, 4])
  })

  for (const stage of ['beforeValidate', 'beforeChange'] as const) {
    const cases: [string, string, Change][] = [
      ['share-groups', 'the kind', (d) => (d.kind = 'brand')],
      ['share-groups', 'the name', (d) => (d.name = 'Another name')],
      ['share-groups', 'the owner', (d) => (d.owner = ref(cat))],
      ['share-members', 'the member', (d) => (d.member = ref(cat))],
      ['share-members', 'the level', (d) => (d.level = 'owner')],
    ]
    for (const [slug, what, change] of cases) {
      it(`rolls back when a ${stage} hook changes ${what}`, async () => {
        const before = await totals()
        Object.assign(tamper, { stage, slug, change })
        const got = await answer(create(slug, slug === 'share-groups' ? { ...groupData(), owner: ref(ann) } : invitation()))
        expect(got).not.toBeNull()
        // The plugin's own checks may refuse first: a change made before them can fail one of those.
        expect(got).toMatch(/^403 /)
        expect(await totals()).toEqual(before)
      })
    }
  }

  it('rolls back when a field default fills in someone else as Owner', async () => {
    const before = await totals()
    tamper.ownerDefault = ref(cat)
    expect(await answer(create('share-groups', groupData()))).toBe(NOT_JUDGED)
    expect(await totals()).toEqual(before)
  })

  it('rolls back when a field hook changes the kind after the plugin’s own checks', async () => {
    const before = await totals()
    tamper.fieldHook = 'brand'
    expect(await answer(create('share-groups', groupData()))).toBe(NOT_JUDGED)
    expect(await totals()).toEqual(before)
  })

  it('rolls back when a hook makes an invitation active', async () => {
    const before = await totals()
    // The plugin sets the status in its own beforeChange, which this one runs after.
    Object.assign(tamper, { stage: 'beforeChange', slug: 'share-members', change: (d: Record<string, unknown>) => (d.status = 'active') })
    expect(await answer(create('share-members', invitation()))).toBe(NOT_JUDGED)
    expect(await totals()).toEqual(before)
  })

  it('rolls back over REST too', async () => {
    const token = (await payload.login({ collection: 'users', data: { email: 'ann@example.com', password: PW } })).token
    const before = await totals()
    tamper.fieldHook = 'brand'
    const res = await handleEndpoints({
      config: payload.config,
      request: new Request('http://localhost/api/share-groups', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `JWT ${token}` }, body: JSON.stringify(groupData()) }),
    })
    expect(res.status).toBe(403)
    expect(await totals()).toEqual(before)
  })
})

describe('the share group field inside a named group', () => {
  const groupOf = async (id: unknown) => ((await payload.findByID({ collection: 'files', id: id as never, depth: 0, overrideAccess: true })) as unknown as { meta?: { shareGroup?: unknown } }).meta?.shareGroup ?? null
  it('isn’t carried to a copy by someone outside the group, and is for its Owner and server code', async () => {
    const file = await payload.create({ collection: 'files', data: { meta: { shareGroup: group.id } } as never, overrideAccess: true })
    const copy = async (options: Record<string, unknown>) => groupOf((await payload.duplicate({ collection: 'files', id: file.id, ...options })).id)
    expect(await copy({ user: as(ben), overrideAccess: false })).toBeNull()
    expect(await copy({ user: as(ben), overrideAccess: false, data: { meta: { shareGroup: group.id } } })).toBeNull()
    expect(await copy({ user: as(ben), overrideAccess: false, data: { meta: {} } })).toBeNull()
    expect(await copy({ user: as(ann), overrideAccess: false })).toBe(group.id)
    expect(await copy({ overrideAccess: true })).toBe(group.id)
  })
})
