import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { patchComposeService } from '../src/compose.mjs';
import { fixCompose } from '../src/fix.mjs';
import { scanProject } from '../src/scan.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const config = { version: 1, sources: ['src'], envFiles: [], compose: { file: 'compose.yaml', service: 'api' } };

test('Compose precedence uses later env_file entries, then selected service environment including empty and host entries', async t => {
  const root = await fixture(t, {
    'src/app.ts': 'process.env.API_KEY; process.env.SECOND_KEY; process.env.HOST_KEY;',
    '.env.example': 'API_KEY=\nSECOND_KEY=\nHOST_KEY=\n',
    'first.env': 'API_KEY=\nSECOND_KEY=first-sentinel\nHOST_KEY=first-sentinel\n',
    'second.env': 'API_KEY=second-sentinel\nSECOND_KEY=\nHOST_KEY=second-sentinel\n',
    'compose.yaml': 'services:\n  api:\n    env_file: [first.env, second.env]\n    environment:\n      API_KEY: ""\n      HOST_KEY:\n  worker:\n    environment:\n      API_KEY: worker-sentinel\n      SECOND_KEY: worker-sentinel\n',
    'envcheck.config.json': config
  });
  const report = await scanProject(root, { noValues: true });
  assert.equal(report.scope.complete, true);
  assert.equal(report.scope.valuesChecked, false);
  assert.deepEqual(report.variables.map(v => [v.name, v.compose.kind, v.compose.source.file, v.local.state]), [
    ['API_KEY', 'literal', 'compose.yaml', 'not-checked'],
    ['HOST_KEY', 'host-pass-through', 'compose.yaml', 'not-checked'],
    ['SECOND_KEY', 'env-file', 'second.env', 'not-checked']
  ]);
  assert.deepEqual(report.findings.filter(f => f.rule === 'COMPOSE_VALUE_EMPTY').map(f => f.variable), ['API_KEY', 'SECOND_KEY']);
  assert.ok(!JSON.stringify(report).includes('sentinel'));
});

test('raw env_file preserves literal quotes, hash and dollar signs when classifying empty declarations', async t => {
  const root = await fixture(t, {
    'src/app.ts': 'process.env.API_KEY; process.env.EMPTY_KEY; process.env.HASH_KEY; process.env.DOLLAR_KEY; process.env.SPACE_KEY;',
    '.env.example': 'API_KEY=\nEMPTY_KEY=\nHASH_KEY=\nDOLLAR_KEY=\nSPACE_KEY=\n',
    'runtime.env': '\uFEFF# raw comment\r\nAPI_KEY=""\r\nEMPTY_KEY=\r\nHASH_KEY= # raw-sentinel\r\nDOLLAR_KEY=${RAW_VALUE}\r\nSPACE_KEY=   \r\n',
    'compose.yaml': 'services:\n  api:\n    env_file:\n      - path: runtime.env\n        format: raw\n',
    'envcheck.config.json': config
  });
  const report = await scanProject(root, { noValues: true });
  assert.equal(report.scope.complete, true);
  assert.deepEqual(report.findings.filter(f => f.rule === 'COMPOSE_VALUE_EMPTY').map(f => f.variable), ['EMPTY_KEY']);
  assert.equal(report.variables.find(v => v.name === 'API_KEY').compose.source.line, 2);
  assert.ok(!JSON.stringify(report).includes('raw-sentinel'));
  assert.ok(!JSON.stringify(report).includes('RAW_VALUE'));
});

test('raw env_file duplicates retain provenance and unresolved lines mark analysis incomplete', async t => {
  const root = await fixture(t, {
    'runtime.env': 'API_KEY=raw-sentinel\nAPI_KEY=\nHOST_KEY\n',
    'compose.yaml': 'services:\n  api:\n    env_file:\n      - path: runtime.env\n        format: raw\n',
    'envcheck.config.json': config
  });
  const report = await scanProject(root, { noValues: true });
  assert.equal(report.scope.complete, false);
  assert.equal(report.variables[0].compose.source.line, 2);
  assert.ok(report.findings.some(f => f.rule === 'COMPOSE_VALUE_EMPTY'));
  assert.deepEqual(report.findings.find(f => f.rule === 'DUPLICATE_ENV_KEY').locations.map(l => l.line), [1, 2]);
  assert.ok(report.findings.some(f => f.rule === 'COMPOSE_UNSUPPORTED'));
  assert.ok(!JSON.stringify(report).includes('raw-sentinel'));
});

