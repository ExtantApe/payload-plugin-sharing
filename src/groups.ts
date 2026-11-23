import { APIError, type CollectionConfig, type PayloadRequest } from 'payload'

import { groupIdsFor, identitiesOf, idOf, refOf, sameRef, signedIn } from './helpers.js'
import { GROUPS, MEMBERS, type ResolvedSharing, type ShareGroup, type SharingOptions } from './types.js'

export const refuse = (message: string) => new APIError(message, 403, undefined, true)

/** Only an exact `true` passes. A throw, a rejection or any other answer is a no. */
export async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

/** Server code can pass `disableTransaction`. The adapter can also hand back no transaction. Either way the change is refused, because it must be atomic with its lock and history rows. */
export async function needTransaction(req: PayloadRequest, s: ResolvedSharing) {
  if (s.needsTransactions && !(await req.transactionID)) throw refuse('This change needs a transaction, so it wasn’t made.')
}

export function groupsCollection(s: ResolvedSharing, opts: SharingOptions): CollectionConfig {
  const memberTypes = s.memberTypes
  return {
    slug: GROUPS,
    labels: { singular: 'Share group', plural: 'Share groups' },
    admin: {
      group: opts.adminGroup ?? 'Sharing',
      useAsTitle: 'name',
      defaultColumns: ['name', 'kind', 'owner'],
      description: 'A group of people and organizations who share records. Groups are never deleted, and always keep an Owner.',
    },
    access: {
      create: async ({ req, data }) => {
        const user = signedIn(req, s)
        if (!user || !opts.canCreateGroup) return false
        const plain = { ...(data as Record<string, unknown>), owner: refOf((data as { owner?: unknown })?.owner) ?? undefined } as Partial<ShareGroup>
        if (!(await exactlyTrue(() => opts.canCreateGroup!({ req, user, data: plain })))) return false
        // Nobody makes a group that starts with someone else as Owner.
        try {
          const owner = plain.owner ?? { relationTo: s.users, value: user.id }
          return (await identitiesOf(req, s)).some((r) => sameRef(r, owner))
        } catch {
          return false
        }
      },
      read: async ({ req }) => {
        try {
          if (!signedIn(req, s)) return false
          return { id: { in: await groupIdsFor(req, 'view') } }
        } catch {
          return false
        }
      },
      update: async ({ req }) => {
        try {
          if (!signedIn(req, s)) return false
          return { id: { in: await groupIdsFor(req, 'own') } }
        } catch {
          return false
        }
      },
      delete: () => false,
    },
    fields: [
      { name: 'name', type: 'text', required: true },
      {
        name: 'kind',
        type: 'select',
        required: true,
        index: true,
        options: s.kinds.map((k) => ({ label: k.label ?? k.value, value: k.value })),
        admin: { description: 'Set when the group is made and fixed after, because host rules can depend on it.' },
      },
      {
        name: 'owner',
        type: 'relationship',
        relationTo: memberTypes,
        required: true,
        index: true,
        admin: { description: 'Who the group started with as its first Owner. After that, Owners are the active members at the Owner level.' },
      },
      // Every Owner change writes this first, inside its transaction, so two changes at once can't both pass the last-Owner check.
      { name: 'lock', type: 'number', hidden: true, admin: { disabled: true }, access: { create: () => false, update: () => false } },
    ],
    hooks: {
      // Groups are never deleted, not even by server code that skips access.
      beforeDelete: [
        () => {
          throw refuse('Groups are never deleted.')
        },
      ],
      beforeChange: [
        async ({ data, originalDoc, operation, req }) => {
          await needTransaction(req, s)
          if (operation === 'create') {
            if (typeof data.name !== 'string' || !data.name.trim()) throw refuse('A group needs a name.')
            data.name = data.name.trim()
            if (!s.kinds.some((k) => k.value === data.kind)) throw refuse('Unknown kind of group.')
            let owner = refOf(data.owner)
            if (!owner) {
              const user = signedIn(req, s)
              if (!user) throw refuse('A group needs an owner.')
              owner = { relationTo: s.users, value: user.id }
            }
            if (!memberTypes.includes(owner.relationTo)) throw refuse('That kind of owner isn’t allowed.')
            data.owner = owner
            data.lock = 0
            return data
          }
          if ('kind' in data && data.kind !== originalDoc.kind) throw refuse('A group’s kind can’t be changed.')
          if ('owner' in data) {
            const a = refOf(data.owner)
            const b = refOf(originalDoc.owner)
            if (!a || !b || !sameRef(a, b)) throw refuse('A group’s first owner can’t be changed. Change levels instead.')
          }
          if ('name' in data && (typeof data.name !== 'string' || !data.name.trim())) throw refuse('A group needs a name.')
          return data
        },
      ],
      afterChange: [
        async ({ doc, operation, req }) => {
          if (operation !== 'create') return doc
          const owner = refOf(doc.owner)!
          // The founding Owner joins in the same transaction. If that is vetoed, the group isn't made.
          await req.payload.create({
            collection: MEMBERS as never,
            data: { group: doc.id, member: owner, level: s.levels.owner.value } as never,
            overrideAccess: true,
            req: req as PayloadRequest,
          })
          return doc
        },
      ],
    },
  }
}
