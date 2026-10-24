# Contributing

Requires Node.js 22.18+ (or 24.11+) and npm. Three locked runtime dependencies (`@babel/parser`, `@babel/traverse`, `yaml`) are installed with `npm ci --ignore-scripts`; there is no build step.

```sh
npm ci --ignore-scripts
node scripts/check.mjs
node --test test/*.test.mjs
npm run test:package
```

The most useful contributions start with a minimal fixture: configuration that should pass but fails, or a real failure the scanner misses. Remove real keys, hostnames, customer data and other credentials before sharing it. Include expected behavior, actual output and the selected scan scope.

Keep rule IDs stable. Findings must include evidence and an actionable next step without variable values or source snippets. Unsupported semantics must remain visible; do not suppress a warning just to make a demo pass. Add regression tests for observable behavior and preserve the distinction between local checks, structural declaration checks and runtime validation.

For parser changes, run the source, Compose and secret-omission tests. For the skill, test discovery metadata and actual repair behavior when an agent environment is available. Do not claim that a format validator establishes behavioral correctness.

Unit tests stay offline. The separate package test uses real npm pack/install outside the checkout and may require the registry or a complete npm cache; see `docs/installation.md`. CI includes this test on Windows/Linux for Node 22.18.0, current 22, 24.11.0 and current 24. In PowerShell use `npm.cmd` for npm commands. Before a release, review actual CI results and the limits documented in `docs/limitations.md`. The npm package name is not reserved; publishing requires choosing an available package name and removing `private: true` intentionally.
