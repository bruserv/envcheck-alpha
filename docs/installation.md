# Local tarball installation

EnvCheck is an **unpublished prototype** named `envcheck-workbench`, version
`0.2.0-alpha.1`, with `private: true`. These instructions install a file supplied by the
project owner; they do not fetch a package named `envcheck` from npm.

Requires Node **22.18.0+ within 22.x**, or **24.11.0+**, and npm. The manifest
allows later Node lines too; CI targets 22.18.0, current 22, 24.11.0 and current 24 on Windows
and Linux. A configured matrix is not a claim that its remote jobs passed.

## Prepare the archive in a checkout

Create an output directory, then run in the EnvCheck checkout:

```sh
npm pack --ignore-scripts --pack-destination ./artifacts
```

On Windows PowerShell use `npm.cmd pack --ignore-scripts --pack-destination .\artifacts`.

This creates `artifacts/envcheck-workbench-0.2.0-alpha.1.tgz`. No build or lifecycle
scripts are required. Packing does not need the registry. Keep `private: true`
and the working name; neither prevents local packing or installation.

The explicit file list includes runtime `src/*.mjs`, the skill and its reference
Markdown files, this installation guide, configuration/limitations/Zod guides,
README and MIT license. It excludes checkout history, examples, test data,
scripts, reports, temporary directories and all downloaded third-party trials.
The package test audits npm's inventory and the installed files/references.
It also rejects runtime modules unreachable through static imports from the CLI
or API. These checks do not detect arbitrary credentials embedded in reachable
code or documentation; review content before distributing any archive.

## Install in a different directory

In a new application directory, initialize your npm project if needed:

```sh
npm init --yes --ignore-scripts
npm install --save-dev --ignore-scripts /absolute/path/envcheck-workbench-0.2.0-alpha.1.tgz
```

For Windows PowerShell, use the `.cmd` shim explicitly, without changing your
execution policy for `npm.ps1`:

```powershell
npm.cmd init --yes --ignore-scripts
npm.cmd install --save-dev --ignore-scripts "C:\Packages\envcheck-workbench-0.2.0-alpha.1.tgz"
```

The three direct runtime dependencies are pinned. They are **not bundled** in the
archive: npm needs registry access or all required metadata/tarballs in its cache.
The checkout's package-lock is not shipped as a consumer lock; transitive ranges
can resolve differently. Preserve the consuming project's generated lockfile for
its installation reproducibility. No global installation or npm link is needed.

On Linux, invoke only the installed local bin (macOS has not been validated):

```sh
./node_modules/.bin/envcheck --help
./node_modules/.bin/envcheck scan . --json --no-values
./node_modules/.bin/envcheck skill install . --agent both --json
```

On Windows PowerShell:

```powershell
& .\node_modules\.bin\envcheck.cmd --help
& .\node_modules\.bin\envcheck.cmd scan . --json --no-values
& .\node_modules\.bin\envcheck.cmd skill install . --agent both --json
```

If you prefer invoking the installed entry with Node directly, use
`node node_modules/envcheck-workbench/src/cli.mjs`. Never use an unqualified
`npx envcheck`: that could download an unrelated package. Once the archive is
installed, the source checkout is not needed by the CLI, API or skill installer.
The archive itself may also be moved after installation; npm records its file
location for future reinstall, so keep an accessible copy for `npm ci` later.

CLI codes: **0** no blocking findings, **1** findings, **2** invocation/input
failure. JSON outputs retain schema version 1 and omit setting values. Repair
commands preview unless `--apply` is given. Empty placeholders and Compose
interpolation declarations do not supply credentials. Git comparison additionally
requires a local Git executable/repository and existing refs; no fetch occurs.

## ESM API

In your consuming project, create an `.mjs` file (or use `type: module`):

```js
import { scanProject, compareProjects, fixExample, fixCompose, VERSION } from 'envcheck-workbench';

const report = await scanProject('.', { noValues: true });
console.log(VERSION, report.summary);
```

