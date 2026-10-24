import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { scanSource } from '../src/source.mjs';

const requirements = result => result.usages.map(u => [u.name, u.kind, u.optional]);

test('pinned tRPC schema detects both previously missed variables with complete coverage', async () => {
  const cases = JSON.parse(await fs.readFile(new URL('../benchmarks/source-cases.json', import.meta.url), 'utf8'));
  const entry = cases.find(item => item.name.startsWith('real-world: trpc/trpc Next.js Prisma starter'));
  assert.ok(entry);
  const result = scanSource(entry.source, entry.file);
  assert.equal(result.complete, true);
  assert.deepEqual(requirements(result), [['DATABASE_URL', 'process', false], ['NODE_ENV', 'process', false]]);
});

test('standalone Zod parses Node environment using scoped ESM and CommonJS bindings', () => {
  for (const [imports, root] of [
    ['import { z as schema } from "zod";', 'schema'],
    ['import * as z from "zod/v3";', 'z'],
    ['import z from "zod/v4";', 'z'],
    ['const z = require("zod");', 'z'],
    ['const { z: schema } = require("zod");', 'schema'],
    ['', 'require("zod")']
  ]) {
    for (const method of ['parse', 'safeParse', 'parseAsync', 'safeParseAsync']) {
      const result = scanSource(`${imports}
        const envSchema = ${root}.object({ API_KEY: ${root}.string(), PORT: ${root}.number().default(3000) });
        envSchema.${method}(process.env);
      `, 'env.ts');
      assert.equal(result.complete, true, `${imports}: ${method}`);
      assert.deepEqual(requirements(result), [['API_KEY', 'process', false], ['PORT', 'process', true]]);
    }
  }
});

test('standalone Zod supports inline schemas, TS wrappers, schema aliases and Vite input', () => {
  const inline = scanSource(`import { z } from 'zod';
    (z.object({ VITE_URL: z.string().url(), VITE_LABEL: z.string().optional() }) as object).parse(import.meta.env);
  `, 'env.ts');
  assert.equal(inline.complete, true);
  assert.deepEqual(requirements(inline), [['VITE_URL', 'vite', false], ['VITE_LABEL', 'vite', true]]);
  const alias = scanSource(`import { z } from 'zod'; import { env as input } from 'node:process';
    const schema = z.object({ API_KEY: z.string() }); const second = schema; const third = second;
    type Configuration = z.infer<typeof schema>;
    third.safeParse(input);
  `, 'env.ts');
  assert.equal(alias.complete, true);
  assert.deepEqual(requirements(alias), [['API_KEY', 'process', false]]);
  const localEnv = scanSource('import { z } from "zod"; const env = process.env; z.object({ TOKEN: z.string() }).parse(env);', 'env.js');
  assert.equal(localEnv.complete, true);
  assert.deepEqual(requirements(localEnv), [['TOKEN', 'process', false]]);
});

test('schema initializer scope is used when a nested scope shadows its Zod import', () => {
  const result = scanSource(`import { z } from 'zod';
    const schema = z.object({ TOKEN: z.string().optional() });
    function check(z) { schema.parse(process.env); }
  `, 'env.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(requirements(result), [['TOKEN', 'process', true]]);
});

test('known Zod chains classify requiredness without emitting literal values', () => {
  const result = scanSource(`import { z } from 'zod'; z.object({
    REQUIRED: z.string().min(1).trim(), OPTIONAL: z.string().optional(),
    NULLISH: z.string().nullish(), NULLABLE: z.string().nullable(),
    DEFAULT: z.string().default('private-zod-default'), FALLBACK: z.string().catch('private-zod-catch'),
    FLAG: z.boolean().default(false), COUNT: z.number().int().default(-1),
    ENUM: z.enum(['one', 'two']), LITERAL: z.literal('private-zod-literal')
  }).safeParse(process.env);`, 'env.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [
    ['REQUIRED', false], ['OPTIONAL', true], ['NULLISH', true], ['NULLABLE', false],
    ['DEFAULT', true], ['FALLBACK', true], ['FLAG', true], ['COUNT', true], ['ENUM', false], ['LITERAL', false]
  ]);
  assert.ok(!JSON.stringify(result).includes('private-zod-'));
});

