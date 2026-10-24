# EnvCheck

**Find configuration gaps. Give your coding agent evidence to fix them.**

EnvCheck is a local CLI, ESM library and portable agent skill for developers building JavaScript/TypeScript applications with Claude Code, Codex, or a terminal. It connects environment reads in source code to `.env.example`, optional local value rules, and one explicitly selected Docker Compose service.

**Status: 0.2.0-alpha.1 — local alpha candidate, pending approval; not published to npm.** The working package name is `envcheck-workbench` and `private: true` remains set. Source reads use Babel AST and scope analysis; Compose uses YAML 1.2. This bounded analysis does not establish application or production readiness. This candidate has no public repository, tag or release. Remote CI must be run on its own future commit; results for another source tree do not validate this export.

## 1. Recommended installation (local tarball)

Requires **Node.js `^22.18.0 || >=24.11.0`** and npm.

Use the locally prepared `envcheck-workbench-0.2.0-alpha.1.tgz`. Verify it against the accompanying `SHA256SUMS` before installation. Checksums from older archives do not apply to a rebuilt package.

Compute the supplied archive checksum:

```sh
sha256sum /absolute/path/envcheck-workbench-0.2.0-alpha.1.tgz
```

```powershell
(Get-FileHash "C:\Packages\envcheck-workbench-0.2.0-alpha.1.tgz" -Algorithm SHA256).Hash
```

If building your own archive instead, run in the EnvCheck source checkout:

```sh
# Linux (sh)
mkdir -p ./artifacts
npm pack --ignore-scripts --pack-destination ./artifacts
```

```powershell
# Windows PowerShell (use npm.cmd to avoid npm.ps1 execution-policy blocks)
New-Item -ItemType Directory -Force .\artifacts
npm.cmd pack --ignore-scripts --pack-destination .\artifacts
```

Rebuilding an archive creates a separate artifact and requires its own checksum and installation check.

Next, in **your application directory**, install `envcheck-workbench-0.2.0-alpha.1.tgz` as a dev dependency:

```sh
# Linux (sh)
npm install --save-dev --ignore-scripts /absolute/path/envcheck-workbench-0.2.0-alpha.1.tgz
./node_modules/.bin/envcheck --help
```

```powershell
# Windows PowerShell
npm.cmd install --save-dev --ignore-scripts "C:\Packages\envcheck-workbench-0.2.0-alpha.1.tgz"
& .\node_modules\.bin\envcheck.cmd --help
```

- The three runtime dependencies (`@babel/parser@8.0.7`, `@babel/traverse@8.0.7`, `yaml@2.9.1`) are pinned in the manifest, not bundled in the `.tgz`; `npm install` requires registry access or a warm npm cache.
- Once installed, your application uses its own `node_modules/.bin/envcheck` (or `node node_modules/envcheck-workbench/src/cli.mjs`), the public ESM API (`import { scanProject } from 'envcheck-workbench'`), and bundled skill resources without needing the EnvCheck source checkout.
- Never run an unqualified `npx envcheck`: this package is unpublished and `npx` could fetch an unrelated registry package.
- See [local tarball installation, ESM API and package verification](docs/installation.md).

## 2. Quick usage scenario

Run these commands inside your application directory (replace `./node_modules/.bin/envcheck` with `& .\node_modules\.bin\envcheck.cmd` in Windows PowerShell, or `node node_modules/envcheck-workbench/src/cli.mjs` on any platform):

```sh
# 1. Create starter envcheck.config.json (never overwrites an existing file)
./node_modules/.bin/envcheck init .

# 2. Scan code, .env.example, local envFiles and the selected Compose service
./node_modules/.bin/envcheck scan . --json

# 3. Inspect provenance and references for one variable (values are omitted)
./node_modules/.bin/envcheck explain DATABASE_URL . --json

# 4. Preview and apply safe repairs (.env.example placeholders and Compose ${VAR:?...} wiring)
./node_modules/.bin/envcheck fix-example .
./node_modules/.bin/envcheck fix-example . --apply
./node_modules/.bin/envcheck fix-compose .
./node_modules/.bin/envcheck fix-compose . --apply

# 5. Compare against the common ancestor of main and emit a PR-ready Markdown summary
./node_modules/.bin/envcheck compare . --base main --merge-base --markdown

# 6. Install the portable skill for Codex (.agents/skills/envcheck) and Claude Code (.claude/skills/envcheck)
./node_modules/.bin/envcheck skill install . --agent both
```

