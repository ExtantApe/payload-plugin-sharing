# Changelog

## Unreleased

- The repo, with the standard Payload plugin kit. Public since 2026-11-22.
- The first version of the plugin (Captive Origins K5228, account model T5; follows D5228, D5234 and D5239):
  - `share-groups` and `share-members` collections, with Owner, Manager and Viewer levels the host can rename, and member types the host can extend to organizations.
  - A group always keeps an active Owner. The last Owner can't leave or be demoted, and two Owners changing each other at once leave one.
  - Host hooks `canCreateGroup`, `canInvite`, `canChangeLevel`, `canRemove` and `canAccept`, all failing closed on anything but an exact `true`.
  - A `refuseMember` veto on invite, accept and level change, applied to server code too.
  - Audit hooks for invite, accept, change level and remove.
  - `shareGroupField`, `canView`, `canEdit` and `sharedWhere` for host collections.
  - Nothing is deleted; removal is a status, and a unique key stops a second live row for the same group and member.
- Tested: 45 tests against real Payload 3.92 with an in-memory MongoDB replica set, covering each path above, repeated two-at-once runs for the last-Owner and duplicate-invite rules, and clean-up of the database and server at the end.
- Not tested: a database without transactions (the last-Owner guard needs a replica set), a live site, the admin screens in a browser, and a very large number of members.
