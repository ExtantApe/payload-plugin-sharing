# First public push audit

2026-11-22, before the repo went public (owner's words via Simon: "Prioritize that repo work for now then continue your other things"; D259 weekly grant).

- **Leak check:** `scripts/leak-check.sh` passed on 18 files.
- **Secrets:** no keys, passwords, tokens or private addresses in any commit's files or diffs. Pattern hits were only version numbers such as 10.0.1 in the lockfile.
- **Private terms:** none in any file or diff of the full history. Every commit's author and committer address is the GitHub noreply address.
- **Build output:** `dist/` and `node_modules/` are ignored and not committed.
- **License:** MIT, Copyright (c) 2026 EXTANT APE.
- **Content:** an empty plugin skeleton. No data, no fixtures, no player or member data.