Example `envcheck.config.json`:

```json
{
  "version": 1,
  "sources": ["src"],
  "example": ".env.example",
  "envFiles": [".env"],
  "compose": { "file": "compose.yaml", "service": "api" },
  "variables": {
    "DATABASE_URL": { "type": "url", "required": true },
    "PORT": { "type": "port", "required": false }
  }
}
```

Omit `compose` when your project does not use Docker Compose. One configuration maps one application source scope to at most one explicit Compose service; in a monorepo, point `sources` at the specific app folder rather than the whole repository. See [configuration guide](docs/configuration.md).

After installing the skill, start a new coding-agent session and ask:

> Use the envcheck skill. Check the configuration, fix the missing example and Compose declarations, and tell me what I still need to set myself.

## 3. Commands and exit codes

| Command | Purpose |
| --- | --- |
| `scan [project]` | Find documentation, local-value and selected-service declaration gaps |
| `explain VARIABLE [project]` | Show source references, local provenance and related findings |
| `plan [project]` | Preview missing example entries and repair actions without modifying files |
| `fix-example [project] [--apply]` | Preview or append empty `.example`/`.sample`/`.template` placeholders and rescan |
| `fix-compose [project] [--apply]` | Preview or add `${VAR:?Set VAR locally}` to the selected Compose service and rescan |
| `compare BEFORE AFTER` | Compare two project directories structurally (local envFiles checks are skipped; Compose env_file declarations are read) |
| `compare [project] --base REF [--head REF] [--merge-base]` | Compare a local Git revision or merge-base ancestor against working files or `--head` |
| `init [project]` | Create a starter `envcheck.config.json` without overwriting existing content |
| `skill install [project] --agent codex\|claude\|both` | Install project-local Codex and/or Claude Code skills |

- `--json`: versioned machine-readable output (`schemaVersion: 1`); variable values and source snippets are always omitted.
- `--markdown`: PR-ready Markdown summary for `compare` (mutually exclusive with `--json`).
- `--no-values`: skip selected local `envFiles` checks for structural scans. Compose service `env_file` inputs are still read to inspect declarations and explicit empty values.
- `--strict`: make warnings blocking (for `compare`, also blocks warning-level contract changes and incomplete comparison coverage on either snapshot).
- Exit **0**: no blocking findings under selected policy; **1**: blocking findings or contract changes; **2**: invalid CLI invocation or unreadable input.

## 4. What is checked vs known limitations

### Checked within bounded rules

- **Direct and aliased reads:** `process.env.KEY`, `process.env['KEY']`, `process['env'].KEY`, `globalThis.process.env.KEY`, `import.meta.env.KEY`, `'KEY' in process.env`, template literal interpolations, JSX expressions, `process`/`env` imported or required from `process`/`node:process` (including two-hop `import process from 'node:process'; const { env } = process;`), referenced file-local `const env = process.env` / `import.meta.env` aliases, simple/nested destructuring (`{ env: { KEY } } = process`), and literal defaults (including TypeScript `"dev" as const` / `satisfies`).
- **Bounded configuration wrappers:**
  - **T3 Env** (`createEnv` from `@t3-oss/env-nextjs` and `@t3-oss/env-core`, verified by ESM/CommonJS import binding) with static Zod chains, `runtimeEnv`/`runtimeEnvStrict`/`experimental__runtimeEnv`/`import.meta.env` (including static name mappings `{ apiUrl: process.env.ACTUAL_API_URL }`), and `skipValidation`.
  - **Envalid** (`cleanEnv` and built-in validators `str`, `bool`, `num`, `email`, `host`, `port`, `url`, `json` from `envalid` ESM/CommonJS bindings) with static `default` values.
  - **Standalone and statically mapped Zod** (`z.object({...}).parse/safeParse/parseAsync/safeParseAsync` from `zod`, `zod/v3`, `zod/v4` against `process.env`, `import.meta.env`, or single-consumer static input maps `{ key: process.env.ENV_KEY }`); see [Zod coverage](docs/zod.md).
  - A bounded outer Zod `optional()`/`nullish()` can establish optional presence around a pipeline while retaining `SOURCE_UNSUPPORTED` and `scope.complete: false`. Callback and pipeline behavior remain unknown.
