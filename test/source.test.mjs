import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSource } from '../src/source.mjs';

test('envalid import aliases and CommonJS exports resolve built-in validators', () => {
  for (const [imports, clean, str, port] of [
    ['import { cleanEnv as clean, str as text, port } from "envalid";', 'clean', 'text', 'port'],
    ['import * as e from "envalid";', 'e.cleanEnv', 'e.str', 'e.port'],
    ['import e from "envalid";', 'e.cleanEnv', 'e.str', 'e.port'],
    ['const e = require("envalid");', 'e.cleanEnv', 'e.str', 'e.port'],
    ['const { cleanEnv: clean, str: text, port } = require("envalid");', 'clean', 'text', 'port']
  ]) {
    const result = scanSource(`${imports}
      ${clean}(process.env, { TOKEN: ${str}(), PORT: ${port}({ default: 3000 }), EMPTY: ${str}({ default: "" }) });
    `, 'env.ts');
    assert.equal(result.complete, true, imports);
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', false], ['PORT', true], ['EMPTY', true]]);
  }
});

test('envalid defaults are output values and never appear in diagnostics', () => {
  const result = scanSource(`
    import { cleanEnv, str, bool, num, email, host, port, url, json } from "envalid";
    cleanEnv(process.env, {
      TEXT: str({ default: "secret-control-value" }), FLAG: bool({ default: false }),
      COUNT: num({ default: -1 }), MAIL: email(), HOST: host(), PORT: port(), URL: url(),
      DATA: json({ default: { list: [1, null, true] } }),
      UNSET: str({ default: undefined }), NULLABLE: str({ default: null })
    }, {});
  `, 'env.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [
    ['TEXT', true], ['FLAG', true], ['COUNT', true], ['MAIL', false], ['HOST', false],
    ['PORT', false], ['URL', false], ['DATA', true], ['UNSET', true], ['NULLABLE', true]
  ]);
  assert.ok(!JSON.stringify(result).includes('secret-control-value'));
});

