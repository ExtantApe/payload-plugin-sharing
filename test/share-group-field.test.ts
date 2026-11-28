import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Config, type Field, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { sharing, shareGroupField } from '../src/index.js'

/**
 * A made-up site whose records carry the share group field at every supported depth. The site's own access rules let any
 * signed-in user create, edit and restore records, so only the field decides who may change a record's groups.
 * Ann is the Owner of Reeds and Rushes. Ben is the Owner of Rushes only. Eve is the Owner of Elms only.
 */
const PW = 'correct-horse-battery'
let payload: Payload
let mongo: MongoMemoryReplSet

type U = { id: string }
let ann: U, ben: U, eve: U
let reeds: string, rushes: string, elms: string

type Doc = Record<string, unknown>
type Placement = { label: string; keys: string[]; many: boolean }
const PLACEMENTS: Placement[] = [
  { label: 'at the top level', keys: ['shareGroup'], many: false },
  { label: 'at the top level with hasMany', keys: ['circles'], many: true },
  { label: 'in a named group', keys: ['meta', 'shareGroup'], many: false },
  { label: 'in a named group with hasMany', keys: ['wide', 'shareGroup'], many: true },
  { label: 'in a named tab', keys: ['side', 'shareGroup'], many: false },
  { label: 'in a named tab with hasMany', keys: ['more', 'shareGroup'], many: true },
  { label: 'several levels down', keys: ['outer', 'inner', 'shareGroup'], many: false },
]
const NESTED = PLACEMENTS.filter((p) => p.keys.length > 1)

const fields: Field[] = [
  { name: 'title', type: 'text' },
  shareGroupField(),
  shareGroupField({ name: 'circles', hasMany: true }),
  { name: 'meta', type: 'group', fields: [{ name: 'note', type: 'text' }, shareGroupField()] },
  { name: 'wide', type: 'group', fields: [shareGroupField({ hasMany: true })] },
  { type: 'tabs', tabs: [{ name: 'side', fields: [shareGroupField()] }, { name: 'more', fields: [shareGroupField({ hasMany: true })] }] },
  { name: 'outer', type: 'group', fields: [{ type: 'collapsible', label: 'More', fields: [{ type: 'tabs', tabs: [{ label: 'Plain', fields: [{ type: 'row', fields: [{ name: 'inner', type: 'group', fields: [shareGroupField()] }] }] }] }] }] },
]

const wrap = (keys: string[], value: unknown): Doc => ({ [keys[0]!]: keys.length === 1 ? value : wrap(keys.slice(1), value) })
const read = (doc: unknown, keys: string[]): unknown => keys.reduce<unknown>((at, k) => (at as Doc | undefined)?.[k], doc)
const as = (u: U) => ({ ...u, collection: 'users' }) as never
/** What the database holds, as plain strings. */
const stored = async (id: string, keys: string[]) => {
  const row = await payload.db.findOne({ collection: 'records' as never, where: { id: { equals: id } } })
  const v = read(row, keys)
  if (Array.isArray(v)) return v.length ? v.map(String) : null
  return v ? String(v) : null
}
const seed = async (data: Doc) => String((await payload.create({ collection: 'records' as never, data: { title: 'Pond', _status: 'published', ...data } as never, overrideAccess: true, depth: 0 })).id)
const update = (user: U, id: string, data: Doc) => payload.update({ collection: 'records' as never, id: id as never, data: data as never, user: as(user), overrideAccess: false, depth: 0 })
const bulk = (user: U, id: string, data: Doc) =>
  payload.update({ collection: 'records' as never, where: { id: { equals: id } } as never, data: data as never, user: as(user), overrideAccess: false, depth: 0 }) as unknown as Promise<{ docs: unknown[]; errors: { message: string }[] }>
const message = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as Error).message)
const values = (p: Placement) => ({
  before: p.many ? [reeds, rushes] : reeds,
  kept: p.many ? [reeds, rushes] : reeds,
})

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const open = ({ req }: { req: { user: unknown } }) => !!req.user
  const config = await buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri('fields'), ensureIndexes: true }),
    collections: [
      { slug: 'users', auth: true, fields: [] },
      { slug: 'records', fields, versions: { drafts: true }, access: { read: open, create: open, update: open, readVersions: open } },
    ],
    plugins: [sharing({ kinds: [{ value: 'hobby' }], canCreateGroup: () => true, refuseMember: false })],
  })
  payload = await getPayload({ config })
})