test('custom, conditional and unknown Zod field schemas remain incomplete and required', () => {
  for (const field of [
    'z.string().default(loadSecret())', 'z.string().default("")', 'z.string().catch(() => "private-zod-value")',
    'z.string().transform(value => value)', 'z.string().optional().refine(fn)',
    'z.preprocess(fn, z.string())', 'z.string().optional().nonoptional()',
    'z.union([z.string(), z.undefined()])', 'z.any()', 'customSchema',
    'flag ? z.string() : z.string().optional()', 'z.string().unknownMethod()',
    'z.string().unknownMethod().optional()', 'z.string().unknownMethod().default("local")',
    'z.string().unknownMethod().catch("local")'
  ]) {
    const result = scanSource(`import { z } from 'zod'; z.object({ TOKEN: ${field} }).parse(process.env);`, 'env.ts');
    assert.equal(result.complete, false, field);
    assert.ok(result.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'), field);
    assert.deepEqual(requirements(result), [['TOKEN', 'process', false]], field);
    assert.ok(!JSON.stringify(result).includes('private-zod-value'));
  }
});

test('Zod inference does not consume independent environment reads or unrelated schema parses', () => {
  const source = `import { z } from 'zod';
    const schema = z.object({ TOKEN: z.string().optional() });
    schema.parse(process.env); console.log(process.env.TOKEN);
    z.object({ FAKE_KEY: z.string() }).parse({ other: 1 });
  `;
  const result = scanSource(source, 'env.js');
  assert.equal(result.complete, true);
  assert.deepEqual(requirements(result), [['TOKEN', 'process', true], ['TOKEN', 'process', false]]);
  const arbitrary = scanSource('import { z } from "zod"; function validate(input) { return z.object({ FAKE_KEY: z.string() }).parse(input); }', 'env.js');
  assert.equal(arbitrary.complete, true);
  assert.deepEqual(arbitrary.usages, []);
});

test('schema mutation, reassignment, escaping aliases and composition stay unresolved', () => {
  for (const statement of [
    'schema = other;', 'schema.shape.TOKEN = z.string().optional();',
    'schema.parse = other;', 'customize(schema);',
    'const alias = schema; customize(alias);', 'export { schema };'
  ]) {
    const result = scanSource(`import { z } from 'zod'; let schema = z.object({ TOKEN: z.string() });
      ${statement} schema.parse(process.env);`, 'env.ts');
    assert.equal(result.complete, false, statement);
    assert.deepEqual(result.usages, [], statement);
  }
  for (const schema of ['z.object({ TOKEN: z.string() }).partial()', 'z.object({}).extend(extra)', 'importedSchema']) {
    const result = scanSource(`import { z } from 'zod'; ${schema}.safeParse(process.env);`, 'env.js');
    assert.equal(result.complete, false, schema);
    assert.deepEqual(result.usages, [], schema);
  }
});

test('Zod recognition verifies package bindings and actual environment inputs', () => {
  for (const source of [
    'const z = other; z.object({ FAKE: z.string() }).parse(process.env);',
    'import { z } from "other"; z.object({ FAKE: z.string() }).parse(process.env);',
    'import type { z } from "zod"; z.object({ FAKE: z.string() }).parse(process.env);',
    'import { z } from "zod"; function check(z) { z.object({ FAKE: z.string() }).parse(process.env); }',
    'function check(require) { const z = require("zod"); z.object({ FAKE: z.string() }).parse(process.env); }',
    'import { z } from "zod"; function check(process) { z.object({ FAKE: z.string() }).parse(process.env); }',
    'const z = require("zod"); z.object = other; z.object({ FAKE: z.string() }).parse(process.env);',
    'import { z } from "zod"; const alias = z; customize(alias); z.object({ FAKE: z.string() }).parse(process.env);'
  ]) {
    const result = scanSource(source, 'env.ts');
    assert.equal(result.complete, false, source);
    assert.deepEqual(result.usages, [], source);
  }
});

test('custom parse options and dynamic shapes are not silently treated as supported', () => {
  for (const source of [
    'z.object(shape).parse(process.env)',
    'z.object({ TOKEN: z.string() }).parse(process.env, { errorMap: fn })',
    'z.object({ ...shape }).parse(process.env)',
    'z.object({ [name]: z.string() }).parse(process.env)',
    'z.object({ TOKEN: z.string(), TOKEN: z.string().optional() }).parse(process.env)'
  ]) {
    const result = scanSource(`import { z } from 'zod'; ${source};`, 'env.js');
    assert.equal(result.complete, false, source);
    assert.ok(result.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'), source);
  }
  for (const shape of [
    '{ TOKEN: z.string().optional(), ...other }',
    '{ TOKEN: z.string().optional(), [name]: z.string() }',
    '{ TOKEN: z.string().optional(), TOKEN: z.string() }'
  ]) {
    const result = scanSource(`import { z } from 'zod'; z.object(${shape}).parse(process.env);`, 'env.js');
    assert.equal(result.complete, false);
    assert.ok(result.usages.every(u => u.optional === false), shape);
  }
});

test('Zod maps field names to actual Node and Vite reads without inventing schema-key variables', () => {
  const result = scanSource(`import { z } from 'zod'; import { env as nodeEnv } from 'node:process';
    const schema = z.object({ url: z.string(), label: z.string().default('private-mapped-default'), extra: z.string().optional() });
    const input = { url: nodeEnv.API_URL, label: import.meta.env.VITE_LABEL, extra: process.env['EXTRA'] } as const;
    const alias = input; const second = alias;
    schema.safeParse(second);
    console.log(process.env.EXTRA);
  `, 'env.ts');
  assert.equal(result.complete, true);
  assert.deepEqual(requirements(result), [
    ['API_URL', 'process', false], ['VITE_LABEL', 'vite', true],
    ['EXTRA', 'process', true], ['EXTRA', 'process', false]
  ]);
  assert.ok(!JSON.stringify(result).includes('private-mapped-default'));
  const inline = scanSource(`import { z } from 'zod';
    z.object({ label: z.string().optional() }).parse({ label: (process.env.APP_LABEL as string) });
  `, 'env.ts');
  assert.equal(inline.complete, true);
  assert.deepEqual(requirements(inline), [['APP_LABEL', 'process', true]]);
});

test('mapped input retains initializer scope when the parse function shadows process', () => {
  const result = scanSource(`import { z } from 'zod';
    const schema = z.object({ token: z.string().optional() });
    const input = { token: process.env.TOKEN };
    function validate(process) { schema.parse(input); }
  `, 'env.js');
  assert.equal(result.complete, true);
  assert.deepEqual(requirements(result), [['TOKEN', 'process', true]]);
});

test('mutated, escaped, exported and multiply-used mapped inputs remain incomplete and required', () => {
  for (const statement of [
    'input.token = other;', 'delete input.token;', 'input.token++;',
    'customize(input);', 'const alias = input; customize(alias);',
    'console.log(input);', 'schema.parse(input);', 'export { input };'
  ]) {
    const result = scanSource(`import { z } from 'zod';
      const schema = z.object({ token: z.string().optional() });
      const input = { token: process.env.TOKEN };
      ${statement} schema.safeParse(input);
    `, 'env.js');
    assert.equal(result.complete, false, statement);
    assert.ok(result.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'), statement);
    assert.deepEqual(requirements(result), [['TOKEN', 'process', false]], statement);
  }
  const mutable = scanSource(`import { z } from 'zod'; let input = { token: process.env.TOKEN };
    z.object({ token: z.string().optional() }).parse(input);`, 'env.js');
  assert.equal(mutable.complete, false);
  assert.deepEqual(requirements(mutable), [['TOKEN', 'process', false]]);
});

test('unstable maps and schema shapes cannot make a mapped read optional', () => {
  for (const input of [
    '{ token: process.env.TOKEN, ...other }', '{ ...other, token: process.env.TOKEN }',
    '{ token: process.env.TOKEN, token: other }', '{ token: process.env.TOKEN, [name]: other }',
    '{ token: process.env.TOKEN, get extra() { return other; } }'
  ]) {
    const result = scanSource(`import { z } from 'zod';
      z.object({ token: z.string().optional() }).parse(${input});`, 'env.js');
    assert.equal(result.complete, false, input);
    assert.deepEqual(requirements(result), [['TOKEN', 'process', false]], input);
  }
  for (const shape of ['{ token: z.string().optional(), ...other }', '{ token: z.string().optional(), token: z.string() }']) {
    const result = scanSource(`import { z } from 'zod'; z.object(${shape}).parse({ token: process.env.TOKEN });`, 'env.js');
    assert.equal(result.complete, false);
    assert.deepEqual(requirements(result), [['TOKEN', 'process', false]]);
  }
});

test('unsupported mapped fields and parse options remain incomplete without inferred names', () => {
  for (const call of [
    'schema.parse({ token: process.env.TOKEN, label: transform(process.env.LABEL) })',
    'schema.parse({ token: process.env.TOKEN }, { errorMap: fn })',
    'schema.parse({ token: process.env.TOKEN, label: "private-local-label" })'
  ]) {
    const result = scanSource(`import { z } from 'zod';
      const schema = z.object({ token: z.string(), label: z.string().optional() }); ${call};`, 'env.js');
    assert.equal(result.complete, false, call);
    assert.ok(result.usages.every(u => ['TOKEN', 'LABEL'].includes(u.name)), call);
    assert.ok(!JSON.stringify(result).includes('private-local-label'));
  }
  for (const input of [
    '{ token: transform(process.env.TOKEN) }',
    '{ get token() { return process.env.TOKEN; } }',
    '{ token: { nested: process.env.TOKEN } }'
  ]) {
    for (const declaration of ['', `const input = ${input};`]) {
      const result = scanSource(`import { z } from 'zod'; ${declaration}
        z.object({ token: z.string().optional() }).parse(${declaration ? 'input' : input});`, 'env.js');
      assert.equal(result.complete, false, input);
      assert.deepEqual(requirements(result), [['TOKEN', 'process', false]], input);
    }
  }
  const arbitrary = scanSource(`import { z } from 'zod';
    z.object({ token: z.string().optional() }).parse({ token: arbitraryValue });
    z.object({ token: z.string().optional() }).parse({ token: function(process) { return process.env.TOKEN; } });`, 'env.js');
  // The first input has no environment contract. The second is independently
  // unknown because process is shadowed; neither invents a TOKEN requirement.
  assert.equal(arbitrary.complete, false);
  assert.deepEqual(arbitrary.usages, []);
  assert.deepEqual(arbitrary.findings.map(f => f.rule), ['SOURCE_SCOPE_UNRESOLVED']);
});

test('outer optional accepts missing input while inner custom Zod work remains unknown', () => {
  for (const input of ['process.env', '{ TOKEN: process.env.TOKEN }']) {
    for (const wrapper of ['optional', 'nullish']) {
      const result = scanSource(`import { z } from 'zod';
        z.object({ TOKEN: z.string().refine(fn).transform(fn).${wrapper}() }).parse(${input});`, 'env.js');
      assert.equal(result.complete, false);
      assert.deepEqual(requirements(result), [['TOKEN', 'process', true]]);
    }
  }
  const outerRefine = scanSource(`import { z } from 'zod';
    z.object({ token: z.string().optional().refine(fn) }).parse({ token: process.env.TOKEN });`, 'env.js');
  assert.equal(outerRefine.complete, false);
  assert.deepEqual(requirements(outerRefine), [['TOKEN', 'process', false]]);
});

test('pinned bulletproof-react mapping fixes all three requiredness mismatches while exposing custom work', async () => {
  const cases = JSON.parse(await fs.readFile(new URL('../benchmarks/source-cases.json', import.meta.url), 'utf8'));
  const entry = cases.find(item => item.name.startsWith('real-world: alan2207/bulletproof-react'));
  const result = scanSource(entry.source, entry.file);
  assert.equal(result.complete, false);
  assert.deepEqual(result.usages.map(u => [u.name, !u.optional]), Object.entries(entry.required));
  assert.deepEqual(result.findings.map(f => f.rule), ['SOURCE_UNSUPPORTED']);
});
