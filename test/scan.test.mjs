import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scanProject } from '../src/scan.mjs';
import { fixture } from './helpers.mjs';
import { parseEnvironment, validValue } from '../src/env.mjs';

const rules = report => report.findings.map(f => f.rule);
const composeConfig = { version: 1, sources: ['src'], envFiles: [], compose: { file: 'compose.yaml', service: 'api' } };

test('project usages preserve file/read order, multiplicity, positions and rules without source reads', async t => {
  const root = await fixture(t, {
    'src/app.ts': null,
    'src/01-first.ts': '\uFEFFprocess.env.REPEAT; process.env.REPEAT;\n' +
      "const opt = process.env.REPEAT ?? 'fallback';\n" +
      'process.env.IGNORED; process.env.NODE_ENV;\n' +
      "const optional = process.env.OPTIONAL ?? 'fallback';\n" +
      'process.env.OVERRIDDEN;\n',
    'src/02-second.js': 'const second = process.env.REPEAT;\n' +
      "process.env.OPTIONAL ?? 'fallback';\n",
    '.env.example': 'REPEAT=\nOPTIONAL=\nOVERRIDDEN=\nRULE_ONLY=\nOPTIONAL_RULE=\nCONDITIONAL=\nFLAG=\n',
    'envcheck.config.json': { version: 1, sources: ['src'], envFiles: [], ignore: ['IGNORED'], variables: {
      RULE_ONLY: { required: true, type: 'port' }, OPTIONAL_RULE: { required: false },
      OVERRIDDEN: { required: false }, CONDITIONAL: { when: { variable: 'FLAG', equals: 'enabled' } }
    } }
  });
  const report = await scanProject(root, { noValues: true });
  assert.equal(report.scope.sourceFiles, 2);
  assert.equal(report.scope.complete, false);
  assert.deepEqual(report.variables.map(v => [v.name, v.required]), [
    ['CONDITIONAL', null], ['FLAG', false], ['OPTIONAL', false], ['OPTIONAL_RULE', false],
    ['OVERRIDDEN', false], ['REPEAT', true], ['RULE_ONLY', true]
  ]);
  const usage = (file, line, column, optional) => ({ name: 'REPEAT', kind: 'process', optional, file, line, column });
  assert.deepEqual(report.variables.find(v => v.name === 'REPEAT').usages, [
    usage('src/01-first.ts', 1, 1, false), usage('src/01-first.ts', 1, 21, false),
    usage('src/01-first.ts', 2, 13, true), usage('src/02-second.js', 1, 16, false)
  ]);
  assert.deepEqual(report.variables.find(v => v.name === 'OPTIONAL').usages.map(({file,line,column,optional}) => ({file,line,column,optional})), [
    { file: 'src/01-first.ts', line: 4, column: 18, optional: true },
    { file: 'src/02-second.js', line: 2, column: 1, optional: true }
  ]);
  for (const name of ['CONDITIONAL', 'FLAG', 'OPTIONAL_RULE', 'RULE_ONLY']) assert.deepEqual(report.variables.find(v => v.name === name).usages, []);
  assert.equal(report.variables.find(v => v.name === 'OVERRIDDEN').usages.length, 1);
  assert.equal(report.variables.find(v => v.name === 'RULE_ONLY').type, 'port');
  assert.ok(report.variables.every(v => v.documented && v.local.state === 'not-checked'));
  assert.deepEqual(report.summary, { errors: 0, warnings: 1, info: 0 });
  assert.deepEqual(report.findings.map(({rule,variable,locations}) => ({rule,variable,locations})), [
    { rule: 'CONDITION_UNRESOLVED', variable: 'CONDITIONAL', locations: [{ file: '.env.example', line: 6, column: 1 }] }
  ]);
});