afterAll(async () => {
  await payload?.db?.destroy?.()
  await mongo?.stop()
})

beforeEach(async () => {
  const db = payload.db as unknown as { collections: Record<string, { deleteMany: (f: object) => Promise<unknown> }>; versions: Record<string, { deleteMany: (f: object) => Promise<unknown> }> }
  for (const c of ['share-groups', 'share-members', 'share-member-events', 'users', 'records']) await db.collections[c]!.deleteMany({})
  await db.versions.records!.deleteMany({})
  const make = (email: string) => payload.create({ collection: 'users', data: { email, password: PW } as never }) as unknown as Promise<U>
  ann = await make('ann@example.com')
  ben = await make('ben@example.com')
  eve = await make('eve@example.com')
  const group = async (u: U, name: string) =>
    String(((await payload.create({ collection: 'share-groups' as never, data: { name, kind: 'hobby' } as never, user: as(u), overrideAccess: false })) as { id: string }).id)
  reeds = await group(ann, 'Reeds')
  rushes = await group(ben, 'Rushes')
  elms = await group(eve, 'Elms')
  // Ann is also an Owner of Rushes.
  const second = (await payload.create({ collection: 'share-members' as never, data: { group: rushes, member: { relationTo: 'users', value: ann.id }, level: 'owner' } as never, overrideAccess: true })) as { id: string }
  await payload.update({ collection: 'share-members' as never, id: second.id as never, data: { status: 'active' } as never, overrideAccess: true })
})

for (const p of PLACEMENTS) {
  describe(`the share group field ${p.label}`, () => {
    const one = (g: string) => (p.many ? [g] : g)

    it('keeps its earlier value when someone without a role there sends another one, one record or in bulk', async () => {
      const { before, kept } = values(p)
      const id = await seed(wrap(p.keys, before))
      const tries = [one(elms), null, p.many ? [] : '', ...(p.many ? [[reeds, rushes, elms]] : [])]
      for (const next of tries) {
        await update(eve, id, wrap(p.keys, next))
        expect(await stored(id, p.keys)).toEqual(kept)
        expect((await bulk(eve, id, wrap(p.keys, next))).errors).toEqual([])
        expect(await stored(id, p.keys)).toEqual(kept)
      }
    })

    it('stays the same on a partial update, or when the same value is sent back', async () => {
      const { before, kept } = values(p)
      const id = await seed(wrap(p.keys, before))
      for (const data of [{ title: 'Pond 2' }, wrap(p.keys, before), p.keys.length > 1 ? { [p.keys[0]!]: {} } : {}]) {
        await update(eve, id, data)
        expect(await stored(id, p.keys)).toEqual(kept)
      }
    })

    it('changes for someone who is an Owner in every group before and after', async () => {
      const id = await seed(wrap(p.keys, values(p).before))
      await update(ann, id, wrap(p.keys, one(rushes)))
      expect(await stored(id, p.keys)).toEqual(p.many ? [rushes] : rushes)
      await update(ann, id, wrap(p.keys, null))
      expect(await stored(id, p.keys)).toBeNull()
    })

    it('can’t be taken out of a group by someone who only has a role in the other one', async () => {
      const { before, kept } = values(p)
      const id = await seed(wrap(p.keys, before))
      const tries = p.many ? [[rushes], [rushes, rushes]] : [rushes]
      for (const next of tries) {
        await update(ben, id, wrap(p.keys, next))
        expect(await stored(id, p.keys)).toEqual(kept)
      }
    })

    it('puts a new record or a copy in a group only for an Owner or Manager there', async () => {
      const make = async (user: U) =>
        String((await payload.create({ collection: 'records' as never, data: { title: 'New', ...wrap(p.keys, one(reeds)) } as never, user: as(user), overrideAccess: false, depth: 0 })).id)
      expect(await stored(await make(eve), p.keys)).toBeNull()
      expect(await stored(await make(ann), p.keys)).toEqual(one(reeds))
      const source = await seed(wrap(p.keys, one(reeds)))
      const copy = async (user: U, data?: Doc) => String((await payload.duplicate({ collection: 'records' as never, id: source as never, data: data as never, user: as(user), overrideAccess: false })).id)
      for (const data of [undefined, wrap(p.keys, one(reeds)), wrap(p.keys, one(elms))]) expect(await stored(await copy(eve, data), p.keys)).toBeNull()
      expect(await stored(await copy(ann), p.keys)).toEqual(one(reeds))
    })

    for (const draft of [false, true]) {
      it(`refuses a ${draft ? 'draft ' : ''}restore that would change the groups without the role for it`, async () => {
        for (const [earlier, current] of [
          [one(reeds), one(elms)],
          [null, one(reeds)],
          [one(elms), null],
        ] as const) {
          // Eve has no role in Reeds. The last pair is hers to make, and is checked below.
          const id = await seed(wrap(p.keys, earlier))
          const version = (await payload.findVersions({ collection: 'records' as never, where: { parent: { equals: id } }, overrideAccess: true })).docs[0]!.id
          await payload.update({ collection: 'records' as never, id: id as never, data: { _status: 'published', ...wrap(p.keys, current) } as never, overrideAccess: true })
          const restore = () => payload.restoreVersion({ collection: 'records' as never, id: version as never, draft, user: as(eve), overrideAccess: false, depth: 0 })
          const latest = async () => payload.findByID({ collection: 'records' as never, id: id as never, draft: true, depth: 0, overrideAccess: true })
          const was = [await stored(id, p.keys), read(await latest(), p.keys) ?? null]
          if (earlier && current === null) {
            expect(await message(restore())).toBeNull()
          } else {
            expect(await message(restore())).toMatch(/wasn’t restored/)
            expect([await stored(id, p.keys), read(await latest(), p.keys) ?? null]).toEqual(was)
          }
        }
      })
    }
  })
}

