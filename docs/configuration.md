# Configuration reference

`envcheck.config.json` is optional. When present, it must explicitly declare `"version": 1`; a missing version is a configuration error, with or without a UTF-8 BOM. Unknown fields and unsupported versions fail rather than silently applying a different scope. All configured file paths must stay inside the selected project. Linked paths are rejected; linked directory entries are skipped during discovery.

One UTF-8 BOM is accepted only at the very start of a file. It is consumed in
memory for JSON parsing; files are not rewritten on read. An additional BOM or
one after JSON whitespace is not removed and remains invalid JSON. U+FEFF inside
JSON string values is retained. Invalid JSON and missing version have distinct
messages and both produce CLI `INPUT_ERROR` / exit 2 without parser excerpts.

| Field | Default | Meaning |
| --- | --- | --- |
| `version` | required if file exists | Must be the number `1` |
| `sources` | `["src"]` if present, otherwise `["."]` | Literal source directories or files |
| `example` | `.env.example` | Documentation template; values are never used as runtime settings |
| `envFiles` | `[".env"]` | Local files to load in order; later files win |
| `compose` | omitted | `{ "file": "compose.yaml", "service": "api" }` |
| `ignore` | `[]` | Exact variable names to omit from findings |
| `variables` | `{}` | Explicit per-variable type and requiredness rules |

## One application and one Compose service

Choose the source scope of one application. `compose.file` is relative to the
project root; `compose.service` is the exact key under `services` for that app.
Do not map the same source scope to every service. For example:

```json
{
  "version": 1,
  "sources": ["src"],
  "example": ".env.example",
  "envFiles": [".env"],
  "compose": { "file": "deploy/compose.yaml", "service": "api" },
  "variables": {},
  "ignore": []
}
```

Adapt paths/service names; omit `compose` when it is not used. `envFiles` models
local value checks. Compose `env_file` paths are relative to the Compose file,
and its declarations are inspected even with `--no-values`. Later env_file
entries win, then service `environment` overrides them. A project `.env` alone
does not inject variables into the container. Interpolation references count as
declarations, not verified runtime values.

An environment entry without a read in the selected code can still belong to an
image, script, framework or another scope. EnvCheck does not remove such Compose
entries or treat absence of a source read as proof they are unnecessary.

## Explicit exclusions

`ignore` is an array of exact variable names, not patterns or paths. It excludes
those names from the variable report and variable-specific checks; it does not
remove source/Compose configuration or resolve incomplete analysis. Use it only
after establishing that the name is outside the intended application scope.
Do not use exclusions to conceal a real missing requirement or obtain green
output. Prefer fixing `sources` and the selected service when the scope is wrong.

## Variable rules

Diagnostic provenance normally has `file`, `line` and `column`. For a dotenv key
whose exact source position cannot be established, it has only `file`; clients
must not assume an omitted position means line 1. This keeps schema version 1
and distinguishes unknown position from a measured location.

```json
{
  "version": 1,
  "variables": {
    "PORT": { "type": "port", "required": false },
    "DATABASE_URL": { "type": "url", "required": true },
    "PAYMENTS_ENABLED": { "type": "boolean", "required": false },
    "STRIPE_SECRET_KEY": {
      "type": "string",
      "when": { "variable": "PAYMENTS_ENABLED", "equals": "true" }
    }
  }
}
```

Without an explicit rule, any direct read without a recognized literal default makes a variable required. `required` overrides inference. `when` overrides both: the variable is required exactly when the condition matches. An unavailable condition is **unknown**, generating `CONDITION_UNRESOLVED` and `required: null`, never silently treated as disabled. Only a condition present in a loaded file can be evaluated. `--no-values` therefore leaves conditions unresolved.

`variables` maps a name to explicit `type`, `required` and/or `when` rules. For a
manually verified optional integration, a complete minimal configuration is:

```json
{
  "version": 1,
  "variables": { "OPTIONAL_ENDPOINT": { "type": "url", "required": false } }
}
```