test('standalone Zod requirements reach project reports and selected Compose service', async t => {
  const root = await fixture(t, {
    'src/app.ts': `import { z } from 'zod';
      const schema = z.object({ API_KEY: z.string().min(1), PORT: z.number().default(3000),
        OPTIONAL_LABEL: z.string().optional() });
      schema.parse(process.env);`,
    '.env.example': 'PORT=\nOPTIONAL_LABEL=\n', '.env': 'PORT=3000\n',
    'compose.yaml': 'services:\n  api:\n    image: example\n    environment:\n      PORT: "3000"\n',
    'envcheck.config.json': composeConfig
  });
  const report = await scanProject(root);
  assert.equal(report.scope.complete, true);
  assert.deepEqual(report.variables.map(v => [v.name, v.required, v.compose.state]), [
    ['API_KEY', true, 'missing'], ['OPTIONAL_LABEL', false, 'missing'], ['PORT', false, 'declared']
  ]);
  assert.deepEqual(report.findings.filter(f => f.severity === 'error').map(f => [f.rule, f.variable]).sort(), [
    ['COMPOSE_VARIABLE_MISSING', 'API_KEY'], ['UNDOCUMENTED_VARIABLE', 'API_KEY']
  ]);
});

test('Zod schema defaults and custom-validator bodies never enter scan output or plans', async t => {
  const root = await fixture(t, {
    'src/app.ts': `import { z } from 'zod'; z.object({
      API_KEY: z.string().default('private-zod-default-sentinel'),
      DYNAMIC: z.string().transform(() => 'private-zod-transform-sentinel')
    }).safeParse(process.env);`,
    '.env.example': 'API_KEY=\nDYNAMIC=\n', '.env': 'API_KEY=private-zod-local-sentinel\n'
  });
  const report = await scanProject(root);
  assert.equal(report.scope.complete, false);
  assert.equal(report.variables.find(v => v.name === 'API_KEY').required, false);
  const { formatReport, makePlan, formatPlan } = await import('../src/format.mjs');
  for (const output of [JSON.stringify(report), formatReport(report), JSON.stringify(makePlan(report)), formatPlan(makePlan(report))]) {
    assert.ok(!output.includes('private-zod-'));
  }
});

test('envalid schema requirements reach project reports without exposing defaults', async t => {
  const root = await fixture(t, {
    'src/app.ts': `import { cleanEnv, str, port } from 'envalid';
      cleanEnv(process.env, { API_KEY: str(), PORT: port({ default: 3000 }),
        TOKEN: str({ devDefault: 'private-default-sentinel' }) });`,
    '.env.example': 'API_KEY=\nPORT=\nTOKEN=\n',
    '.env': 'PORT=\n'
  });
  const report = await scanProject(root);
  assert.equal(report.scope.complete, false);
  assert.equal(report.variables.find(v => v.name === 'API_KEY').required, true);
  assert.equal(report.variables.find(v => v.name === 'PORT').required, false);
  assert.equal(report.variables.find(v => v.name === 'TOKEN').required, true);
  assert.ok(report.findings.some(f => f.rule === 'REQUIRED_VALUE_MISSING' && f.variable === 'API_KEY'));
  assert.ok(report.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'));
  assert.ok(!JSON.stringify(report).includes('private-default-sentinel'));
});

test('broken demo has actionable findings; fixed demo passes structural checks', async () => {
  const broken = await scanProject(new URL('../examples/broken', import.meta.url));
  assert.ok(rules(broken).includes('UNDOCUMENTED_VARIABLE'));
  assert.ok(rules(broken).includes('COMPOSE_VARIABLE_MISSING'));
  const fixed = await scanProject(new URL('../examples/fixed', import.meta.url));
  assert.equal(fixed.summary.errors, 0);
  assert.equal(fixed.summary.warnings, 0);
  assert.equal(fixed.scope.valuesChecked, false);
  assert.equal(fixed.scope.complete, true);
});

test('invalid values and credentials never appear in JSON, text or plans', async t => {
  const secret = 'sentinel-private-value-DO-NOT-PRINT';
  const root = await fixture(t, { '.env': `API_KEY=${secret}\n`, 'envcheck.config.json': { version: 1, variables: { API_KEY: { type: 'port' } } } });
  const report = await scanProject(root);
  const { formatReport, makePlan, formatPlan } = await import('../src/format.mjs');
  assert.ok(rules(report).includes('INVALID_VALUE_TYPE'));
  for (const output of [JSON.stringify(report), formatReport(report), JSON.stringify(makePlan(report)), formatPlan(makePlan(report))]) assert.ok(!output.includes(secret));
});

test('env files merge in order; provenance points to winner', async t => {
  const root = await fixture(t, { '.env': 'API_KEY=\n', 'local.env': 'API_KEY=local-only-value\n', 'envcheck.config.json': { version: 1, envFiles: ['.env', 'local.env'] } });
  const report = await scanProject(root);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.variables[0].local.source.file, 'local.env');
  assert.ok(!JSON.stringify(report).includes('local-only-value'));
});