describe('what is sent around a nested share group field', () => {
  for (const p of NESTED) {
    it(`refuses anything but objects around the field ${p.label}`, async () => {
      const id = await seed(wrap(p.keys, values(p).before))
      for (let depth = 1; depth < p.keys.length; depth++) {
        for (const odd of [[], [{}], null]) {
          const data = wrap(p.keys.slice(0, depth), odd)
          expect(await message(update(eve, id, data))).not.toBeNull()
          expect(await stored(id, p.keys)).toEqual(values(p).kept)
          // A bulk update may reshape the data before the field sees it, so only the stored outcome is checked.
          await bulk(eve, id, data).catch(() => null)
          expect(await stored(id, p.keys)).toEqual(values(p).kept)
        }
      }
    })
  }

  it('still answers what the admin screen may offer when nothing is being written', async () => {
    const field = (payload.collections as unknown as Record<string, { config: { fields: { name?: string; access?: { update?: (a: unknown) => Promise<boolean> } }[] } }>).records!.config.fields.find((f) => f.name === 'shareGroup')!
    const ask = (u: U, doc: Doc) => field.access!.update!({ req: { payload, user: as(u), context: {} }, doc, data: doc })
    expect(await ask(ann, { shareGroup: reeds })).toBe(true)
    expect(await ask(eve, { shareGroup: reeds })).toBe(false)
    expect(await ask(eve, {})).toBe(true)
  })
})

