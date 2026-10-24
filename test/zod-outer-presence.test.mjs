import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanSource } from '../src/source.mjs';
import { scanProject } from '../src/scan.mjs';
import { makePlan, formatReport } from '../src/format.mjs';
import { fixExample, fixCompose } from '../src/fix.mjs';
import { compareProjects, formatComparisonMarkdown } from '../src/compare.mjs';
import { fixture } from './helpers.mjs';

const cases = JSON.parse(await fs.readFile(new URL('./fixtures/zod-outer-presence.json', import.meta.url), 'utf8'));
const pipeline = 'z.string().transform(v => v.split(",")).pipe(z.array(z.string()))';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const imports = 'import { z } from "zod";';
const standalone = (field, input = 'process.env', key = 'TOKEN') => `${imports} z.object({ ${key}: ${field} }).parse(${input});`;
const t3 = (field, runtime = '{ token: process.env.TOKEN }', extra = '') => `${imports}
  import { createEnv } from '@t3-oss/env-core';
  createEnv({ server: { token: ${field} }, runtimeEnv: ${runtime}, ${extra} });`;
const noCanary = value => assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /ZOD_(?:CALLBACK|DEFAULT|CATCH|LOCAL|EXAMPLE|COMPOSE)_CANARY/);

for (const entry of cases) test(`Zod presence boundary: ${entry.id}`, () => {
  for (const source of [standalone(entry.field), standalone(entry.field, '{ token: process.env.TOKEN }', 'token'), t3(entry.field)]) {
    const result = scanSource(source, 'env.ts');
    assert.equal(result.complete, false);
    assert.ok(result.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'));
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', entry.optional]]);
    noCanary(result);
  }
});

test('pipeline presence inference verifies ESM/CommonJS bindings and initializer scopes', () => {
  for (const [setup, z] of [
    ['import { z as schema } from "zod";', 'schema'],
    ['import * as z from "zod/v3";', 'z'],
    ['import z from "zod/v4";', 'z'],
    ['const { z: schema } = require("zod");', 'schema'],
    ['const z = require("zod");', 'z'],
    ['', 'require("zod")']
  ]) {
    const result = scanSource(`${setup} const schemaObject = ${z}.object({ TOKEN: ${z}.string().pipe(${z}.string()).optional() });
      function check(z) { schemaObject.parse(process.env); }`, 'env.ts');
    assert.equal(result.complete, false);
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', true]]);
  }
  for (const field of ['local.string().pipe(local.string()).optional()', 'z.string().pipe(local.string()).optional()']) {
    const result = scanSource(`${imports} const local = { string() { return this; }, pipe() { return this; }, optional() { return this; } };
      z.object({ TOKEN: ${field} }).parse(process.env);`, 'env.ts');
    assert.equal(result.complete, false);
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', false]]);
  }
  for (const setup of ['function check(z) {', 'function check(require) { const z = require("zod");']) {
    const result = scanSource(`${imports} ${setup} z.object({ FAKE: z.string().pipe(z.string()).optional() }).parse({ FAKE: process.env.TOKEN }); }`, 'env.ts');
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', false]]);
  }
});

test('T3 pipeline optionality applies only to mapped reads, retaining independent reads inside options', () => {
  for (const runtime of ['{ token: process.env.TOKEN }', 'process.env']) {
    const result = scanSource(t3(`${pipeline}.optional()`, runtime,
      'onValidationError: () => { throw new Error(process.env.TOKEN); }'), 'env.ts');
    assert.equal(result.complete, false);
    const reads = result.usages.filter(u => u.name === 'TOKEN');
    assert.deepEqual(reads.map(u => u.optional), runtime === 'process.env' ? [false] : [true, false]);
    assert.ok(reads.some(u => !u.optional));
  }
  for (const make of [standalone, field => t3(field)]) {
    const result = scanSource(make(`${pipeline}.optional()`) + '\nprocess.env.TOKEN;', 'env.ts');
    assert.deepEqual(result.usages.filter(u => u.name === 'TOKEN').map(u => u.optional), [true, false]);
  }
  for (const runtime of ['{ TOKEN: process.env.TOKEN }', 'process.env']) {
    const source = `${imports} import { createEnv } from '@t3-oss/env-core';
      createEnv({ server: { TOKEN: ${pipeline}.optional() }, runtimeEnv: ${runtime},
        onValidationError: () => { throw new Error(process.env.TOKEN); } });`;
    const result = scanSource(source, 'env.ts');
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', true], ['TOKEN', false]]);
  }
});

test('T3 CommonJS pipeline schemas map renamed fields and retain external read requirements in reports', async t => {
  for (const setup of [
    'const { z } = require("zod"); const { createEnv } = require("@t3-oss/env-core");',
    'const z = require("zod/v3"); const t3 = require("@t3-oss/env-nextjs");'
  ]) {
    const call = setup.includes('const t3') ? 't3.createEnv' : 'createEnv';
    const result = scanSource(`${setup} ${call}({server: { token: ${pipeline}.nullish() }, runtimeEnv: { token: process.env.TOKEN } });`, 'env.js');
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', true]]);
    assert.equal(result.complete, false);
  }
  const root = await fixture(t, { 'src/app.ts': `${imports} import { createEnv } from '@t3-oss/env-core';
    createEnv({server: { TOKEN: ${pipeline}.optional() }, runtimeEnv: { TOKEN: process.env.TOKEN },
      onValidationError: () => { throw new Error(process.env.TOKEN); } });`, '.env.example': 'TOKEN=\n' });
  const report = await scanProject(root, { noValues: true });
  assert.equal(report.variables[0].required, true);
  assert.deepEqual(report.variables[0].usages.map(u => u.optional), [true, false]);
  assert.equal(report.scope.complete, false);
});

test('T3 pipeline mappings retain optionality for supported module forms and reject unstable maps', () => {
  for (const module of ['zod', 'zod/v3', 'zod/v4', 'zod/v4-mini']) {
    const source = t3('z.coerce.string().pipe(z.string()).nullish()').replace('from "zod"', `from "${module}"`);
    const result = scanSource(source, 'env.ts');
    // Mini's method-chain syntax is already outside its supported runtime API.
    assert.equal(result.complete, false);
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', module !== 'zod/v4-mini']]);
  }
  for (const runtime of ['{ token: process.env.TOKEN, ...extra }', '{ [key]: process.env.TOKEN }']) {
    const result = scanSource(t3(`${pipeline}.optional()`, runtime), 'env.ts');
    assert.equal(result.complete, false);
    assert.deepEqual(result.usages.map(u => [u.name, u.optional]), [['TOKEN', false]]);
  }
});

test('pipeline optional presence flows through report, documentation, selected Compose, plan, fixes and CLI exits', async t => {
  for (const adapter of [standalone, field => t3(field)]) {
    const source = adapter(`${pipeline}.optional()`);
    const root = await fixture(t, {
      'src/app.ts': source,
      '.env.example': '# ZOD_EXAMPLE_CANARY\n',
      '.env': 'UNRELATED=ZOD_LOCAL_CANARY\n',
      'compose.yaml': 'services:\n  app:\n    image: example\n  other:\n    environment:\n      TOKEN: ZOD_COMPOSE_CANARY\n',
      'envcheck.config.json': { version: 1, sources: ['src'], example: '.env.example', envFiles: ['.env'], compose: { file: 'compose.yaml', service: 'app' } }
    });
    let report = await scanProject(root);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.scope.complete, false);
    assert.equal(report.scope.valuesChecked, true);
    const token = report.variables.find(v => v.name === 'TOKEN');
    assert.equal(token.required, false);
    assert.equal(token.documented, false);
    assert.equal(token.local.state, 'missing');
    assert.equal(token.compose.state, 'missing');
    assert.deepEqual(report.findings.filter(f => f.variable === 'TOKEN').map(f => f.rule), ['UNDOCUMENTED_VARIABLE']);
    const plan = makePlan(report);
    assert.deepEqual(plan.example.append, ['TOKEN=']);
    assert.deepEqual(plan.compose.environment, []);
    assert.ok(plan.actions.some(a => a.rule === 'SOURCE_UNSUPPORTED'));
    const composeBefore = await fs.readFile(path.join(root, 'compose.yaml'));
    const preview = await fixExample(root);
    assert.deepEqual(preview.additions, ['TOKEN']);
    assert.equal(preview.changed, false);
    const repaired = await fixExample(root, { apply: true });
    assert.equal(repaired.changed, true);
    assert.equal(repaired.report.scope.complete, false);
    assert.equal(await fs.readFile(path.join(root, '.env.example'), 'utf8'), '# ZOD_EXAMPLE_CANARY\nTOKEN=\n');
    for (const apply of [false, true]) {
      const fixed = await fixCompose(root, { apply });
      assert.deepEqual(fixed.additions, []);
      assert.equal(fixed.changed, false);
      noCanary(fixed);
    }
    assert.deepEqual(await fs.readFile(path.join(root, 'compose.yaml')), composeBefore);
    assert.equal(await fs.readFile(path.join(root, 'src/app.ts'), 'utf8'), source);
    assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'UNRELATED=ZOD_LOCAL_CANARY\n');
    report = await scanProject(root);
    assert.equal(report.summary.errors, 0);
    for (const strict of [false, true]) {
      const result = spawnSync(process.execPath, [cli, 'scan', root, '--json', ...(strict ? ['--strict'] : [])], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.error, undefined);
      assert.equal(result.status, strict ? 1 : 0);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).scope.complete, false);
      noCanary(result.stdout);
    }
    for (const output of [report, plan, preview, repaired, formatReport(report)]) noCanary(output);
  }
});

