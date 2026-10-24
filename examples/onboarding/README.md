# From a missing declaration to an honest result

This small Envalid + Zod + Compose **analysis fixture** deliberately omits `WEBHOOK_SECRET`
from both `.env.example` and the selected `api` service. The source schema requires
that secret and gives the non-secret `PORT` a default. A separate Zod schema maps
`label` to `APP_LABEL` with a static default: this documented input stays optional
and needs no Compose declaration. Only `src` belongs to `api`.

The source is inspected, never executed. Envalid and Zod do not need to be installed to
scan this fixture. The Compose file is not a runnable stack: there is no application
image or startup command, and no container is started by this walkthrough.

## Automatic walkthrough

After installing the repository's locked dependencies, run from the repository root:

```sh
node scripts/onboarding.mjs
```

Or use `npm run demo:onboarding`. The runner makes a fresh copy in the system
temporary directory, invokes the actual CLI for every step and checks the results.
It repairs only that copy and removes it in a `finally` block. The committed fixture
stays intentionally broken, so the walkthrough can be repeated.

The runner needs neither Git, Docker, network access nor credentials. It exits **0**
when all expected outcomes are verified, including commands that intentionally exit
**1** for remaining findings. An unexpected result makes the runner exit **1**.

Measured output (2026-10-23, Node 24.19.0 on Windows):

```text
Initial structural scan: exit 1; 2 error(s), 0 warning(s)
Explain WEBHOOK_SECRET: exit 1
Plan repairs: exit 1
Preview example repair: exit 1; 2 error(s), 0 warning(s)
Preview Compose repair: exit 1; 2 error(s), 0 warning(s)
Apply example repair: exit 1; 1 error(s), 0 warning(s)
Apply Compose repair: exit 0; 0 error(s), 0 warning(s)
Repaired structural scan: exit 0; 0 error(s), 0 warning(s)
Compare before and after repairs: exit 0; 0 error(s), 0 warning(s)
Repeat example repair: exit 0; 0 error(s), 0 warning(s)
Repeat Compose repair: exit 0; 0 error(s), 0 warning(s)
Compare repaired project with itself: exit 0; 0 error(s), 0 warning(s)
Check local files: missing secret: exit 1; 1 error(s), 0 warning(s)
Check local files: empty placeholder: exit 1; 1 error(s), 0 warning(s)
Compare without checking local credentials: exit 0; 0 error(s), 0 warning(s)
Compare unchanged broken project: exit 1; 2 error(s), 0 warning(s)
```

## Inspect the steps manually

Make your own disposable copy first. Replace `/path/to/copy` below with its path;
these commands run from the EnvCheck checkout and do not require a global install.

```sh
node src/cli.mjs scan /path/to/copy --no-values --strict
node src/cli.mjs explain WEBHOOK_SECRET /path/to/copy --no-values
node src/cli.mjs plan /path/to/copy --no-values
node src/cli.mjs fix-example /path/to/copy
node src/cli.mjs fix-compose /path/to/copy
node src/cli.mjs fix-example /path/to/copy --apply
node src/cli.mjs fix-compose /path/to/copy --apply
node src/cli.mjs scan /path/to/copy --no-values --strict
```

The first scan finds `UNDOCUMENTED_VARIABLE` and `COMPOSE_VARIABLE_MISSING` for
`WEBHOOK_SECRET`. `explain` shows its source location and missing declaration;
`plan` proposes both repairs. Both previews preserve the files.

`fix-example --apply` adds `WEBHOOK_SECRET=` and still exits **1**, because the
Compose omission remains. `fix-compose --apply` adds
`${WEBHOOK_SECRET:?Set WEBHOOK_SECRET locally}` to `services.api.environment`,
preserving the existing comment and port declaration. Repeated repairs do nothing.

The final structural scan exits **0** with `scope.complete: true`, but
`scope.valuesChecked: false` and `local.state: "not-checked"`. The placeholder and
Compose reference document a requirement; neither supplies its value.

The runner also saves a separate original snapshot and invokes `compare` through
the CLI. It verifies that the two original findings are resolved, no requirements
changed, and comparison skips local values. Comparing the repaired project with
itself has no changes and succeeds; comparing the unchanged broken snapshot with
itself has no changes and still exits **1** because its two errors remain. All
**16 CLI commands** run on disposable copies. For manual comparison, keep a
separate copy before applying repairs and run:

```sh
node src/cli.mjs compare /path/to/before /path/to/copy --strict --markdown
```

## Show what still needs a person

In your disposable copy only, create `.env` with the non-secret setting `PORT=3000`,
then run without `--no-values`:

```sh
node src/cli.mjs scan /path/to/copy --strict
```

It exits **1**, reporting `REQUIRED_VALUE_MISSING` for `WEBHOOK_SECRET` with
`local.state: "missing"`. Adding an empty `WEBHOOK_SECRET=` changes the state to
`"empty"` and still exits **1**. The automated runner verifies both outcomes.

For your real application, obtain and provide the actual webhook secret using your
local or deployment configuration. Do not commit it or substitute a fake value to
silence the finding. Even a nonempty local value establishes presence only: credential
validity, webhook verification, Compose interpolation and application startup have
not been checked. Host shell variables are not read by EnvCheck's file checks.
