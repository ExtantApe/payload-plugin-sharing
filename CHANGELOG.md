# Changelog

## Unreleased

- The repo, with the standard Payload plugin kit. Public since 2026-11-22.
- The first version of the plugin (for Captive Origins' business accounts):
  - `share-groups` and `share-members` collections, with Owner, Manager and Viewer levels the host can rename, and member types the host can extend to organizations.
  - A group always keeps an active Owner. The last Owner can't leave or be demoted, and two Owners changing each other at once leave one.
  - Host hooks `canCreateGroup`, `canInvite`, `canChangeLevel`, `canRemove` and `canAccept`, all failing closed on anything but an exact `true`.
  - A required `refuseMember` veto (or an explicit `false`) on invite, accept and level change, applied to server code too. The reason is shown to the person refused, so the README warns against reasons that reveal an age.
  - An append-only `share-member-events` history of every invite, accept, level change and removal, written in the same transaction.
  - Second review fixes: `notes`, `invitedBy` and `removedBy` are readable by Owners and Managers only (notes capped at 500); a user accepts only their own invitation and `canAccept` is for organizations; a throwing `identities` hook refuses before any host hook runs; `refuseMember` runs for each person behind an organization (`peopleOf`, required with organizations); the plugin refuses to start without database transactions; bulk member updates are refused.
  - Deletes always throw, even with `overrideAccess`. Hooks receive plain ids and references, and the `id` and `data` of the change. Viewers see only Owners and Managers by default.
  - Audit hooks for invite, accept, change level and remove.
  - `shareGroupField`, `canView`, `canEdit` and `sharedWhere` for host collections.
  - Nothing is deleted; removal is a status, and a unique key stops a second live row for the same group and member.
  - Third review fixes: `canRead` can only add rows to the default rules (`true`, `{}` and a throw add nothing); the transactions check opens and rolls back a real transaction, so an adapter with `transactionOptions: false` is refused, with an `allowWithoutTransactions` opt-out; self-accept and self-leave can't overwrite staff notes; a removal can't carry a level change; accept with a level change records both events; the veto runs before the already-a-member check; `invitedBy` ignores users from other auth collections; `@payloadcms/graphql` pinned. Documented: `peopleOf` must cover everyone `identities` maps, the veto isn't given current members, and a group's founding owner stays visible.
- Tested: 83 tests against real Payload 3.92 with an in-memory MongoDB replica set, covering each path above, refusals over REST, GraphQL and bulk update, server-code attempts to revive or widen a membership, repeated two-at-once runs for the last-Owner and duplicate-invite rules, and clean-up of the database and server at the end.
- Not tested: a database without transactions (the last-Owner guard needs a replica set), a live site, the admin screens in a browser, and a very large number of members.
