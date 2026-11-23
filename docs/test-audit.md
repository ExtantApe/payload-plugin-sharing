# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-23: level changes on organization rows, release 0.1.0

- Promises: a level change on an active organization row leaves a newly vetoed person out and succeeds, with the same answer whether or not a minor is behind it; the organization's own veto is still a plain 403; `peopleOf` is a function or exactly `false`; no audit payload or access-hook argument carries the left-out list or a left-out person's id.
- Covered: in `test/plugin.test.ts` (114 tests): identical status, body, headers and audit at level change with and without a minor behind, the newly vetoed person added with the earlier ones kept, the organization's own refusal, each bad `peopleOf` value refused, and no left-out list or id in any audit event. A separate security review ran probes for both directions of a level change, a level-dependent veto, a cross-organization actor, junk `peopleOf` answers at runtime and all eight audit hooks, and found every answer identical.
- Gaps skipped (and why): response timing (not promised); people added to an organization after it joins aren't re-checked (documented in the README).

## 2026-11-23: organizations at accept

- Promises: an organization is never refused for a person behind it when a signed-in person founds or accepts for it, and the vetoed person gets no access through it; the acting person sees the same result either way; server code still sees reasons; a veto given as null, 0 or '' is refused at start.
- Covered: those, in `test/plugin.test.ts` (109 tests): REST accept with and without a vetoed person (status, body, headers, audit events), group founding for an organization, no access for the vetoed person, a person who joined later, a client unable to write the stored list.
- Correction to the entry below: its claim of identical answers covers invite, invited-row level changes and duplicates. On an active row only the refusal's look (the plain 403 of a `canChangeLevel` no) is covered; an Owner can tell a refusal from a success, which the README says.
- Gaps skipped (and why): response timing (not promised); someone who joins the organization after it accepts is not vetoed (documented).

## 2026-11-23: veto at accept

- Promises: an inviter can't tell a minor from an adult (answer, row shape, history) at invite, at level change on invited and active rows, and on duplicates; the veto is asked at accept; server code still sees reasons.
- Covered: those, in `test/plugin.test.ts` (104 tests); the veto-first and org tests now run at accept.
- Gaps skipped (and why): response timing differences (not promised).

## 2026-11-23: third review

- Promises: `canRead` only adds rows; the plugin refuses to start without transactions; a member can't write staff notes on their own row; a removal can't carry a level change; the veto runs before the duplicate check; hidden fields can't be searched.
- Covered: each of those in `test/plugin.test.ts` (101 tests), including a real adapter started with `transactionOptions: false`, and a Viewer's `where` and `sort` on notes. The weak tests (audit ids, per-person veto on accept, family group with an organization, the after-hook case) now assert what their names say.
- Also covered after the re-review: the history rows (every event, none for a refused change, no writes or edits, Owners read), members keyed by collection, what a Viewer sees of others, `identities` dropping organizations `peopleOf` doesn't list (and on a throw, cached per request), forged `invitedBy`, `disableTransaction`, notes on an organization's row, and the veto asked for a level change from server code.
- Gaps skipped (and why): someone who joins an organization after it was invited isn't vetoed until acceptance (documented).

## 2026-11-22: first version

- Promises: groups start with an active Owner; host hooks fail closed (exact `true`); the host veto applies to server code and on invite, accept and level change; a group always keeps an Owner, also under two changes at once; no duplicate live rows; no deletes; invited members have no access; accepting, leaving and removal rules; `canView`, `canEdit` and `sharedWhere` return false on error; the record's group field can only be set by Owners and Managers; levels can be renamed.
- Covered: each of those, in `test/plugin.test.ts` (101 tests, after the second review's field read, accept, identities-throw, per-person veto, transactions and bulk cases, and after EXTANT APE's review of the positions PR: server-code revive and widen attempts, deletes with overrideAccess, plain ids to hooks, the history, REST, GraphQL and bulk refusals, collection-keyed members). The two concurrency tests repeat four rounds for the last-Owner rule.
- Gaps skipped (and why): admin screens (no browser test yet); a standalone database without transactions (documented as unsupported); large member counts (no promise made).

## 2026-11-22: first audit (starter kit)

- Promises: none yet.
- Covered: none yet.
- Gaps added: none.
- Gaps skipped (and why): none.
