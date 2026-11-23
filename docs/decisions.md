# Decisions

Dated decisions for this repo, newest last.

- 2026-11-22: created from the ops starter kit, area `co-plugins`.
- 2026-11-22: created as a skeleton on our side (Simon's go, for Captive Origins' business accounts). npm name @extantape/payload-plugin-sharing (D131). MIT, EXTANT APE. Contributions from co/ branches; only the owner merges (D256).
- 2026-11-22: first version built for Captive Origins K5228 (account model T5), following Captive Origins D5228 (shared collections with Owner, Manager and Viewer, at least one Owner), D5234 (business accounts and brands) and D5239 (a minor may be in a shared collection only through a family group with a linked guardian). The plugin stays agnostic: the minors rule is the host's `refuseMember` veto, not built in.
- 2026-11-22: invitations start as `invited` and a user accepts their own; organizations accept only through a host `canAccept` hook. Removal is a status, never a delete. The last-Owner rule is enforced in hooks with a lock write to the group inside the request's transaction, so it needs a MongoDB replica set.
- 2026-11-22: a group's kind and first owner are fixed after creation, because host rules (such as the minors rule) can depend on the kind.
