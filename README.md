# payload-plugin-sharing

Sharing for Payload: people share records with other users and organizations, under access rules the host passes in.

**Status:** a skeleton. The plugin does nothing yet; its pieces land as separate pull requests once the scope is agreed. One test checks the empty plugin leaves a config alone.

## What it does

Nothing yet. The plugin will hold no roles of its own: who may share, what, and with whom is whatever the host passes in, and each defaults to nobody.

## Install or build

Not on npm yet. To work on it:

```
npm install
npm test
npm run build
```

## License

MIT. Copyright (c) 2026 EXTANT APE. See `LICENSE`.

Contributions arrive as pull requests from `co/` branches in this repo. Only the owner merges.
