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

/** Throws unless the database can run transactions. The last-Owner rule and the history rows depend on them. */
export async function assertTransactions(payload: unknown): Promise<void> {
  const db = (payload as { db?: Record<string, any> }).db
  const fail = () => {
    throw new Error('payload-plugin-sharing needs a database with transactions (for MongoDB, a replica set). Without them the last-Owner rule and the history can’t be kept safe, so it refuses to start.')
  }
  if (!db || typeof db.beginTransaction !== 'function' || db.transactionOptions === false) return fail()
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
    if (options.refuseMember === undefined)
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
    }
    const before = config.onInit
    return {
      ...config,
      custom: { ...config.custom, sharing: resolved },
      onInit: async (payload) => {
        await before?.(payload)
        await assertTransactions(payload)
      },
      collections: [...(config.collections ?? []), groupsCollection(resolved, options), membersCollection(resolved, options), eventsCollection(resolved, options)],
    }
  }
