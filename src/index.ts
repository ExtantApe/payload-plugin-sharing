import type { Config, Plugin } from 'payload'

import { groupsCollection } from './groups.js'
import { eventsCollection, membersCollection } from './members.js'
import type { ResolvedSharing, Role, SharingOptions } from './types.js'

export {
  canEdit,
  canView,
  groupIdsFor,
  identitiesOf,
  membershipsOf,
  roleIn,
  shareGroupField,
  sharedWhere,
  type HelperOptions,
  type Membership,
} from './helpers.js'
export * from './types.js'

/**
 * Throws unless the database can run transactions. The last-Owner rule and the history rows depend on them. It opens a
 * transaction and rolls it straight back: an adapter set up without transactions (`transactionOptions: false` on the
 * MongoDB adapter) swaps `beginTransaction` for a function that returns nothing, which is how this notices.
 */
export async function assertTransactions(payload: unknown, options: { allowWithoutTransactions?: boolean } = {}): Promise<void> {
  if (options.allowWithoutTransactions === true) return
  const db = (payload as { db?: Record<string, any> }).db
  const fail = () => {
    throw new Error('payload-plugin-sharing needs a database with transactions (for MongoDB, a replica set). Without them the last-Owner rule and the history can’t be kept safe, so it refuses to start. Pass `allowWithoutTransactions: true` only if you accept that.')
  }
  if (!db || typeof db.beginTransaction !== 'function') return fail()
  let id: unknown
  try {
    id = await db.beginTransaction()
  } catch {
    return fail()
  }
  if (id === null || id === undefined || id === false) return fail()
  try {
    await db.rollbackTransaction?.(id)
  } catch {
    // The check already passed. A failed rollback of an empty transaction changes nothing.
  }
  const raw = db.connection?.db
  if (raw) {
    const hello = await raw.admin().command({ hello: 1 }).catch(() => null)
    if (!hello || (!hello.setName && hello.msg !== 'isdbgrid')) return fail()
  }
}

const DEFAULT_LEVELS: Record<Role, { value: string; label: string }> = {
  owner: { value: 'owner', label: 'Owner' },
  manager: { value: 'manager', label: 'Manager' },
  viewer: { value: 'viewer', label: 'Viewer' },
}

/**
 * Sharing for Payload. Two collections, `share-groups` and `share-members`: a group has members, each at a level.
 * The plugin knows nothing about the host's records or rules. The host adds `shareGroupField` to its collections, asks
 * `canView` and `canEdit` in its access functions, and decides who may invite and change levels. With no hooks, nobody can.
 */
export const sharing =
  (options: SharingOptions): Plugin =>
  (config: Config): Config => {
    if (options.enabled === false) return config
    if (typeof options.refuseMember !== 'function' && options.refuseMember !== false)
      throw new Error('payload-plugin-sharing: pass `refuseMember`, a function that vetoes a member, or `refuseMember: false` to say there is none')
    const extra = [...new Set(options.memberTypes ?? [])].filter((m) => m !== (options.users ?? config.admin?.user ?? 'users'))
    if (extra.length && options.refuseMember !== false && options.peopleOf === undefined)
      throw new Error('payload-plugin-sharing: with organizations as members, pass `peopleOf` so the veto runs for each person behind them, or `peopleOf: false` to say it does not')
    const users = options.users ?? config.admin?.user ?? 'users'
    const levels = { ...DEFAULT_LEVELS }
    for (const role of Object.keys(levels) as Role[]) {
      const given = options.levels?.[role]
      levels[role] = { value: given?.value ?? levels[role].value, label: given?.label ?? levels[role].label }
    }
    const values = Object.values(levels).map((l) => l.value)
    if (new Set(values).size !== values.length) throw new Error('payload-plugin-sharing: the three levels need different values')
    const resolved: ResolvedSharing = {
      users,
      memberTypes: [...new Set([users, ...(options.memberTypes ?? [])])],
      levels,
      kinds: options.kinds ?? [],
      identities: options.identities,
      peopleOf: options.peopleOf,
      needsTransactions: options.allowWithoutTransactions !== true,
    }
    const before = config.onInit
    return {
      ...config,
      custom: { ...config.custom, sharing: resolved },
      onInit: async (payload) => {
        await before?.(payload)
        await assertTransactions(payload, { allowWithoutTransactions: options.allowWithoutTransactions })
      },
      collections: [...(config.collections ?? []), groupsCollection(resolved, options), membersCollection(resolved, options), eventsCollection(resolved, options)],
    }
  }