The root export is `./src/index.mjs`; CommonJS require is not a public API.
Other named exports are `makePlan`, `explainVariable`, `formatReport`,
`formatComparison`, `formatComparisonMarkdown` and `compareGit`.
Repairs are previews by default; pass `{ apply: true }` only for intended writes.

## Configure and investigate the installed tool

The complete [configuration reference](configuration.md) ships in this package,
at `node_modules/envcheck-workbench/docs/configuration.md` in the consuming app.
It explains one selected Compose service, `variables`, explicit `required`,
exact-name `ignore`, manual `required: false` after checking application behavior,
remote fallback limits and conditional flags. No checkout-only document is
needed for those decisions.

Use the installed CLI's `explain NAME . --no-values` for readable evidence, or
add `--json` for the unchanged versioned contract. Example-only names can have
diagnoses while `found` remains false. Exit 1 still follows project-wide findings
for found names; it is not a selected-variable-only success signal. Compose
previews show map/list additions, not a full serialization diff.

## Repeatable package verification (source checkout only)

```sh
npm run test:package
```

In Windows PowerShell use `npm.cmd run test:package`.

This runs real `npm pack --ignore-scripts` and `npm install --ignore-scripts` into
a fresh system temporary directory **outside the checkout**, with spaces in paths.
It relocates the archive, checks the installed package is not a symlink, audits
module/resource/doc references, invokes the local bin, and imports the public API
from a consumer-owned script. It tests help, clean/broken Zod + Compose scans,
JSON/Markdown comparisons, both previews/applies/repeats, skill files/references,
UTF-8 BOM/CRLF inputs and repairs, a separate missing-config-version failure,
source BOM before shebang/first-line column checks, refusal to preview/apply
Compose inputs with additional stream BOMs,
and refusal when serialization would turn a scalar U+FEFF into a signature,
exit codes 0/1/2 and omission of synthetic fixture values. It never executes the
scanned fixture application. NODE_PATH/NODE_OPTIONS are removed from child
processes so they cannot redirect dependency resolution into the checkout.

Regular `node --test test/*.test.mjs` tests **never install or contact a registry**.
Package verification is separate and may need the registry. For a prepared cache,
set `ENVCHECK_PACKAGE_OFFLINE=1`. Missing cache data (`ENOTCACHED`) produces
**blocked, exit 2**, in offline or online mode; installation is unverified.
A cache miss alone does not prove whether a dependency version is valid. Repeat
with registry access to establish that; npm `E404`, `ETARGET` and `EBADENGINE`
produce **failed, exit 1**, even if warning text mentions a network problem.
`ENVCHECK_PACKAGE_CACHE` selects an existing/writable npm cache. No cached package
is substituted by a fixture or by node_modules copied from the checkout.

The test locates real npm via `npm_execpath` when run by npm, or common installed
paths. For direct Node execution with an unusual npm installation,
`ENVCHECK_NPM_CLI` may point to its actual `npm-cli.js` file. It does not install
or emulate npm. If npm/registry access is unavailable, the report records
`blocked` and the real failure; installation is not reported as verified.
Classification uses npm's final error-code line. Audits after packing/installing
and the harness's own process deadline are failures, not registry/cache blocks.
Pack/install have a 180-second process deadline; individual registry fetches have
a 30-second timeout and no retries. Other child commands have 60 seconds.

Local test evidence is written to the ignored `examples/reports/package-validation.json`; do not add generated reports to the source repository. A successfully
packed archive is retained in `.envcheck-test-work/package-output/`, even if the
subsequent installation fails. Consumer copies are removed after the run unless
`ENVCHECK_PACKAGE_KEEP=1` is set. These paths and test scripts are not distributed.
Evidence replaces checkout/profile/temp roots with placeholders. Cleanup retries
transient locks and, if it still fails, persists a failed result with the cleanup
error. `compareGit` is loaded through the public API but not exercised against a
Git repository by this package test; Git behavior has separate checkout tests.
Package verification may write to npm's selected cache; select a writable cache
when running with restricted filesystem permissions.
