# payload-plugin-sharing

Sharing for Payload: people share records with other users and organizations, under access rules the host passes in.

**Status:** first version, version 0.x, not on npm yet. It is tested against real Payload 3.92 with an in-memory MongoDB replica set (72 tests, including two requests at once and refusals over REST, GraphQL and bulk update). It has not been used in a live site yet, and the admin screens have not been checked in a browser. It needs a database that supports transactions (a MongoDB replica set), because the last-Owner rule and the history rely on them. On start it checks, and refuses to run without them.

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
- `peopleOf`: required with organizations (or `false`). Lists the people behind an organization, so `refuseMember` runs for each of them, with `via` set to the organization and `actor` set to who is making the change. **When `peopleOf` is a function, `identities` keeps an organization only when it lists the user for it** (asked once per organization per request; if it throws, the organization is dropped), so someone `identities` maps but `peopleOf` leaves out gets no access through it. With `peopleOf: false` there is no such check and every organization `identities` maps counts. A `peopleOf` that returns something other than a list drops the organization too. An empty list checks nobody. **Risk:** only the people listed at that moment are checked. Someone who joins the organization later gets the group's access through it without the veto being asked, so ask your veto again when people join, or keep organizations out of groups where it matters, such as anything with children.
- `canCreateGroup`, `canInvite`, `canChangeLevel`: only an exact `true` allows. A truthy value, a throw or no hook is a no. `canRemove` (default: `canChangeLevel`) and `canAccept` (default: nobody; for organization members only) work the same way. A user member can only ever accept their own invitation. If the `identities` hook throws, every host hook is skipped and the change is refused. Each gets the group, the membership and `actorRole`, the asker's own role in the group.
- `refuseMember`: required. A veto asked when a member accepts, and when the level of an active member changes, even from server code. It is not asked when someone invites, so an inviter can't learn from the answer who it refuses (a minor, say): the invitation always succeeds, looks the same for everyone, and the reason goes to the person accepting. A level change on an invited row doesn't ask it either; acceptance decides. When it refuses a level change on an active row, a signed-in caller gets the same plain refusal as a `canChangeLevel` no, with nothing written. Server code (no signed-in user), and a group's founding Owner, are still asked on invite and see the reasons. Return `null` to go ahead, or a reason to refuse. Anything else refuses with a general message. A host can use it to keep minors out of every group kind except family. Pass `refuseMember: false` to say you have no veto.
  **Warning:** the reason is shown to whoever was refused. Don't write a reason that gives away something private, such as an age or a guardian link. Return a general one like `Not available for this account.` The veto is given the group (`group.id`), not its current members. If your rule depends on who is already in, query `share-members` for that group yourself. "That member is already in this group" is said only to someone who can read that row. To anyone else, such as a Viewer the host lets invite, a hidden invited row gets the same general refusal for every person.
- `canRead`: who reads memberships. Default: your own rows, every row in groups where you are Owner or Manager, and only the Owners and Managers of groups where you are a Viewer. Those rules always apply. A `where` you return is ORed with them and can only add rows. `true`, `false`, an empty `where` and a throw add nothing, so no answer opens every row, children's included.
- `allowWithoutTransactions`: the plugin checks at start that the database can open a transaction and refuses to run if it can't (a MongoDB adapter with `transactionOptions: false` can't). This opts out. It is not safe: two Owners leaving at once can both pass the last-Owner check, and a change can be saved without its history row.
- `audit`: `before` and `after` hooks for invite, accept, change level and remove. A `before` hook that throws stops the change. Separately, every one of those changes is written to `share-member-events`, an append-only history that can't be edited or deleted, and that Owners can read.

### Helpers

- `shareGroupField({ name?, hasMany? })`: the relation a host collection adds. Setting or moving it needs Owner or Manager in the group the record goes into and the one it leaves. A change that isn't allowed is dropped.
- `canView(req, doc)` and `canEdit(req, doc)`: for the host's access functions. Both return false on any error.
- `sharedWhere(req, { need })`: a `where` for list access, or false.
- `membershipsOf`, `roleIn`, `groupIdsFor`, `identitiesOf`: lower-level reads. These throw on a read error, so wrap them if you use them directly.

## Limits

- A record can be in one group (or several, with `hasMany`). Records don't inherit from parent groups.
- Hooks get plain ids and `{ relationTo, value }` references, plus the `id` and `data` of the change.
- `notes`, `invitedBy` and `removedBy` on a membership are readable by the group's Owners and Managers only, and notes are capped at 500 characters.
- Someone changing their own row (accepting or leaving) can't write its notes (on a new invitation either), and neither can someone acting for an organization on its row, unless they are an Owner or Manager of the group. Server code can.
- Member changes need the request's transaction. Server code that passes `disableTransaction` is refused (unless you set `allowWithoutTransactions`).
- A removal can't carry a level change in the same update; do them in two steps, so each is checked and recorded.
- A group's `owner` field names who it started with, and every member who can read the group can see it, even after that person has left. Use the memberships for who the Owners are now.
- Memberships change one at a time; a bulk update is refused.
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