Set `required: false` only after checking the application's behavior when that
setting is absent, including the relevant modes/branches. This is a documented
override of inference, not a way to silence inconvenient diagnoses. It relaxes
presence and required-service-declaration checks; the name still needs example
documentation, and a nonempty supplied value is still checked against `type`.
It does not supply a fallback or disable code/coverage warnings. With `when`,
the condition takes precedence over this override.

## Remote fallbacks and feature flags

This is bounded AST/scope analysis, not general data-flow or branch evaluation.
A fallback applied later to a local variable, in a helper or in another module
may not be linked back to the original environment read. That name can remain
conservatively required even when later code handles absence. Not every distant
fallback generates an unknown warning; complete coverage is not proof that all
application behavior was understood.

A flag guarding a branch does not establish that reads inside it are universally
optional, and the name of a flag does not determine its behavior. After checking
that behavior, model a conditional requirement explicitly with `when`, such as
the PAYMENTS_ENABLED rule above. Only the configured local files can resolve
the flag: missing/unread/unchecked conditions remain unknown, including with
`--no-values`. Do not change `required` or `ignore` just to hide that uncertainty.

Types validate nonempty values only. Boolean accepts exactly `true` or `false`; port accepts integers 1–65535; URL requires a hostname and supports schemes such as `https` or `postgres`. Validation does not contact endpoints. Integer requires a safe JavaScript integer; number requires finite decimal or exponent notation. Type rules are explicit; the scanner does not infer them from variable names.

Setting `envFiles: []` intentionally disables local checks. `--no-values` overrides the list for that invocation. Missing configured files are informational; the report explicitly says whether any local values were checked. EnvCheck does not implement framework-specific `.env` precedence or shell overrides. Select the files and order that match the use case.

## Report contract

### Explain and exit status

`explain NAME` prints readable evidence, source locations, states, diagnoses and
next steps for that name. `--json` keeps the same version-1 explanation shape:
`schemaVersion`, `name`, `found`, optional `variable`, `findings` and `scope`.
`found` means membership in the source/rule variable list, not presence anywhere
in the repository. A name only in `.env.example` can have `found: false` and
still have diagnoses; both text and JSON show those findings. Values and source
snippets are omitted.

Exit behavior is unchanged: `found: false` returns 1 even for an example-only
informational finding or a completely absent name. For `found: true`, the exit
uses **project-wide** errors (and warnings with `--strict`), not just the selected
name. Thus a clean selected name can still exit 1 due to a different problem;
use `scan` for all findings. Input/configuration errors return 2.

`--json` emits `schemaVersion: 1` with:

- `scope`: selected inputs, discovered source count, `valuesChecked`, and coverage `complete`.
- `summary`: counts by severity.
- `findings`: stable rule ID, severity, optional variable name, message, relative file/line/column locations, action.
- `variables`: name, documentation status, requiredness, optional declared type/condition-variable name, references, local state/provenance and selected Compose declaration state.
- `limitations`: applicable interpretation limits.

`scope.complete` means the scanner did not flag an unsupported input in the selected scope. It does not mean complete language analysis, full repository coverage or runtime readiness. Findings do not contain setting values. A Compose state of `declared` only means there is a declaration; interpolation and external availability are not verified. JSON-format Compose locations currently default to line 1.

Operational failures emit `{ "schemaVersion": 1, "error": { "code": "INPUT_ERROR", "message": "..." } }` when `--json` is set, with exit code 2. Do not interpret this as an empty findings report.

The `compare`, `plan` and `fix-example` commands have their own versioned output shapes. `compare` and `plan` do not apply a repair. `fix-example` only writes with `--apply` and includes the resulting structural report. Comparison uses variable/rule/file identity to align findings; line shifts alone do not count as new findings. With `--base`, it also includes a `git` object with resolved commit IDs, target kind, app subtree and materialized input counts; setting values are omitted.

`fix-compose` displays only new entries in the actual environment representation:
YAML map (`NAME: ${...}`), YAML list (`- NAME=${...}`), or JSON map/list members.
This is **not a full diff** or a replacement for the existing environment block.
Serialization can also change formatting; inspect the actual file diff after
apply. Existing declarations are retained. JSON retains legacy `declarations`
(assignment strings) and adds `preview` with `kind`, `format`, `lines` and
`completeDiff: false`; empty previews have null kind/format and no lines.
