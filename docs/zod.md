# Standalone Zod environment schemas

EnvCheck can inspect a bounded, file-local Zod object schema when its input is a
recognized environment object. This requires no Zod installation in EnvCheck:
application imports are inspected through the AST and are never executed.

```js
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REGION: z.string().default('local'),
  OPTIONAL_LABEL: z.string().optional(),
});

const result = schema.safeParse(process.env);
```

Here `DATABASE_URL` is required; `REGION` and `OPTIONAL_LABEL` are optional. The
schema keys become ordinary EnvCheck usages, so documentation checks, one selected
Compose service, repair plans and comparisons all use them. Removing the default
from `REGION` is reported as `BECAME_REQUIRED`. Defaults and source snippets never
appear in reports.

## Recognized bindings and input

- Runtime default, namespace and renamed `z` imports from `zod`, `zod/v3`, `zod/v4`.
- Unshadowed `require('zod')`, including `{ z: alias }` destructuring and direct
  `require('zod').object(...)` calls.
- Inline `z.object({...})` schemas and file-local variable aliases of such schemas.
- `.parse`, `.safeParse`, `.parseAsync` and `.safeParseAsync` with exactly one argument.
  The [Zod parsing API](https://zod.dev/basics) describes their runtime behavior;
  EnvCheck inspects the same schema contract without running the parse operation.
- `process.env`, supported `node:process` imports/aliases, `globalThis.process.env`,
  `import.meta.env`, and supported local aliases of these environment objects.
- TypeScript wrappers and `z.infer<typeof schema>` type queries. Schema and field
  names are resolved in the initializer's lexical scope, even if a later function
  shadows the name `z`.

A function parameter named `process` is not assumed to be Node's process. A method
named `parse` on an unrelated object is not assumed to be Zod. Parsing arbitrary
input does not invent environment requirements. Separate direct reads of the same
variable keep their own requiredness, even if a schema makes that variable optional.

## Mapped inputs

A static object can map schema fields to different environment variable names:

```js
const schema = z.object({
  endpoint: z.string(),
  label: z.string().default('local'),
});
const input = {
  endpoint: process.env.API_URL,
  label: import.meta.env.VITE_LABEL,
};
schema.safeParse(input);
```

EnvCheck reports `API_URL` as required and `VITE_LABEL` as optional, with the locations
of their actual reads. It does not invent `endpoint` or `label` variables. Inline
objects and file-local `const` aliases used exclusively by that one parse call are
supported. Every linked value must be a direct supported environment read (including
TypeScript wrappers). Reads elsewhere keep their own requiredness.

Maps with spreads, computed/duplicate keys, getters, mutation, exports, reassignment
or additional consumers remain incomplete. No schema optionality is applied to
their direct reads. Missing fields and computed/non-environment field values also
remain incomplete when a map contains a recognized environment input. Multiple
parses of one aliased object are deliberately outside the bounded alias support.

## Field coverage

The supported bases are `string`, `number`, `boolean`, `bigint`, `date`, `enum`, and
`literal`. This identifies presence requirements only; it does not infer EnvCheck
type rules or check that the resulting Zod schema is valid.

Supported modifiers include:

- `optional()` and `nullish()` make the variable optional. `nullable()` alone does not.
- `default(value)` and `catch(value)` make a fully classified chain optional only with a statically usable
  scalar: a nonempty string, numeric literal (including signed
  literals), or boolean. Empty/null/function/computed/structured defaults remain
  incomplete and conservatively required. Suitability of defaults is not validated.
- Static presence-preserving methods: `min`, `max`, `length`, `nonempty`, `url`, `email`,
  `uuid`, `regex`, `startsWith`, `endsWith`, `includes`, `trim`, `toLowerCase`,
  `toUpperCase`, `int`, `positive`, `nonnegative`, `negative`, `nonpositive`, `finite`,
  `describe`, `brand`, `readonly`, and `nullable`. Arguments must be literal/static
  syntax; callbacks and computed expressions remain unknown.

Both standalone Zod inference and the T3 Env adapter share this explicit field-chain
classification (`classifyZodField`), with `z.coerce.*` and `zod/v4-mini` enabled only in T3 Env.
Unknown methods, refinements/transforms, unions and dynamic defaults produce
`SOURCE_UNSUPPORTED`, retain known field names and conservatively require those
fields (as does `z.coerce.*` in standalone Zod), subject to the presence proof below.

### Outer wrappers around opaque work

Presence and coverage are separate. A recognized chain starting with a supported
required base can contain `refine`, `superRefine`, `transform`, or one or more
bounded `pipe` calls and still establish optional presence through an outer,
zero-argument `optional()` or `nullish()`:

```js
z.object({
  CORS_ORIGIN: z.string()
    .transform(value => value.split(',').map(origin => origin.trim()))
    .pipe(z.array(z.url()))
    .optional(),
}).parse(process.env);
```

`CORS_ORIGIN` is optional, while the field still produces `SOURCE_UNSUPPORTED` and
the report keeps `scope.complete: false`. This does not validate URLs, analyze the
callback or prove that the pipeline succeeds for supplied values. Callbacks,
imports and application code are never executed by EnvCheck. Both standalone
Zod and T3 Env use this proof, including supported mappings to actual input names.
Independent reads keep their own requirements, including reads in T3 callbacks.

The new pipe subset requires exactly one inline target with a verified Zod
binding. Target syntax is limited to the supported field bases, `url()`, recursive
`array(target)`, static presence-preserving modifiers and zero-argument
optional/nullish. This only checks bounded provenance; it does not classify target
validation or compatibility. Target aliases, factories, callback methods, nested
pipe calls inside the target, spreads, unknown methods and computed arguments
remain conservatively required and unknown. Mini's functional API is outside this
new method-chain subset; existing non-pipe T3 handling is unchanged.

| Field chain (with `s = z.string()`) | Presence | Coverage |
| --- | --- | --- |
| `s.transform(fn).pipe(z.string()).optional()` | Optional | Unknown |
| `s.pipe(z.string()).pipe(z.string()).nullish()` | Optional | Unknown |
| `s.optional().pipe(z.string())` | Conservatively required | Unknown |
| `s.optional().pipe(z.string()).optional()` | Conservatively required | Unknown |
| `s.pipe(z.string()).nullable()` | Conservatively required | Unknown |
| `s.pipe(z.string()).optional().nullable()` | Optional | Unknown |
| `s.pipe(z.string()).optional().nonoptional()` | Conservatively required | Unknown |
| `s.pipe(z.string()).optional().refine(fn).optional()` | Conservatively required | Unknown |
| `s.default('x').pipe(z.string()).optional()` | Conservatively required | Unknown |
| `s.pipe(z.string()).default('x')` / `.catch('x')` | Conservatively required | Unknown |

Order matters across versions. In
[Zod 3.23.8](https://github.com/colinhacks/zod/blob/v3.23.8/src/types.ts), optional
returns for undefined before parsing the inner schema. In
[Zod 4.3.5](https://github.com/colinhacks/zod/blob/v4.3.5/packages/zod/src/v4/core/schemas.ts),
it can delegate when the inner input is already marked optional; pipe inherits
that marker from its left input. A callback reached after optional/default can
therefore throw even through another outer optional. EnvCheck retains a
conservative requirement in those cases, including
`s.optional().refine(fn).optional()` without any pipe. Default/catch also do not
prove optional presence across opaque work: defaults differ across v3/v4, and
catch does not catch arbitrary callback exceptions. Even semantically safe cases
can remain unknown under this deliberately narrow proof.

The semantics were inspected in official Zod v3.23.8/v4.3.5 source. These adapters are tested against inert source snippets; Zod libraries and application code are not executed. Dependency ranges do not establish an application's installed version. Conservative source-requiredness of independent reads does not prove actual application need for those values. Attribution for the motivating reduced fixture is in the source checkout's `test/fixtures/README.md`.

## Boundaries

Schemas that escape to other functions, are exported, reassigned, mutated or composed
with methods such as `partial`/`extend` remain unresolved. Shapes declared in separate
variables, imported schemas, custom parse options, Mini's functional APIs and inputs
computed through arbitrary expressions are outside this adapter's scope. Dynamic/spread
shape entries keep coverage incomplete and may hide additional keys.

This is bounded source analysis, not a proof that a parse call runs, that callers
handle `safeParse` failures, or that supplied credentials are valid. See the complete
[limitations](limitations.md). Diagnostic benchmark notes are in the source
checkout's `docs/benchmark.md`, excluded from the installed package.