test('envalid devDefault and dynamic options stay incomplete and conservatively required', () => {
  for (const options of [
    '{ devDefault: "dev" }', '{ testDefault: "test" }', '{ default: load() }',
    '{ default: "secret-control-value", ...other }', '{ ...other, default: "dev" }',
    '{ default: "dev", requiredWhen: env => env.FLAG }', '{ unknownOption: true }',
    '{ default: "dev", devDefault: "other" }', '{ default: "a", default: "b" }',
    '{ [key]: "dev" }', 'options'
  ]) {
    const result = scanSource(`import { cleanEnv, str } from "envalid";
      cleanEnv(process.env, { TOKEN: str(${options}) });`, 'env.ts');
    assert.equal(result.complete, false, options);
    assert.ok(result.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'), options);
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', false]], options);
    assert.ok(!JSON.stringify(result).includes('secret-control-value'));
  }
});

test('envalid unknown validators, dynamic schemas and custom reporters are incomplete', () => {
  for (const schema of ['schema', '{ ...schema }', '{ [key]: e.str() }', '{ TOKEN: custom() }', '{ TOKEN: e.makeValidator(fn)() }']) {
    const result = scanSource(`import * as e from "envalid"; e.cleanEnv(process.env, ${schema});`, 'env.js');
    assert.equal(result.complete, false, schema);
    assert.ok(result.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'), schema);
  }
  const reporter = scanSource('import * as e from "envalid"; e.cleanEnv(process.env, { TOKEN: e.str() }, { reporter() {} });', 'env.js');
  assert.equal(reporter.complete, false);
  assert.deepEqual(reporter.usages.map(u => u.name), ['TOKEN']);
});

test('envalid requires package and environment bindings rather than matching names', () => {
  for (const source of [
    'function cleanEnv(input, schema) {} cleanEnv(process.env, { FAKE: str() });',
    'const e = require("../"); e.cleanEnv(process.env, { FAKE: e.str() });',
    'import { cleanEnv, str } from "other-package"; cleanEnv(process.env, { FAKE: str() });',
    'import { cleanEnv, str } from "envalid"; function f(cleanEnv) { cleanEnv(process.env, { FAKE: str() }); }',
    'function f(require) { const e = require("envalid"); e.cleanEnv(process.env, { FAKE: e.str() }); }',
    'let e = require("envalid"); e = other; e.cleanEnv(process.env, { FAKE: e.str() });',
    'import { cleanEnv, str } from "envalid"; function f(process) { cleanEnv(process.env, { FAKE: str() }); }',
    'import { cleanEnv, str } from "envalid"; cleanEnv(otherInput, { FAKE: str() });',
    'import type { cleanEnv, str } from "envalid"; cleanEnv(process.env, { FAKE: str() });'
  ]) {
    const result = scanSource(source, 'env.ts');
    assert.equal(result.complete, false, source);
    assert.deepEqual(result.usages, [], source);
  }
  const shadowedValidator = scanSource('import { cleanEnv, str } from "envalid"; function f(str) { cleanEnv(process.env, { TOKEN: str({default: "dev"}) }); }', 'env.js');
  assert.equal(shadowedValidator.complete, false);
  assert.equal(shadowedValidator.usages[0].optional, false);
});

test('envalid handles Node environment aliases without suppressing independent reads', () => {
  const result = scanSource(`import { env } from "node:process"; import * as e from "envalid";
    e.cleanEnv(env, { TOKEN: e.str({ default: "dev" }) });
    console.log(process.env.TOKEN);
  `, 'env.js');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', true], ['TOKEN', false]]);
  const localAlias = scanSource('const env = process.env; const e = require("envalid"); e.cleanEnv(env, { TOKEN: e.str() });', 'env.js');
  assert.equal(localAlias.complete, true);
  assert.deepEqual(localAlias.usages.map(u => u.name), ['TOKEN']);
});

test('direct reads, quoted bracket reads, Vite reads and simple defaults', () => {
  const result = scanSource(`const a = process.env.API_KEY;
const b = process.env['DATABASE_URL'];
const c = import.meta.env.VITE_API_URL;
const port = process.env.PORT ?? 3000;
const log = process.env.LOG_LEVEL || 'info';`, 'src/app.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['API_KEY', false], ['DATABASE_URL', false], ['VITE_API_URL', false], ['PORT', true], ['LOG_LEVEL', true]]);
  assert.equal(result.usages[1].line, 2);
});

test('comments, strings and regex text are not environment reads', () => {
  const result = scanSource(`// process.env.FAKE
/* process.env.FAKE2 */
const message = "process.env.FAKE3";
const pattern = /process.env.FAKE4/;
const real = process.env.REAL;`, 'app.js');
  assert.deepEqual(result.usages.map(u => u.name), ['REAL']);
});

test('destructuring supports aliases and literal defaults', () => {
  const result = scanSource(`const { API_KEY, DATABASE_URL: db, PORT = '3000' } = process.env;`, 'app.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['API_KEY', false], ['DATABASE_URL', false], ['PORT', true]]);
});

test('dynamic reads and local aliases of the whole environment remain incomplete', () => {
  for (const source of ['process.env[key]', 'const env = process.env;', 'spawn(cmd, { env: process.env });', 'const all = { ...process.env };', 'const { ...rest } = process.env;']) {
    const result = scanSource(source, 'app.ts');
    assert.equal(result.complete, false, source);
    assert.ok(result.findings.length);
    assert.equal(result.usages.length, 0);
  }
});

test('reads inside template literal interpolations are found', () => {
  const result = scanSource('const x = `${process.env.SECRET}`; const y = `url=${import.meta.env.VITE_URL ?? "x"}`;', 'app.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => [u.name, u.kind, u.optional]), [['SECRET', 'process', false], ['VITE_URL', 'vite', true]]);
});

test('escaped property names are decoded by the parser', () => {
  const result = scanSource("const a = process.env['API\\x5fKEY']; const b = process.env[`DB_URL`];", 'app.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => u.name), ['API_KEY', 'DB_URL']);
});

test('JSX text is not code, but JSX expressions are', () => {
  const result = scanSource('export const View = () => <p title={process.env.REAL_READ}>process.env.NOT_A_READ</p>;', 'view.tsx');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => u.name), ['REAL_READ']);
  assert.deepEqual(scanSource('const v = <b>process.env.NOT_A_READ</b>;', 'view.jsx').usages, []);
});

test('process module imports and requires are resolved through scope analysis', () => {
  for (const source of [
    'import { env } from "node:process"; const x = env.KEY;',
    'import { env as e } from "process"; const x = e.KEY;',
    'import proc from "node:process"; const x = proc.env.KEY;',
    'import * as proc from "node:process"; const { KEY } = proc.env;',
    'const proc = require("process"); const x = proc.env.KEY;',
    'const { env } = require("node:process"); const x = env.KEY;',
    'const x = globalThis.process.env.KEY;'
  ]) {
    const result = scanSource(source, source.includes('require') ? 'app.cjs' : 'app.ts');
    assert.equal(result.complete, true, source);
    assert.deepEqual(result.usages.map(u => u.name), ['KEY'], source);
  }
});

test('an unrelated local env object is not an environment read', () => {
  const result = scanSource('const env = { KEY: 1 }; const x = env.KEY; import { env as other } from "./config"; other.API;', 'app.ts');
  assert.equal(result.complete, true);
  assert.equal(result.usages.length, 0);
});

test('a local process binding only makes reads through that binding unknown', () => {
  const result = scanSource('function read(process) { return process.env.FAKE; }\nconst real = process.env.REAL;', 'app.ts');
  assert.equal(result.complete, false);
  assert.deepEqual(result.usages.map(u => u.name), ['REAL']);
  assert.equal(result.findings.filter(f => f.rule === 'SOURCE_SCOPE_UNRESOLVED').length, 1);
});

test('TypeScript wrappers do not hide reads, writes or defaults', () => {
  const result = scanSource('const a = process.env.A!; const b = (process.env.B as string) ?? "x"; (process.env as any).C = "1";', 'app.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['A', false], ['B', true]]);
});

test('syntax errors are never reported as a complete scan', () => {
  const recovered = scanSource('const a = process.env.A;\nconst = ;', 'app.ts');
  assert.equal(recovered.complete, false);
  const broken = scanSource('const a = process.env.A; function {', 'app.ts');
  assert.equal(broken.complete, false);
  assert.ok(broken.findings.some(f => ['SOURCE_UNREADABLE', 'SOURCE_UNSUPPORTED'].includes(f.rule)));
});

test('source text and values never appear in findings', () => {
  const marker = 'sk-PRIVATE-SOURCE-MARKER';
  const result = scanSource(`const k = process.env.KEY ?? load("${marker}"); const d = process.env[\`${marker}\`]; spawn("${marker}", { env: process.env });`, 'app.ts');
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('empty or undefined defaults do not make variables optional', () => {
  for (const fallback of ["''", 'undefined', 'null']) {
    assert.equal(scanSource(`const x = process.env.KEY ?? ${fallback};`, 'app.ts').usages[0].optional, false);
  }
});

test('environment writes are not treated as input requirements', () => {
  assert.equal(scanSource('process.env.SET_BY_CODE = "yes";', 'app.js').usages.length, 0);
});

test('computed fallback stays conservative and marks coverage incomplete', () => {
  const report = scanSource('const key = process.env.KEY ?? loadKey();', 'app.ts');
  assert.equal(report.usages[0].optional, false);
  assert.equal(report.complete, false);
});

test('bracket access to env is recognized; type-only process imports are not runtime reads', () => {
  assert.equal(scanSource('const x = process["env"].KEY;', 'app.js').usages[0].name, 'KEY');
  assert.equal(scanSource('import type { env } from "node:process"; type X = typeof env;', 'app.ts').usages.length, 0);
});

test('package names in ordinary string values do not imply an import', () => {
  assert.equal(scanSource('const names = ["node:process", "process"];', 'app.js').complete, true);
});

test('a literal prefix of a computed fallback is not accepted as a complete default', () => {
  for (const source of [
    'const x = process.env.KEY ?? "prefix" + loadSuffix();',
    'const x = process.env.KEY || true ? undefined : "fallback";',
    'const { KEY = "prefix" + loadSuffix() } = process.env;'
  ]) {
    const result = scanSource(source, 'app.ts');
    assert.equal(result.usages[0].optional, false);
    assert.equal(result.complete, false);
  }
});

test('commas inside a computed destructuring default do not invent variable names', () => {
  const result = scanSource('const { KEY = load(a, b), OTHER } = process.env;', 'app.ts');
  assert.deepEqual(result.usages.map(u => u.name), ['KEY', 'OTHER']);
  assert.equal(result.complete, false);
});

test('local process bindings remain unknown rather than reporting fake requirements', () => {
  for (const source of [
    'function read(process) { return process.env.FAKE; }',
    'const read = (process: Custom) => process.env.FAKE;',
    'const read = process => process.env.FAKE;',
    'const process = localObject; const x = process.env.FAKE;'
  ]) {
    const result = scanSource(source, 'app.ts');
    assert.equal(result.complete, false);
    assert.equal(result.usages.length, 0);
    assert.ok(result.findings.some(f => f.rule === 'SOURCE_SCOPE_UNRESOLVED'));
  }
});

test('nullish assignment is an environment write, not a new incoming requirement', () => {
  const result = scanSource('process.env.CREATED ??= "default";', 'app.js');
  assert.equal(result.complete, true);
  assert.equal(result.usages.length, 0);
});

test('promise catch callbacks and environment-based parameter defaults do not shadow process', () => {
  for (const source of [
    'main().catch(error => { const key = process.env.API_KEY; });',
    'function read(key = process.env.API_KEY) { return key; }'
  ]) {
    const result = scanSource(source, 'app.ts');
    assert.equal(result.complete, true);
    assert.deepEqual(result.usages.map(u => u.name), ['API_KEY']);
  }
});

test('decorators, explicit resource management and TypeScript-wrapped defaults are supported', () => {
  const result = scanSource(`
    @Injectable()
    export class ConfigService {
      read() {
        using handle = openResource();
        const mode = process.env.MODE ?? ("dev" as const);
        const { REGION = "eu-central-1" satisfies string } = process.env;
        return [handle, mode, REGION];
      }
    }
  `, 'service.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['MODE', true], ['REGION', true]]);
});

test('two-hop process aliases, nested destructuring and in-operator checks are resolved', () => {
  const twoHop = scanSource('import process from "node:process"; const { env } = process; const a = env.API_KEY; const b = env.PORT || 3000;', 'app.js');
  assert.equal(twoHop.complete, true);
  assert.deepEqual(twoHop.usages.map(u => [u.name, u.optional]), [['API_KEY', false], ['PORT', true]]);

  const localEnv = scanSource('const env = process.env; const a = env.API_KEY; const vite = import.meta.env; const b = vite.VITE_URL;', 'app.ts');
  assert.equal(localEnv.complete, true);
  assert.deepEqual(localEnv.usages.map(u => [u.name, u.kind, u.optional]), [['API_KEY', 'process', false], ['VITE_URL', 'vite', false]]);

  const nested = scanSource('const { env: { API_KEY, PORT = "3000" } } = process; const hasFlag = "FEATURE_FLAG" in process.env;', 'app.ts');
  assert.equal(nested.complete, true);
  assert.deepEqual(nested.usages.map(u => [u.name, u.optional]), [['API_KEY', false], ['PORT', true], ['FEATURE_FLAG', true]]);
});

test('re-exporting the environment object across module boundaries is marked incomplete', () => {
  for (const source of [
    'export const env = process.env;',
    'export const { env } = process;',
    'export { env } from "node:process";',
    'export * from "node:process";'
  ]) {
    const result = scanSource(source, 'env.ts');
    assert.equal(result.complete, false, source);
    assert.ok(result.findings.some(f => f.rule === 'UNRESOLVED_ENV_ACCESS'), source);
  }
});

test('bounded T3 Env support extracts server, client and shared Zod schemas and respects runtimeEnv and skipValidation', () => {
  const nextResult = scanSource(`
    import { createEnv } from "@t3-oss/env-nextjs";
    import { z } from "zod";

    export const env = createEnv({
      server: {
        DATABASE_URL: z.string().url(),
        PORT: z.coerce.number().default(3000),
        OPTIONAL_TOKEN: z.string().optional(),
      },
      client: {
        NEXT_PUBLIC_API_URL: z.string().min(1),
      },
      shared: {
        NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
      },
      experimental__runtimeEnv: {
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
        NODE_ENV: process.env.NODE_ENV,
      },
      skipValidation: !!process.env.SKIP_ENV_VALIDATION,
      emptyStringAsUndefined: true,
    });
  `, 'src/env.ts');
  assert.equal(nextResult.complete, true);
  const byName = new Map();
  for (const u of nextResult.usages) {
    byName.set(u.name, (byName.get(u.name) ?? false) || !u.optional);
  }
  assert.deepEqual([...byName.entries()], [
    ['DATABASE_URL', true],
    ['PORT', false],
    ['OPTIONAL_TOKEN', false],
    ['NEXT_PUBLIC_API_URL', true],
    ['NODE_ENV', false],
    ['SKIP_ENV_VALIDATION', false]
  ]);

  const coreResult = scanSource(`
    import { createEnv } from "@t3-oss/env-core";
    import { z } from "zod";

    export const env = createEnv({
      server: { PORT: z.string() },
      clientPrefix: "PUBLIC_",
      client: { PUBLIC_API_URL: z.string().catch("http://localhost:3000") },
      runtimeEnv: import.meta.env,
    });
  `, 'src/env.ts');
  assert.equal(coreResult.complete, true);
  assert.deepEqual(coreResult.usages.map(u => [u.name, u.kind, u.optional]), [
    ['PORT', 'vite', false],
    ['PUBLIC_API_URL', 'vite', true]
  ]);
});

test('T3 Env dynamic presets, conditional validators and computed defaults mark scan incomplete', () => {
  const withPreset = scanSource(`
    import { createEnv } from "@t3-oss/env-nextjs";
    import { vercel } from "@t3-oss/env-nextjs/presets-zod";
    import { z } from "zod";
    export const env = createEnv({
      server: { SECRET: z.string() },
      experimental__runtimeEnv: {},
      extends: [vercel()],
    });
  `, 'env.ts');
  assert.equal(withPreset.complete, false);
  assert.deepEqual(withPreset.usages.map(u => [u.name, u.optional]), [['SECRET', false]]);

  const withConditional = scanSource(`
    import { createEnv } from "@t3-oss/env-nextjs";
    import { z } from "zod";
    export const env = createEnv({
      server: {
        AUTH_SECRET: process.env.NODE_ENV === "production" ? z.string() : z.string().optional(),
        NODE_ENV: z.enum(["development", "production"]).default("development"),
      },
      runtimeEnv: {
        AUTH_SECRET: process.env.AUTH_SECRET,
        NODE_ENV: process.env.NODE_ENV,
      },
    });
  `, 'env.ts');
  assert.equal(withConditional.complete, false);
  const reqByName = new Map();
  for (const u of withConditional.usages) {
    reqByName.set(u.name, (reqByName.get(u.name) ?? false) || !u.optional);
  }
  // The condition is an independent raw read, outside the NODE_ENV validator
  // and runtime mapping. A schema default must not weaken that read.
  assert.deepEqual([...reqByName.entries()], [['AUTH_SECRET', true], ['NODE_ENV', true]]);
});

test('unrelated createEnv functions and plain Zod schemas are not mistaken for T3 Env configuration', () => {
  const localCreateEnv = scanSource(`
    import * as z from "zod";
    const createEnv = () => {
      const schema = z.object({ FAKE_SCHEMA_KEY: z.string() });
      return schema.parse({ FAKE_SCHEMA_KEY: process.env.REAL_ENV_KEY });
    };
  `, 'env.ts');
  assert.equal(localCreateEnv.complete, true);
  assert.deepEqual(localCreateEnv.usages.map(u => u.name), ['REAL_ENV_KEY']);

  const arbitraryZodInput = scanSource(`
    const { z } = require("zod");
    function parseEnv(input) {
      const envSchema = z.object({ VERCEL_URL: z.string().default("localhost:3000") });
      return envSchema.parse(input);
    }
  `, 'env.js');
  assert.equal(arbitraryZodInput.complete, true);
  assert.equal(arbitraryZodInput.usages.length, 0);
});

test('signed numeric defaults are recognized in nullish/logical fallbacks, destructuring and T3 Env', () => {
  const result = scanSource(`
    import { createEnv } from "@t3-oss/env-core";
    import { z } from "zod";
    const a = process.env.RETRY_OFFSET ?? -1;
    const b = process.env.POSITIVE_STEP || +1;
    const { DESTRUCTURED_OFFSET = -2 } = process.env;
    export const env = createEnv({
      server: {
        T3_NEGATIVE: z.number().default(-1),
        T3_POSITIVE: z.coerce.number().catch(+5),
      },
      runtimeEnv: process.env,
    });
  `, 'env.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [
    ['RETRY_OFFSET', true],
    ['POSITIVE_STEP', true],
    ['DESTRUCTURED_OFFSET', true],
    ['T3_NEGATIVE', true],
    ['T3_POSITIVE', true]
  ]);
});

test('T3 Env shares Zod field classification for nonoptional, custom callbacks and unknown methods while preserving z.coerce', () => {
  for (const [validator, expectedOptional] of [
    ['z.string().optional().nonoptional()', false],
    ['z.string().transform(v => v.trim())', false],
    ['z.string().refine(Boolean)', false],
    ['z.string().superRefine(fn)', false],
    ['z.string().optional().refine(Boolean)', false],
    ['z.string().refine(Boolean).optional()', true],
    ['z.string().transform(fn).nullish()', true],
    ['z.string().unknownMethod().optional()', false]
  ]) {
    const result = scanSource(`
      import { createEnv } from "@t3-oss/env-nextjs";
      import { z } from "zod";
      export const env = createEnv({
        server: {
          TOKEN: ${validator},
          COERCED_PORT: z.coerce.number().default(3000),
        },
        runtimeEnv: {
          TOKEN: process.env.TOKEN,
          COERCED_PORT: process.env.COERCED_PORT,
        },
      });
    `, 'env.ts');
    assert.equal(result.complete, false, validator);
    assert.ok(result.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'), validator);
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [
      ['TOKEN', expectedOptional],
      ['COERCED_PORT', true]
    ], validator);
  }
});

test('T3 Env runtimeEnv supports name mapping and rejects non-env values, spreads and missing mappings without inventing names', () => {
  const mapped = scanSource(`
    import { createEnv } from "@t3-oss/env-core";
    import { z } from "zod";
    export const env = createEnv({
      server: {
        apiUrl: z.string().optional(),
        requiredSecret: z.string().min(1),
      },
      runtimeEnv: {
        apiUrl: process.env.ACTUAL_API_URL,
        requiredSecret: process.env.ACTUAL_SECRET,
      },
    });
  `, 'env.ts');
  assert.equal(mapped.complete, true);
  assert.deepEqual(mapped.usages.map(u => [u.name, u.optional]), [
    ['ACTUAL_API_URL', true],
    ['ACTUAL_SECRET', false]
  ]);

  const nonEnvValue = scanSource(`
    import { createEnv } from "@t3-oss/env-nextjs";
    import { z } from "zod";
    export const env = createEnv({
      server: {
        VAULT_KEY: z.string().optional(),
        REAL_KEY: z.string().optional(),
      },
      runtimeEnv: {
        VAULT_KEY: getFromVault(),
        REAL_KEY: process.env.REAL_KEY,
      },
    });
  `, 'env.ts');
  assert.equal(nonEnvValue.complete, false);
  assert.ok(nonEnvValue.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'));
  assert.deepEqual(nonEnvValue.usages.map(u => [u.name, u.optional]), [['REAL_KEY', true]]);

  for (const runtimeEnv of [
    '{ apiUrl: process.env.ACTUAL_API_URL, ...other }',
    '{ [computedKey]: process.env.ACTUAL_API_URL }',
    '{}'
  ]) {
    const result = scanSource(`
      import { createEnv } from "@t3-oss/env-core";
      import { z } from "zod";
      export const env = createEnv({
        server: { apiUrl: z.string().optional() },
        runtimeEnv: ${runtimeEnv},
      });
    `, 'env.ts');
    assert.equal(result.complete, false, runtimeEnv);
    assert.ok(result.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'), runtimeEnv);
    assert.ok(!result.usages.some(u => u.name === 'apiUrl'), runtimeEnv);
    if (result.usages.length) {
      assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['ACTUAL_API_URL', false]], runtimeEnv);
    }
  }
});

test('T3 Env supports CommonJS require forms and marks escaped or unsupported bindings incomplete', () => {
  for (const [setup, call] of [
    ['const { createEnv } = require("@t3-oss/env-nextjs"); const { z } = require("zod");', 'createEnv'],
    ['const { createEnv: makeEnv } = require("@t3-oss/env-core"); const z = require("zod");', 'makeEnv'],
    ['const t3 = require("@t3-oss/env-nextjs"); const { z } = require("zod");', 't3.createEnv'],
    ['const { z } = require("zod");', 'require("@t3-oss/env-core").createEnv'],
    ['import t3 from "@t3-oss/env-nextjs"; import { z } from "zod";', 't3.createEnv'],
    ['import * as t3 from "@t3-oss/env-core"; import { z } from "zod";', 't3.createEnv']
  ]) {
    const result = scanSource(`
      ${setup}
      const env = ${call}({
        server: { SECRET_KEY: z.string(), PORT: z.coerce.number().default(3000) },
        runtimeEnv: process.env,
      });
    `, 'env.js');
    assert.equal(result.complete, true, setup);
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [
      ['SECRET_KEY', false],
      ['PORT', true]
    ], setup);
  }

  for (const unsupported of [
    'const { createEnv } = require("@t3-oss/env-nextjs"); const fn = createEnv; fn({});',
    'const t3 = require("@t3-oss/env-nextjs"); pass(t3);',
    'const { other } = require("@t3-oss/env-core"); other();',
    'let { createEnv } = require("@t3-oss/env-nextjs"); createEnv({});',
    'import * as t3 from "@t3-oss/env-nextjs"; pass(t3);',
    'import { other } from "@t3-oss/env-core"; other();'
  ]) {
    const result = scanSource(unsupported, 'env.js');
    assert.equal(result.complete, false, unsupported);
    assert.ok(result.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'), unsupported);
  }
});