test('unresolved raw host entries invalidate stale empty declarations but explicit environment still wins', async t => {
  for (const environment of ['', '    environment:\n      API_KEY: ""\n']) {
    const root = await fixture(t, {
      'first.env': 'API_KEY=\n',
      'runtime.env': 'API_KEY\n',
      'compose.yaml': 'services:\n  api:\n    env_file:\n      - first.env\n      - path: runtime.env\n        format: raw\n' + environment,
      'envcheck.config.json': config
    });
    const report = await scanProject(root, { noValues: true });
    assert.equal(report.scope.complete, false);
    assert.equal(report.variables[0].compose.state, environment ? 'declared' : 'unknown');
    assert.equal(report.findings.some(f => f.rule === 'COMPOSE_VALUE_EMPTY'), Boolean(environment));
  }
});

test('nested YAML merges preserve the winning declaration provenance', async t => {
  const root = await fixture(t, {
    'compose.yaml': 'x-env: &env\n  API_KEY: ""\nx-first: &first\n  <<: *env\nx-second: &second\n  API_KEY: second-sentinel\nservices:\n  api:\n    environment:\n      <<: [*first, *second]\n',
    'envcheck.config.json': config
  });
  const report = await scanProject(root, { noValues: true });
  assert.equal(report.scope.complete, true);
  assert.equal(report.variables[0].compose.source.line, 2);
  assert.equal(report.findings.find(f => f.rule === 'COMPOSE_VALUE_EMPTY').locations[0].line, 2);
});

test('Compose repair refuses shared anchor targets before changing any service', async t => {
  for (const text of [
    'services: &all\n  api:\n    image: app\nx-copy: *all\n',
    'services:\n  api: &shared\n    image: app\n  worker: *shared\n',
    'services:\n  api:\n    environment: &shared\n      PORT: "3000"\n  worker:\n    environment: *shared\n',
    'services:\n  api:\n    environment: &shared\n      - PORT=3000\n  worker:\n    environment: *shared\n'
  ]) {
    const root = await fixture(t, { 'compose.yaml': text, 'envcheck.config.json': config });
    for (const apply of [false, true]) {
      await assert.rejects(fixCompose(root, { apply }), /shared.*anchor/i);
      assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), text);
    }
  }
});

test('Compose repair refuses merge-inherited environment mappings', async t => {
  const text = 'x-env: &env\n  PORT: "3000"\nservices:\n  api:\n    environment:\n      <<: *env\n';
  const root = await fixture(t, { 'compose.yaml': text, 'envcheck.config.json': config });
  await assert.rejects(fixCompose(root, { apply: true }), /merge/i);
  assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), text);
});

test('repair of an explicit null environment preserves its comment and CRLF and is idempotent', async t => {
  const root = await fixture(t, {
    'compose.yaml': '# TOP\r\nservices:\r\n  api:\r\n    environment: # KEEP ENVIRONMENT COMMENT\r\n  worker:\r\n    image: worker\r\n',
    'envcheck.config.json': config
  });
  const applied = await fixCompose(root, { apply: true });
  assert.equal(applied.report.summary.errors, 0);
  const updated = await fs.readFile(path.join(root, 'compose.yaml'), 'utf8');
  assert.ok(updated.includes('environment: # KEEP ENVIRONMENT COMMENT\r\n'));
  assert.ok(updated.includes('# TOP\r\n'));
  assert.ok(!/(?<!\r)\n/.test(updated));
  assert.equal((await fixCompose(root, { apply: true })).changed, false);
  assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), updated);
});

test('Compose repair can edit an unshared anchor and leaves JSON input valid JSON', async t => {
  const root = await fixture(t, {
    'compose.yaml': 'services:\n  api: &unused\n    environment:\n      PORT: "3000"\n',
    'envcheck.config.json': config
  });
  assert.equal((await fixCompose(root, { apply: true })).report.summary.errors, 0);
  assert.ok((await fs.readFile(path.join(root, 'compose.yaml'), 'utf8')).includes('&unused'));
  const jsonRoot = await fixture(t, {
    'compose.json': { services: { api: { image: 'app' }, worker: { image: 'worker' } } },
    'envcheck.config.json': { ...config, compose: { file: 'compose.json', service: 'api' } }
  });
  assert.equal((await fixCompose(jsonRoot, { apply: true })).report.summary.errors, 0);
  const data = JSON.parse(await fs.readFile(path.join(jsonRoot, 'compose.json'), 'utf8'));
  assert.deepEqual(data.services.worker, { image: 'worker' });
  assert.deepEqual(data.services.api.environment, { API_KEY: '${API_KEY:?Set API_KEY locally}' });
});

