import type { Config, Plugin } from 'payload'

import { groupsCollection } from './groups.js'
import { membersCollection } from './members.js'
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
    return {
      ...config,
      custom: { ...config.custom, sharing: resolved },
      collections: [...(config.collections ?? []), groupsCollection(resolved, options), membersCollection(resolved, options)],
    }
  }
