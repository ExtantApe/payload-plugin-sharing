# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-22: first version (K5228)

- Promises: groups start with an active Owner; host hooks fail closed (exact `true`); the host veto applies to server code and on invite, accept and level change; a group always keeps an Owner, also under two changes at once; no duplicate live rows; no deletes; invited members have no access; accepting, leaving and removal rules; `canView`, `canEdit` and `sharedWhere` return false on error; the record's group field can only be set by Owners and Managers; levels can be renamed.
- Covered: each of those, in `test/plugin.test.ts` (72 tests, after the second review's field read, accept, identities-throw, per-person veto, transactions and bulk cases, and after EXTANT APE's review of the positions PR: server-code revive and widen attempts, deletes with overrideAccess, plain ids to hooks, the history, REST, GraphQL and bulk refusals, collection-keyed members). The two concurrency tests repeat four rounds for the last-Owner rule.
- Gaps skipped (and why): admin screens (no browser test yet); a standalone database without transactions (documented as unsupported); large member counts (no promise made).

## 2026-11-22: first audit (starter kit)

- Promises: none yet.
- Covered: none yet.
- Gaps added: none.
- Gaps skipped (and why): none.