test('unsupported higher-priority service.environment entries invalidate only the affected env_file key', async t => {
  for (const environment of [
    '    environment:\n      API_KEY:\n        - invalid-override\n',
    '    environment:\n      - API_KEY: ${API_KEY}\n',
    '    environment:\n      - " API_KEY=bad"\n'
  ]) {
    const root = await fixture(t, {
      'src/app.ts': 'process.env.API_KEY; process.env.OTHER_KEY;',
      '.env.example': 'API_KEY=\nOTHER_KEY=\n',
      'runtime.env': 'API_KEY=\nOTHER_KEY=present-sentinel\n',
      'compose.yaml': `services:\n  api:\n    env_file: runtime.env\n${environment}`,
      'envcheck.config.json': config
    });
    const report = await scanProject(root, { noValues: true });
    assert.equal(report.scope.complete, false);
    assert.equal(report.variables.find(v => v.name === 'API_KEY').compose.state, 'unknown');
    assert.equal(report.variables.find(v => v.name === 'OTHER_KEY').compose.state, 'declared');
    assert.equal(report.findings.some(f => f.rule === 'COMPOSE_VALUE_EMPTY'), false);
    assert.ok(report.findings.some(f => f.rule === 'COMPOSE_UNSUPPORTED'));
  }

  const wholeInvalid = await fixture(t, {
    'src/app.ts': 'process.env.API_KEY; process.env.OTHER_KEY;',
    '.env.example': 'API_KEY=\nOTHER_KEY=\n',
    'runtime.env': 'API_KEY=\nOTHER_KEY=present-sentinel\n',
    'compose.yaml': 'services:\n  api:\n    env_file: runtime.env\n    environment: unsupported\n',
    'envcheck.config.json': config
  });
  const wholeReport = await scanProject(wholeInvalid, { noValues: true });
  assert.equal(wholeReport.scope.complete, false);
  assert.deepEqual(wholeReport.variables.map(v => [v.name, v.compose.state]), [
    ['API_KEY', 'unknown'],
    ['OTHER_KEY', 'unknown']
  ]);
  assert.equal(wholeReport.findings.some(f => f.rule === 'COMPOSE_VALUE_EMPTY'), false);
});

test('later env_file layers distinguish optional required:false, missing required:true and unknown sources', async t => {
  const optionalMissing = await fixture(t, {
    'src/app.ts': 'process.env.API_KEY; process.env.SECOND_KEY; process.env.MISSING_KEY;',
    '.env.example': 'API_KEY=\nSECOND_KEY=\nMISSING_KEY=\n',
    'first.env': 'API_KEY=\nSECOND_KEY=ok-sentinel\n',
    'compose.yaml': 'services:\n  api:\n    env_file:\n      - first.env\n      - path: optional.env\n        required: false\n',
    'envcheck.config.json': config
  });
  const optReport = await scanProject(optionalMissing, { noValues: true });
  assert.equal(optReport.scope.complete, true);
  assert.deepEqual(optReport.variables.map(v => [v.name, v.compose.state]), [
    ['API_KEY', 'declared'],
    ['MISSING_KEY', 'missing'],
    ['SECOND_KEY', 'declared']
  ]);
  assert.deepEqual(optReport.findings.map(f => [f.rule, f.variable]), [
    ['COMPOSE_VALUE_EMPTY', 'API_KEY'],
    ['COMPOSE_VARIABLE_MISSING', 'MISSING_KEY']
  ]);

  const requiredMissing = await fixture(t, {
    'src/app.ts': 'process.env.API_KEY; process.env.SECOND_KEY; process.env.MISSING_KEY;',
    '.env.example': 'API_KEY=\nSECOND_KEY=\nMISSING_KEY=\n',
    'first.env': 'API_KEY=\nSECOND_KEY=ok-sentinel\n',
    'compose.yaml': 'services:\n  api:\n    env_file:\n      - first.env\n      - path: required-missing.env\n        required: true\n',
    'envcheck.config.json': config
  });
  const reqReport = await scanProject(requiredMissing, { noValues: true });
  assert.equal(reqReport.scope.complete, false);
  assert.deepEqual(reqReport.variables.map(v => [v.name, v.compose.state]), [
    ['API_KEY', 'unknown'],
    ['MISSING_KEY', 'unknown'],
    ['SECOND_KEY', 'unknown']
  ]);
  assert.deepEqual(reqReport.findings.map(f => f.rule), ['COMPOSE_ENV_FILE_MISSING']);

  for (const [laterEntry, expectedRule] of [
    ['      - ${DYNAMIC_PATH}\n', 'COMPOSE_UNSUPPORTED'],
    ['      - path: custom.env\n        format: custom\n', 'COMPOSE_UNSUPPORTED'],
    ['      - ../outside.env\n', 'COMPOSE_ENV_FILE_UNREADABLE']
  ]) {
    const unknownRoot = await fixture(t, {
      'src/app.ts': 'process.env.API_KEY; process.env.LATER_KEY;',
      '.env.example': 'API_KEY=\nLATER_KEY=\n',
      'first.env': 'API_KEY=\n',
      'third.env': 'LATER_KEY=later-sentinel\n',
      'compose.yaml': `services:\n  api:\n    env_file:\n      - first.env\n${laterEntry}      - third.env\n`,
      'envcheck.config.json': config
    });
    const unkReport = await scanProject(unknownRoot, { noValues: true });
    assert.equal(unkReport.scope.complete, false);
    assert.equal(unkReport.variables.find(v => v.name === 'API_KEY').compose.state, 'unknown');
    assert.equal(unkReport.variables.find(v => v.name === 'LATER_KEY').compose.state, 'declared');
    assert.equal(unkReport.findings.some(f => f.rule === 'COMPOSE_VALUE_EMPTY'), false);
    assert.ok(unkReport.findings.some(f => f.rule === expectedRule));
  }
});

