# payload-plugin-sharing

Sharing for Payload: people share records with other users and organizations, under access rules the host passes in.

**Status:** first version, version 0.x, not on npm yet. It is tested against real Payload 3.92 with an in-memory MongoDB replica set (61 tests, including two requests at once and refusals over REST, GraphQL and bulk update). It has not been used in a live site yet, and the admin screens have not been checked in a browser. It needs a database that supports transactions (a MongoDB replica set), because the last-Owner rule relies on one.

## What it does

The plugin adds two collections.

- **`share-groups`**: a name, a kind you define (for example `hobby`, `family`, `brand`) and the owner it started with.
- **`share-members`**: who is in a group (a user, or a document from another collection such as organizations), at which level, with a status of invited, active or removed.

The levels are **Owner**, **Manager** and **Viewer**. You can rename them. A Viewer reads, a Manager reads and edits, an Owner does both and is who the host usually lets manage people.

Rules the plugin enforces itself, for server code as well as for clients:

- A group always has an active Owner. The last Owner can't leave or be demoted. Two Owners demoting each other at the same moment leave one.
- An invited member has no access until they accept. A user accepts their own invitation. Anyone can leave.
- A removed member stays on record. Nothing is deleted, not even by server code that skips access (every delete throws), and a second live row for the same group and member can't exist.
- Group kind and first owner can't change after the group is made.
- Level, status and notes are the only fields that change on a membership.

Everything else is the host's call, and every host hook fails closed. With no hooks, nobody can make a group or invite anyone.

## Install and set up

```
npm install @extantape/payload-plugin-sharing
```

```ts
import { sharing, shareGroupField, sharedWhere } from '@extantape/payload-plugin-sharing'

export default buildConfig({
  plugins: [
    sharing({
      kinds: [{ value: 'hobby' }, { value: 'family' }, { value: 'brand' }],
      memberTypes: ['organizations'], // besides users
      identities: ({ user }) => [], // organizations this user acts for
      canCreateGroup: ({ user }) => user.canMakeGroups === true,
      canInvite: ({ actorRole, member }) => actorRole === 'owner' || (actorRole === 'manager' && member.level === 'viewer'),
      canChangeLevel: ({ actorRole }) => actorRole === 'owner',
      refuseMember: ({ subject, group }) => (subject.minor && group.kind !== 'family' ? 'Not available for this account.' : null),
    }),
  ],
  collections: [
    {
      slug: 'notes',
      fields: [shareGroupField()],
      access: { read: async ({ req }) => (await sharedWhere(req)) || false },
    },
  ],
})
```

### Options

- `kinds`: the group kinds. With none, no group can be made.
- `levels`: rename or relabel `owner`, `manager` and `viewer`. The stored values must differ.
- `memberTypes`, `identities`: let organizations be members, and say which ones a signed-in user acts for. A membership held by an identity counts for the user.
- `canCreateGroup`, `canInvite`, `canChangeLevel`: only an exact `true` allows. A truthy value, a throw or no hook is a no. `canRemove` (default: `canChangeLevel`) and `canAccept` (default: nobody; for organizations) work the same way. Each gets the group, the membership and `actorRole`, the asker's own role in the group.
- `refuseMember`: required. A veto asked on every invitation, acceptance and level change, even from server code. Return `null` to go ahead, or a reason to refuse. Anything else refuses with a general message. A host can use it to keep minors out of every group kind except family. Pass `refuseMember: false` to say you have no veto.
  **Warning:** the reason is shown to whoever was refused. Don't write a reason that gives away something private, such as an age or a guardian link. Return a general one like `Not available for this account.`
- `canRead`: who reads memberships. Default: your own rows, every row in groups where you are Owner or Manager, and only the Owners and Managers of groups where you are a Viewer. Return a `where` to widen it.
- `audit`: `before` and `after` hooks for invite, accept, change level and remove. A `before` hook that throws stops the change. Separately, every one of those changes is written to `share-member-events`, an append-only history that can't be edited or deleted, and that Owners can read.

### Helpers

- `shareGroupField({ name?, hasMany? })`: the relation a host collection adds. Setting or moving it needs Owner or Manager in the group the record goes into and the one it leaves. A change that isn't allowed is dropped.
- `canView(req, doc)` and `canEdit(req, doc)`: for the host's access functions. Both return false on any error.
- `sharedWhere(req, { need })`: a `where` for list access, or false.
- `membershipsOf`, `roleIn`, `groupIdsFor`, `identitiesOf`: lower-level reads. These throw on a read error, so wrap them if you use them directly.

## Limits

- A record can be in one group (or several, with `hasMany`). Records don't inherit from parent groups.
- Hooks get plain ids and `{ relationTo, value }` references, plus the `id` and `data` of the change.
- Invitations are rows in `share-members`. The plugin sends no email.

## Build and test

```
npm install
npm test
npm run build
```

## License

MIT. Copyright (c) 2026 EXTANT APE. See `LICENSE`.

Contributions arrive as pull requests from `co/` branches in this repo. Only the owner merges.