test('missing and empty required settings are distinct from skipped validation', async t => {
  const root = await fixture(t, { '.env': 'API_KEY=\n' });
  const normal = await scanProject(root);
  assert.ok(rules(normal).includes('REQUIRED_VALUE_MISSING'));
  assert.equal(normal.variables[0].local.state, 'empty');
  const structural = await scanProject(root, { noValues: true });
  assert.equal(structural.scope.valuesChecked, false);
  assert.equal(structural.variables[0].local.state, 'not-checked');
});

test('optional code fallback permits absence; explicit required overrides it', async t => {
  const root = await fixture(t, { 'src/app.ts': 'const key = process.env.API_KEY ?? "fallback";', '.env': 'OTHER=x\n' });
  assert.equal((await scanProject(root)).summary.errors, 0);
  await fs.writeFile(path.join(root, 'envcheck.config.json'), JSON.stringify({ version: 1, variables: { API_KEY: { required: true } } }));
  assert.ok(rules(await scanProject(root)).includes('REQUIRED_VALUE_MISSING'));
});

test('conditional requirement activates, deactivates and remains unknown without values', async t => {
  const root = await fixture(t, { '.env.example': 'API_KEY=\nENABLED=false\n', '.env': 'ENABLED=false\n', 'envcheck.config.json': { version: 1, variables: { API_KEY: { when: { variable: 'ENABLED', equals: 'true' } } } } });
  assert.equal((await scanProject(root)).summary.errors, 0);
  await fs.writeFile(path.join(root, '.env'), 'ENABLED=true\n');
  assert.ok(rules(await scanProject(root)).includes('REQUIRED_VALUE_MISSING'));
  const structural = await scanProject(root, { noValues: true });
  assert.ok(rules(structural).includes('CONDITION_UNRESOLVED'));
  assert.equal(structural.scope.complete, false);
});

test('built-ins are kind-specific; ignored variables use exact names', async t => {
  const root = await fixture(t, { 'src/app.ts': 'const x = process.env.NODE_ENV; const y = import.meta.env.MODE; const z = process.env.MODE; const q = process.env.IGNORED;', '.env.example': 'MODE=\n', 'envcheck.config.json': { version: 1, ignore: ['IGNORED'], envFiles: [] } });
  const report = await scanProject(root);
  assert.deepEqual(report.variables.map(v => v.name), ['MODE']);
  assert.equal(report.summary.errors, 0);
});

test('Compose .env is not automatically a container environment', async t => {
  const root = await fixture(t, { '.env': 'API_KEY=local-key\n', 'compose.yaml': 'services:\n  api:\n    image: node:22\n', 'envcheck.config.json': composeConfig });
  const report = await scanProject(root);
  assert.ok(rules(report).includes('COMPOSE_VARIABLE_MISSING'));
});

test('Compose map and list declare variables, including host pass-through', async t => {
  for (const environment of ['      API_KEY: ${API_KEY}\n', '      - API_KEY=${API_KEY}\n', '      - API_KEY\n']) {
    const root = await fixture(t, { 'compose.yaml': `services:\n  api:\n    environment:\n${environment}`, 'envcheck.config.json': composeConfig });
    const report = await scanProject(root);
    assert.equal(report.summary.errors, 0);
    assert.equal(report.variables[0].compose.state, 'declared');
  }
});

