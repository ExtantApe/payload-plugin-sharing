import { APIError, type Config, type Field, type PayloadRequest } from 'payload'

import { groupIdsFor, idOf } from './helpers.js'
import { GROUPS } from './types.js'

/** Marks the fields `shareGroupField` makes, so their placement can be checked. */
const MARK = 'sharingGroupField'

const refuse = (message: string) => new APIError(message, 403, undefined, true)
const ADVICE = 'Put it at the top level of a collection, or in a group or named tab, and don’t localize it or anything around it.'

type Node = { type?: string; name?: string; localized?: unknown; custom?: Record<string, unknown>; fields?: Node[]; tabs?: Node[]; blocks?: unknown[] }

/**
 * Every share group field under these fields, with where it is and whether changes to it can be checked there. They can't
 * inside an array or blocks, or where the field or anything around it is localized.
 */
function placements(fields: Node[], localization: boolean, path: string[] = [], safe = true): { field: Node; path: string; safe: boolean }[] {
  return fields.flatMap((f) => {
    const here = f.name ? [...path, f.name] : path
    const ok = safe && !(localization && f.localized)
    if (f.custom?.[MARK]) return [{ field: f, path: here.join('.'), safe: ok }]
    const under = f.type === 'array' || f.type === 'blocks' ? false : ok
    const blocks = (f.blocks ?? []).filter((b): b is Node => !!b && typeof b === 'object')
    return [
      ...placements(f.fields ?? [], localization, here, under),
      ...placements(f.tabs ?? [], localization, here, under),
      ...blocks.flatMap((b) => placements(b.fields ?? [], localization, here, false)),
    ]
  })
}

/** Throws if a share group field is anywhere its changes can't be checked. */
export function assertPlacements(config: Pick<Config, 'collections' | 'globals' | 'blocks' | 'localization'>): void {
  const localization = !!config.localization
  const roots = [
    ...[...(config.collections ?? []), ...(config.globals ?? [])].map((c) => ({ where: `"${c.slug}"`, fields: c.fields, safe: true })),
    ...(config.blocks ?? []).map((b) => ({ where: `the "${b.slug}" block`, fields: b.fields, safe: false })),
  ]
  for (const root of roots) {
    const bad = placements(root.fields as unknown as Node[], localization, [], root.safe).find((p) => !p.safe)
    if (bad) throw new Error(`payload-plugin-sharing: shareGroupField can’t be used at "${bad.path}" in ${root.where}, because a change of group couldn’t be checked there. ${ADVICE}`)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => Object.prototype.toString.call(v) === '[object Object]'

type HookArgs = {
  operation?: string
  value?: unknown
  previousValue?: unknown
  field: unknown
  path?: (string | number)[]
  data?: unknown
  siblingData?: unknown
  collection?: { fields: unknown } | null
  global?: { fields: unknown } | null
  req: PayloadRequest
}

/** Throws unless this write is one the field's access rule can judge. Runs for everyone, server code included. */
function assertCheckable({ field, path, data, siblingData, collection, global, req }: HookArgs) {
  // Only ordinary field names are accepted at the top level.
  if (data && typeof data === 'object' && Object.keys(data).some((k) => k.startsWith('$'))) throw refuse('A field name can’t start with $.')
  const fields = (collection ?? global)?.fields as Node[] | undefined
  const found = fields && placements(fields, !!req.payload.config.localization).find((p) => p.field === field)
  if (!found || !found.safe) throw refuse(`The share group can’t be checked where this field is, so nothing was saved. ${ADVICE}`)
  // Every group or tab around the field has to be a plain object.
  let at: unknown = data
  let plain = isObject(at)
  for (const part of (path ?? []).slice(0, -1)) {
    if (String(part).startsWith('_index-')) continue
    at = isObject(at) ? at[part] : undefined
    plain &&= isObject(at)
  }
  if (!plain || at !== siblingData) throw refuse('The fields around a share group have to be sent as objects, so nothing was saved.')
}

/** The group ids in a value of the field. Null means part of it couldn't be read. */
function groupIds(value: unknown): Set<string> | null {
  if (value === null || value === undefined) return new Set()
  const ids = (Array.isArray(value) ? value : [value]).map(idOf)
  return ids.every((id) => id !== null && id !== '') ? new Set(ids.map(String)) : null
}

/** Whether the user may take the field from `before` to `after`. Only an update can leave a record's groups as they are. */
async function mayChange(req: PayloadRequest, before: unknown, after: unknown, keeping: boolean): Promise<boolean> {
  try {
    const now = groupIds(before)
    const next = groupIds(after)
    if (!now || !next) return false
    const touched = [...new Set([...now, ...next])]
    if (!touched.length) return true
    if (keeping && now.size === next.size && touched.length === now.size) return true
    const mine = new Set((await groupIdsFor(req, 'edit')).map(String))
    return touched.every((g) => mine.has(g))
  } catch {
    return false
  }
}

/**
 * The field a host collection adds to put its records in a group. Setting or changing it needs Owner or Manager in every
 * group the record is in before and after. A change that isn't allowed is dropped, not applied. Restoring a version that
 * would make such a change is refused. On a create from a copied record, the copied record's groups count as "before",
 * and sending them unchanged still needs Owner or Manager.
 */
export function shareGroupField(options: { name?: string; hasMany?: boolean; label?: string } = {}): Field {
  const name = options.name ?? 'shareGroup'
  // What the field held before this write, from the hook to the access rule. Payload gives both the same object for the
  // fields beside this one, at any depth. Only the hook is told the earlier value at that depth.
  const earlier = new WeakMap<object, unknown>()
  type Args = { req: PayloadRequest; siblingData?: Record<string, unknown>; doc?: Record<string, unknown> }
  const allowed = async ({ req, siblingData, doc }: Args, keeping: boolean) => {
    // With no data being written, Payload is only asking what the admin screen should offer. Writes are judged below.
    if (!siblingData) return mayChange(req, doc?.[name], undefined, keeping)
    const known = earlier.has(siblingData)
    const before = earlier.get(siblingData)
    earlier.delete(siblingData)
    const ok = known && (await mayChange(req, before, siblingData[name], keeping))
    // On a restore, a change that isn't allowed refuses the whole restore.
    if (!ok && req.context?.isRestoringVersion) throw refuse('Restoring this version would change who it’s shared with, so it wasn’t restored.')
    return ok
  }
  return {
    name,
    type: 'relationship',
    relationTo: GROUPS,
    hasMany: options.hasMany ?? false,
    index: true,
    label: options.label ?? 'Shared with',
    custom: { [MARK]: true },
    hooks: {
      beforeValidate: [
        (args: HookArgs) => {
          assertCheckable(args)
          earlier.set(args.siblingData as object, args.previousValue)
          // On a create, a value Payload would carry over from a copied record is put in the data first, so the rule sees it.
          return args.operation === 'create' ? args.value : undefined
        },
      ] as never,
    },
    access: { create: ((a: Args) => allowed(a, false)) as never, update: ((a: Args) => allowed(a, true)) as never },
    admin: { description: 'The share group this record belongs to. Members of the group see it at their level.' },
  } as Field
}