describe('top-level field names on a collection with the field', () => {
  const REFUSED = 'A field name can’t start with $.'
  // The rule goes by the first character, so made-up names stand for all of them.
  const bodies = (): Doc[] => [{ $example: 1 }, { $example: { title: 'x' } }, { '$example.title': 'x' }, { title: 'x', $other: null }]

  it('must be ordinary ones on an update, one record or in bulk, grouped or not', async () => {
    for (const start of [{}, { shareGroup: reeds }]) {
      const id = await seed(start)
      for (const data of bodies()) {
        expect(await message(update(eve, id, data))).toBe(REFUSED)
        const many = await bulk(eve, id, data)
        expect(many.docs).toEqual([])
        expect(many.errors.map((e) => e.message)).toEqual([REFUSED])
        expect(await stored(id, ['shareGroup'])).toBe(start.shareGroup ?? null)
        expect(await stored(id, ['title'])).toBe('Pond')
      }
    }
  })

  it('must be ordinary ones over REST, on a create, and for server code', async () => {
    const id = await seed({})
    const token = (await payload.login({ collection: 'users', data: { email: 'eve@example.com', password: PW } })).token
    for (const path of [`/records/${id}`, `/records?where[id][equals]=${id}`]) {
      const res = await handleEndpoints({
        config: payload.config,
        request: new Request(`http://localhost/api${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json', Authorization: `JWT ${token}` }, body: JSON.stringify({ $example: 1 }) }),
      })
      expect(await res.text()).toContain(REFUSED)
    }
    expect(await message(payload.create({ collection: 'records' as never, data: { title: 'x', $example: 1 } as never, user: as(eve), overrideAccess: false }))).toBe(REFUSED)
    expect(await message(payload.update({ collection: 'records' as never, id: id as never, data: { $example: 1 } as never, overrideAccess: true }))).toBe(REFUSED)
    expect(await stored(id, ['shareGroup'])).toBeNull()
  })
})

describe('where the field may be placed', () => {
  const options = { kinds: [{ value: 'hobby' }], refuseMember: false as const }
  const build = (f: Field[], extra: Record<string, unknown> = {}) => () => sharing(options)({ collections: [{ slug: 'things', fields: f }], ...extra } as unknown as Config)
  const localization = { locales: ['en', 'fr'], defaultLocale: 'en' }
  const inside: [string, Field[], Record<string, unknown>?][] = [
    ['an array', [{ name: 'rows', type: 'array', fields: [shareGroupField()] }]],
    ['a group in an array', [{ name: 'rows', type: 'array', fields: [{ name: 'meta', type: 'group', fields: [shareGroupField()] }] }]],
    ['blocks', [{ name: 'parts', type: 'blocks', blocks: [{ slug: 'part', fields: [shareGroupField()] }] }]],
    ['a shared block', [], { blocks: [{ slug: 'part', fields: [shareGroupField()] }] }],
    ['a global’s array', [], { globals: [{ slug: 'site', fields: [{ name: 'rows', type: 'array', fields: [shareGroupField()] }] }] }],
    ['a localized field', [{ ...shareGroupField(), localized: true } as Field], { localization }],
    ['a localized group', [{ name: 'meta', type: 'group', localized: true, fields: [shareGroupField()] }], { localization }],
    ['a localized tab', [{ type: 'tabs', tabs: [{ name: 'side', localized: true, fields: [shareGroupField()] }] }], { localization }],
  ]
  for (const [what, f, extra] of inside) {
    it(`refuses to start with the field in ${what}`, () => {
      expect(build(f, extra)).toThrow(/shareGroupField can’t be used/)
    })
  }

  it('starts with the field at the top, in groups and in tabs, and ignores localized flags without localization', () => {
    expect(build(fields)).not.toThrow()
    expect(build([{ ...shareGroupField(), localized: true } as Field])).not.toThrow()
  })

  it('checks the finished config again, for fields added after the plugin ran', async () => {
    const made = build([])() as Config
    const finished = { ...made, collections: [{ slug: 'late', fields: [{ name: 'rows', type: 'array', fields: [shareGroupField()] }] }] }
    await expect(Promise.resolve(made.onInit!({ config: finished } as never))).rejects.toThrow(/shareGroupField can’t be used/)
  })

  it('saves nothing through a field whose place it can’t check', () => {
    const field = shareGroupField() as unknown as { hooks: { beforeValidate: ((a: unknown) => unknown)[] } }
    const row = {}
    const args = { field, operation: 'update', path: ['rows', 0, 'shareGroup'], siblingData: row, data: { rows: [row] }, req: { payload: { config: {} } } }
    for (const collection of [{ fields: [{ name: 'rows', type: 'array', fields: [field] }] }, { fields: [] }, undefined])
      expect(() => field.hooks.beforeValidate[0]!({ ...args, collection })).toThrow(/can’t be checked/)
  })
})