test('Compose env_file is relative to Compose directory, environment overrides it', async t => {
  const root = await fixture(t, { 'deploy/runtime.env': 'API_KEY=placeholder-test\n', 'deploy/compose.yaml': 'services:\n  api:\n    env_file: runtime.env\n    environment:\n      API_KEY: ""\n', 'envcheck.config.json': { ...composeConfig, compose: { file: 'deploy/compose.yaml', service: 'api' } } });
  const report = await scanProject(root);
  assert.ok(rules(report).includes('COMPOSE_VALUE_EMPTY'));
  assert.equal(report.variables[0].compose.source.file, 'deploy/compose.yaml');
});

test('one source scope maps only to its explicitly selected service', async t => {
  const root = await fixture(t, { 'compose.yaml': 'services:\n  api:\n    environment:\n      API_KEY: ${API_KEY}\n  worker:\n    image: worker\n', 'envcheck.config.json': composeConfig });
  assert.equal((await scanProject(root)).summary.errors, 0);
});

test('Compose long env_file object syntax supports path, required and format', async t => {
  const present = await fixture(t, {
    'deploy/runtime.env': 'API_KEY=placeholder-test\n',
    'deploy/compose.yaml': 'services:\n  api:\n    env_file:\n      - path: runtime.env\n        required: true\n        format: raw\n      - path: optional-missing.env\n        required: false\n',
    'envcheck.config.json': { ...composeConfig, compose: { file: 'deploy/compose.yaml', service: 'api' } }
  });
  const presentReport = await scanProject(present);
  assert.equal(presentReport.scope.complete, true);
  assert.equal(presentReport.summary.errors, 0);
  assert.equal(presentReport.variables[0].compose.kind, 'env-file');

  const missingOptionalOnly = await fixture(t, {
    'compose.yaml': 'services:\n  api:\n    env_file:\n      - path: optional.env\n        required: false\n',
    'envcheck.config.json': composeConfig
  });
  const missingOptionalReport = await scanProject(missingOptionalOnly);
  assert.equal(missingOptionalReport.scope.complete, true);
  assert.deepEqual(rules(missingOptionalReport), ['COMPOSE_VARIABLE_MISSING']);

  const missingRequiredObject = await fixture(t, {
    'compose.yaml': 'services:\n  api:\n    env_file:\n      - path: missing.env\n        required: true\n',
    'envcheck.config.json': composeConfig
  });
  const missingRequiredReport = await scanProject(missingRequiredObject);
  assert.equal(missingRequiredReport.scope.complete, false);
  assert.ok(rules(missingRequiredReport).includes('COMPOSE_ENV_FILE_MISSING'));
});

test('unsupported YAML cannot produce a complete successful result', async t => {
  for (const text of [
    'services:\n  api:\n    extends: base\n',
    'services:\n  api:\n    env_file:\n      - path: ${DYNAMIC_ENV}\n',
    'services:\n  api:\n    env_file:\n      - path: local.env\n        format: custom\n',
    'services:\n  api:\n    environment: !reset {}\n',
    'services:\n  api:\n    image: a\n---\nservices:\n  api:\n    image: b\n',
    'services:\n  api:\n    image: a\n    image: b\n',
    'services:\n  api:\n    environment: { API_KEY: unclosed\n'
  ]) {
    const root = await fixture(t, { 'compose.yaml': text, 'envcheck.config.json': composeConfig });
    const report = await scanProject(root);
    assert.equal(report.scope.complete, false, text);
    assert.ok(report.summary.warnings > 0);
    assert.ok(!rules(report).includes('COMPOSE_VARIABLE_MISSING'));
  }
});

test('anchors, aliases and merge keys are resolved with explicit keys winning', async t => {
  const text = 'x-common: &common\n  environment:\n    API_KEY: ""\n  image: base\nservices:\n  api:\n    <<: *common\n    environment:\n      API_KEY: ${API_KEY}\n';
  const root = await fixture(t, { 'compose.yaml': text, 'envcheck.config.json': composeConfig });
  const report = await scanProject(root);
  assert.equal(report.scope.complete, true);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.variables[0].compose.source.line, 9);
  const merged = await fixture(t, { 'compose.yaml': 'x-env: &env\n  API_KEY: ${API_KEY}\nservices:\n  api:\n    environment: *env\n', 'envcheck.config.json': composeConfig });
  const mergedReport = await scanProject(merged);
  assert.equal(mergedReport.scope.complete, true);
  assert.equal(mergedReport.summary.errors, 0);
});

