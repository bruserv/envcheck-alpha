# Local workflow

These commands describe an installed local copy, not a published npm package.

```sh
node node_modules/envcheck-workbench/src/cli.mjs scan . --json
node node_modules/envcheck-workbench/src/cli.mjs explain DATABASE_URL . --json
node node_modules/envcheck-workbench/src/cli.mjs plan . --json
node node_modules/envcheck-workbench/src/cli.mjs compare ../previous-app . --json --strict
node node_modules/envcheck-workbench/src/cli.mjs compare . --base HEAD --json --strict
node node_modules/envcheck-workbench/src/cli.mjs fix-example . --json
node node_modules/envcheck-workbench/src/cli.mjs fix-compose . --json
```

When the CLI lives in another user-provided checkout, invoke that checkout's `src/cli.mjs` and pass the user's project path. Keep paths as shell-quoted arguments; never interpolate report content into shell code. `plan` is a preview and does not modify files. `compare` accepts equivalent app directories or a local `--base REF`, with optional `--head REF`. It always skips local envFiles value checks; do not treat different scopes as a proven regression. It can identify a setting becoming required even when documentation is complete. Git mode reads local objects without checkout or fetching; Compose env_file inputs may be inspected for their declarations. Exit 1 means findings; exit 2 means the scan did not run successfully. Both JSON and text reports omit variable values. Do not discard exit 1 output.

`fix-example` and `fix-compose` are previews unless `--apply` is supplied. Apply only when the user requested the relevant repair. `fix-example` adds empty example placeholders; `fix-compose` adds `${VAR:?Set VAR locally}` interpolation entries to the selected service's `environment` while preserving YAML comments (and refuses aliased/merged environments that need manual editing). Neither writes `.env` or invents credentials, and both report remaining errors after rescanning. A successfully applied repair can still exit 1 because other structural problems remain. Do not repeat a repair command in a loop.

## Configuration

Create or amend `envcheck.config.json` only if the current scope is missing or wrong:

```json
{
  "version": 1,
  "sources": ["src"],
  "example": ".env.example",
  "envFiles": [".env"],
  "compose": { "file": "compose.yaml", "service": "api" },
  "variables": {
    "PORT": { "type": "port", "required": false },
    "DATABASE_URL": { "type": "url", "required": true },
    "STRIPE_SECRET_KEY": {
      "type": "string",
      "when": { "variable": "PAYMENTS_ENABLED", "equals": "true" }
    }
  }
}
```

Omit `compose` when no service is selected. `sources` are literal project-relative paths, not globs. `envFiles` are merged in order, later files win; the host environment is never scanned. A missing `.env` means local values were not verified. `when` overrides inferred requiredness and cannot be evaluated without the condition in a loaded file. In structural mode, unresolved conditions remain warnings.

## Evidence and repairs

- `UNDOCUMENTED_VARIABLE`: add a name and placeholder to the example. This does not create a real credential.
- `REQUIRED_VALUE_MISSING`: explain where a real value must come from. Do not fill a production key with a fake value to clear the finding.
- `INVALID_VALUE_TYPE`: inspect the declared type and intended value; never quote the value in chat.
- `COMPOSE_VARIABLE_MISSING`: `.env` is an interpolation source, not automatic container injection. Add appropriate `environment` or `env_file` wiring for the selected service.
- `COMPOSE_VALUE_EMPTY`: the service explicitly sets a required variable to an empty string. Check whether it overrides an env_file entry.
- `SOURCE_UNSUPPORTED`, `UNRESOLVED_ENV_ACCESS`, `COMPOSE_UNSUPPORTED`, `CONDITION_UNRESOLVED`: coverage is incomplete. Inspect the specific syntax and explain the limit; do not claim it was validated.
- `UNREFERENCED_EXAMPLE_VARIABLE`: informational. Framework or deployment usage can justify keeping it.

The source scanner parses JS/TS/JSX with Babel and resolves bindings through scope analysis: direct `process.env.NAME`, quoted bracket reads, template interpolations, JSX expressions, simple destructuring, `globalThis.process`, `process`/`node:process` imports and requires, and `import.meta.env.NAME`. Simple literal `??` and `||` defaults suggest optionality; explicit rules can correct that. Node and Vite built-ins are excluded. Dynamic keys, whole-env aliases, computed defaults, locally bound `process` parameters/variables, and custom config wrappers remain incomplete and need manual review.

Compose files are parsed as YAML 1.2 (including JSON, anchors, aliases and `<<` merge keys) with short environment lists/maps and both short string and long `{ path, required, format: "raw" }` `env_file` entries. Multi-document YAML, Compose-specific tags (`!reset`/`!override`), interpolated `env_file` paths, `include`/`extends` and overlays are unsupported. It checks declarations and obvious empty values; it does not resolve interpolation or examine Docker image ENV. An `environment` declaration can therefore exist while its value remains unavailable at runtime.

## Final response

Use plain language, for example: "Added the missing variable to the example and passed it to api in Compose. The structural scan now passes. Local credentials and actual container startup have not been checked. Set your real key in the deployment secret store."