test('patchComposeService and fixCompose refuse uneditable Compose constructs even with empty additions', async t => {
  for (const text of [
    'services:\n  api:\n    environment: !override {}\n',
    'services:\n  api:\n    image: app\n---\nservices: {}\n',
    'include:\n  - other.yaml\nservices:\n  api:\n    image: app\n',
    'services:\n  api:\n    extends: other\n',
    'services:\n  api:\n    environment: unsupported\n',
    'services:\n  api:\n    environment:\n      API_KEY:\n        - bad\n',
    'services:\n  api:\n    environment:\n      - API_KEY: ${API_KEY}\n',
    'services:\n  api:\n    environment:\n      - "=invalid"\n',
    'x-env: &env\n  API_KEY: "1"\nservices:\n  api:\n    environment: *env\n',
    'x-env: &env\n  API_KEY: "1"\nservices:\n  api:\n    environment:\n      <<: *env\n',
    'x-service: &svc\n  environment:\n    API_KEY: "1"\nservices:\n  api:\n    <<: *svc\n'
  ]) {
    for (const additions of [[], ['API_KEY']]) {
      assert.throws(() => patchComposeService(text, 'compose.yaml', 'api', additions), undefined, text);
    }
    const root = await fixture(t, { 'compose.yaml': text, 'envcheck.config.json': config });
    for (const apply of [false, true]) {
      await assert.rejects(fixCompose(root, { apply }));
      assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), text);
    }
    for (const args of [[], ['--apply']]) {
      const res = spawnSync(process.execPath, [cli, 'fix-compose', root, ...args, '--json'], { encoding: 'utf8' });
      assert.equal(res.status, 2, text);
      assert.equal(JSON.parse(res.stdout).error.code, 'INPUT_ERROR');
      assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), text);
    }
  }
});

test('fixCompose distinguishes general scan warnings from uneditable Compose structures and sets exit codes', async t => {
  const dynamicEnvFile = 'services:\n  api:\n    env_file: ${DYNAMIC_PATH}\n';
  const dynRoot = await fixture(t, { 'compose.yaml': dynamicEnvFile, 'envcheck.config.json': config });
  const dynResult = await fixCompose(dynRoot, { apply: true });
  assert.equal(dynResult.changed, false);
  assert.equal(dynResult.report.scope.complete, false);
  assert.equal(dynResult.report.variables[0].compose.state, 'unknown');
  assert.deepEqual(dynResult.additions, []);
  assert.equal(await fs.readFile(path.join(dynRoot, 'compose.yaml'), 'utf8'), dynamicEnvFile);

  const defaultCli = spawnSync(process.execPath, [cli, 'fix-compose', dynRoot, '--apply', '--json'], { encoding: 'utf8' });
  assert.equal(defaultCli.status, 0);
  const strictCli = spawnSync(process.execPath, [cli, 'fix-compose', dynRoot, '--apply', '--strict', '--json'], { encoding: 'utf8' });
  assert.equal(strictCli.status, 1);

  const sourceWarnRoot = await fixture(t, {
    'src/app.ts': 'process.env.API_KEY; process.env[dynamicKey];',
    '.env.example': 'API_KEY=\n',
    'compose.yaml': 'services:\n  api:\n    image: app\n',
    'envcheck.config.json': config
  });
  const warnPreview = spawnSync(process.execPath, [cli, 'fix-compose', sourceWarnRoot, '--json'], { encoding: 'utf8' });
  assert.equal(warnPreview.status, 1);
  assert.deepEqual(JSON.parse(warnPreview.stdout).additions, ['API_KEY']);

  const warnStrictApply = spawnSync(process.execPath, [cli, 'fix-compose', sourceWarnRoot, '--apply', '--strict', '--json'], { encoding: 'utf8' });
  assert.equal(warnStrictApply.status, 1);
  assert.equal(JSON.parse(warnStrictApply.stdout).changed, true);

  const warnDefaultRepeat = spawnSync(process.execPath, [cli, 'fix-compose', sourceWarnRoot, '--apply', '--json'], { encoding: 'utf8' });
  assert.equal(warnDefaultRepeat.status, 0);
  assert.equal(JSON.parse(warnDefaultRepeat.stdout).changed, false);
});