test('malformed and flow-style input does not leak YAML values in findings', async t => {
  const marker = 'SECRET-COMPOSE-MARKER';
  for (const text of [`services:\n  api:\n    environment: { API_KEY: ${marker}\n`, `services:\n  api:\n    environment: { API_KEY: ${marker} }\n`, `services:\n  api:\n    environment:\n      API_KEY: ${marker}\n      API_KEY: ${marker}\n`]) {
    const root = await fixture(t, { 'compose.yaml': text, 'envcheck.config.json': composeConfig });
    const report = await scanProject(root);
    assert.ok(!JSON.stringify(report).includes(marker));
  }
});

test('JSON Compose input is parsed as YAML 1.2', async t => {
  const root = await fixture(t, { 'compose.yaml': { services: { api: { environment: { API_KEY: '${API_KEY}' } } } }, 'envcheck.config.json': composeConfig });
  assert.equal((await scanProject(root)).summary.errors, 0);
});

test('duplicate dotenv keys report locations; quoted multiline content is not a key', () => {
  const result = parseEnvironment('KEY=one\nKEY=two\nCERT="line1\nFAKE=not-a-key\nline3"\n', '.env');
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].locations.map(l => l.line), [1, 2]);
  assert.equal(result.definitions.has('FAKE'), false);

  for (const quote of ['"', "'", '`']) {
    const withBackslash = parseEnvironment(`FIRST=${quote}value with \\${quote}\nAPI_KEY=first\nAPI_KEY=second\nLAST=${quote}end${quote}\n`, '.env');
    assert.equal(withBackslash.findings.length, 1, quote);
    assert.equal(withBackslash.findings[0].rule, 'DUPLICATE_ENV_KEY', quote);
    assert.deepEqual(withBackslash.findings[0].locations.map(l => l.line), [2, 3], quote);
    assert.equal(withBackslash.definitions.get('API_KEY').line, 3, quote);
    assert.equal(withBackslash.definitions.get('LAST').line, 4, quote);
  }
});

test('explicit when.variable referencing NODE_ENV brings it into the local configuration contract', async t => {
  const root = await fixture(t, {
    '.env.example': 'API_KEY=\n',
    '.env': 'NODE_ENV=production\nAPI_KEY=present\n',
    'envcheck.config.json': { version: 1, variables: { API_KEY: { when: { variable: 'NODE_ENV', equals: 'production' } } } }
  });
  const report = await scanProject(root);
  assert.ok(report.variables.some(v => v.name === 'NODE_ENV'));
  assert.ok(report.findings.some(f => f.rule === 'UNDOCUMENTED_VARIABLE' && f.variable === 'NODE_ENV'));
});

test('type validation rejects invalid ports, booleans and non-finite numbers', () => {
  for (const value of ['0', '65536', '3000x', '-1', '3.5']) assert.equal(validValue(value, 'port'), false);
  assert.equal(validValue('3000', 'port'), true);
  assert.equal(validValue('yes', 'boolean'), false);
  assert.equal(validValue('false', 'boolean'), true);
  assert.equal(validValue('Infinity', 'number'), false);
  assert.equal(validValue('https://example.test', 'url'), true);
  assert.equal(validValue('postgres://db/app', 'url'), true);
});

test('source and configuration paths cannot leave the selected root', async t => {
  const root = await fixture(t, { 'envcheck.config.json': { version: 1, sources: ['../outside'] } });
  await assert.rejects(scanProject(root), /escapes/);
});

test('unknown configuration options fail instead of silently ignoring typos', async t => {
  const root = await fixture(t, { 'envcheck.config.json': { version: 1, source: ['src'] } });
  await assert.rejects(scanProject(root), /Unknown configuration/);
});