- **Environment files & Compose:** missing `.env.example` keys, duplicate dotenv keys, explicit type rules (`string`, `number`, `integer`, `boolean`, `url`, `port`), conditional requiredness, ordered local `envFiles` provenance, and Compose service `environment` + short/long `env_file` (`{ path, required, format: "raw" }`) declarations with YAML 1.2 anchors and `<<` merge keys.

### Key limitations (part of the product contract)

- **Not a type checker, secret scanner or runtime validator:** dynamic keys, unreferenced or cross-file re-exported `env` aliases, computed fallbacks (`path.join(...)`), custom/conditional wrapper validators (`devDefault`, `refine`/`transform` callbacks, `.nonoptional()`, T3 `extends: [preset()]`), and unsupported wrappers (`convict`, NestJS `ConfigService`) are reported as incomplete (`unknown`) rather than guessed. Embedded credentials in source code are not detected (though never echoed in reports).
- **Compose checks declarations, not running containers:** EnvCheck does not evaluate `${...}` against the host shell, inspect Docker images/secrets/build args, or start containers. Multi-document YAML, `!reset`/`!override` tags, interpolated `env_file` paths and Compose `include`/`extends` are reported as incomplete. `fix-compose` refuses `include`/`extends`, unsupported `environment` entries/structures, and aliased, merge-inherited or shared-anchor service environments.
- **No credential generation:** `fix-example` writes empty placeholders (`KEY=`) and `fix-compose` writes `${KEY:?Set KEY locally}`. Neither supplies real secrets.
- **Conservative requirements:** inferred `required: true` is a source-analysis contract, not proof that the application needs an explicit value. The unchanged 42-case diagnostic benchmark reports 56 correct names, 0 false alarms, 12 misses, requiredness 49 correct / 7 mismatches, and 16 expected unknown cases. The historical `NODE_ENV: false` expectation remains; a separate raw read accounts for the additional mismatch. These selected cases do not measure general project accuracy.
- **Zod evidence:** wrapper semantics were inspected in official v3.23.8/v4.3.5 sources. Runtime Zod libraries and scanned application code were not executed. The scanner's tests do not establish library-runtime behavior.
- **Environment support:** CI is configured for Windows/Linux and Node `22.18.0`, current `22`, `24.11.0` and current `24`. This local export has not run remotely. macOS and other Node lines allowed by the manifest remain unvalidated. Node versions outside `^22.18.0 || >=24.11.0` are unsupported; CommonJS `require('envcheck-workbench')` is not a supported API.

Read [full limitations](docs/limitations.md) before relying on results for release or deployment decisions.

## 5. Try the checkout examples and development checks

In the EnvCheck source checkout (after `npm ci --ignore-scripts`, or `npm.cmd ci --ignore-scripts` in PowerShell):

```sh
node src/cli.mjs scan examples/broken
node src/cli.mjs scan examples/fixed --strict
node src/cli.mjs compare examples/broken examples/fixed
node scripts/onboarding.mjs
```

Development verification commands (source checkout only):

```sh
node scripts/check.mjs
node --test test/*.test.mjs
node scripts/benchmark.mjs
npm run test:package
```

Checkout-only development material includes `examples/`, `scripts/`, `test/`, `benchmarks/`, `docs/benchmark.md`, `CONTRIBUTING.md`, `START-HERE.pl.md` and `docs/release-plan.md`. It is excluded from the installed tarball. Benchmark attribution and license notices are retained in `benchmarks/LICENSES.md` and `test/fixtures/README.md`. Run `npm run check:docs` to verify local documentation links.

## License

[MIT](LICENSE).