test('independent required reads still drive selected-service declaration repair with pipeline schemas', async t => {
  const root = await fixture(t, {
    'src/app.ts': standalone(`${pipeline}.nullish()`) + '\nprocess.env.TOKEN;',
    '.env.example': 'TOKEN=\n',
    'compose.yaml': 'services:\n  app:\n    image: example\n  other:\n    environment:\n      TOKEN: ZOD_COMPOSE_CANARY\n',
    'envcheck.config.json': { version: 1, envFiles: [], compose: { file: 'compose.yaml', service: 'app' } }
  });
  const report = await scanProject(root);
  assert.equal(report.variables[0].required, true);
  assert.ok(report.findings.some(f => f.rule === 'COMPOSE_VARIABLE_MISSING'));
  assert.deepEqual((await fixCompose(root)).additions, ['TOKEN']);
  const fixed = await fixCompose(root, { apply: true });
  assert.equal(fixed.report.variables[0].compose.state, 'declared');
  assert.equal(fixed.report.scope.complete, false);
  assert.match(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), /TOKEN: ZOD_COMPOSE_CANARY/);
  noCanary(fixed);
});

test('compare detects addition and removal of outer pipeline optionality without claiming completeness', async t => {
  for (const adapter of [standalone, field => t3(field)]) {
    const common = { '.env.example': 'TOKEN=\n', 'compose.yaml': 'services:\n  app:\n    image: example\n',
      'envcheck.config.json': { version: 1, envFiles: [], compose: { file: 'compose.yaml', service: 'app' } } };
    const required = await fixture(t, { ...common, 'src/app.ts': adapter(pipeline) });
    const optional = await fixture(t, { ...common, 'src/app.ts': adapter(`${pipeline}.optional()`) });
    for (const [before, after, becomesRequired] of [[required, optional, false], [optional, required, true]]) {
      const report = await compareProjects(before, after);
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.scope.complete, false);
      // The existing contract emits BECAME_REQUIRED only; adding optionality
      // is visible through resolved findings without inventing a new rule ID.
      assert.deepEqual(report.changes.map(c => [c.kind, c.variable]), becomesRequired ? [['BECAME_REQUIRED', 'TOKEN']] : []);
      assert.ok(report[becomesRequired ? 'introduced' : 'resolved'].some(f => f.rule === 'COMPOSE_VARIABLE_MISSING' && f.variable === 'TOKEN'));
      noCanary(report);
      noCanary(formatComparisonMarkdown(report));
    }
  }
});
