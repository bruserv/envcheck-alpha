import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { parseEnvironment } from '../src/env.mjs';
import { parseCompose, patchComposeService } from '../src/compose.mjs';
import { scanProject } from '../src/scan.mjs';
import { fixExample, fixCompose } from '../src/fix.mjs';
import { scanSource } from '../src/source.mjs';
import { formatReport } from '../src/format.mjs';

const bom = '\uFEFF';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const bytes = (root, name) => fs.readFile(path.join(root, name));
const privateValue = 'BOM-PRIVATE-SYNTHETIC';

test('UTF-8 BOM config is read without rewriting bytes or changing scope', async t => {
  const text = bom + JSON.stringify({ version: 1, sources: ['src'], envFiles: [] });
  const root = await fixture(t, { 'envcheck.config.json': text });
  const before = await bytes(root, 'envcheck.config.json');
  assert.deepEqual([...before.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const report = await scanProject(root);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.scope.complete, true);
  assert.equal(report.scope.valuesChecked, false);
  assert.ok((await bytes(root, 'envcheck.config.json')).equals(before));
});

test('BOM example retains first key, duplicate locations and value omission for LF/CRLF', async t => {
  for (const eol of ['\n', '\r\n']) {
    const text = `${bom}API_KEY=${privateValue}${eol}# comment${eol}API_KEY=${eol}`;
    const parsed = parseEnvironment(text, '.env.example');
    assert.deepEqual([...parsed.definitions.keys()], ['API_KEY']);
    assert.deepEqual(parsed.findings[0]?.locations, [
      { file: '.env.example', line: 1, column: 1 }, { file: '.env.example', line: 3, column: 1 }
    ]);
    const root = await fixture(t, { '.env.example': text });
    const before = await bytes(root, '.env.example');
    const report = await scanProject(root, { noValues: true });
    assert.deepEqual(report.findings.filter(f => f.severity === 'error').map(f => f.rule), ['DUPLICATE_ENV_KEY']);
    assert.equal(report.variables[0].documented, true);
    assert.ok(!JSON.stringify(report).includes(privateValue));
    assert.ok((await bytes(root, '.env.example')).equals(before));
  }
});

test('BOM local env distinguishes set/empty and retains duplicate provenance', async t => {
  for (const value of [privateValue, '']) {
    const root = await fixture(t, { '.env': bom + `API_KEY=${value}\r\n` });
    const before = await bytes(root, '.env');
    const report = await scanProject(root);
    assert.equal(report.variables[0].local.state, value ? 'set' : 'empty');
    assert.deepEqual(report.variables[0].local.source, { file: '.env', line: 1, column: 1 });
    assert.equal(report.findings.some(f => f.rule === 'REQUIRED_VALUE_MISSING'), !value);
    assert.ok(!JSON.stringify(report).includes(privateValue));
    assert.ok((await bytes(root, '.env')).equals(before));
  }
  const root = await fixture(t, { '.env': `${bom}API_KEY=${privateValue}\r\nAPI_KEY=\r\n` });
  const report = await scanProject(root);
  assert.deepEqual(report.findings.find(f => f.rule === 'DUPLICATE_ENV_KEY')?.locations.map(l => [l.line, l.column]), [[1, 1], [2, 1]]);
  assert.equal(report.variables[0].local.source.line, 2);
  assert.equal(report.variables[0].local.state, 'empty');
});

test('embedded U+FEFF remains data in dotenv, JSON conditions and Compose', async t => {
  const value = `${privateValue}left${bom}right`;
  const parsed = parseEnvironment(`${bom}API_KEY="${value}"\nOTHER=${value}\n`, '.env');
  assert.equal(parsed.values.API_KEY, value);
  assert.equal(parsed.values.OTHER, value);
  const config = { version: 1, variables: { API_KEY: { when: { variable: 'ENABLED', equals: value } } }, compose: { file: 'compose.yaml', service: 'api' } };
  const compose = `${bom}services:\n  api:\n    environment:\n      API_KEY: "${value}"\n`;
  assert.equal(parseCompose(compose, 'compose.yaml').data.services.api.environment.API_KEY, value);
  const root = await fixture(t, {
    'envcheck.config.json': bom + JSON.stringify(config), '.env.example': `${bom}API_KEY=\nENABLED=\n`,
    '.env': `${bom}API_KEY=${value}\nENABLED=${value}\n`, 'compose.yaml': compose
  });
  assert.equal((await loadConfig(root)).variables.API_KEY.when.equals, value);
  const report = await scanProject(root);
  assert.equal(report.variables.find(v => v.name === 'API_KEY').required, true);
  assert.equal(report.summary.errors, 0);
  assert.ok(!JSON.stringify(report).includes(privateValue));
});

test('only one initial BOM is consumed, never a BOM after whitespace or newline', async t => {
  const doubled = parseEnvironment(`${bom}${bom}API_KEY=${privateValue}\n`, '.env');
  assert.equal(doubled.values.API_KEY, undefined);
  assert.equal(doubled.values[bom + 'API_KEY'], privateValue);
  const later = parseEnvironment(`OTHER=x\n${bom}API_KEY=${privateValue}\n`, '.env');
  assert.equal(later.values.API_KEY, undefined);
  assert.equal(later.values[bom + 'API_KEY'], privateValue);
  for (const prefix of [bom + bom, ' ' + bom, '\n' + bom]) {
    const root = await fixture(t, { 'envcheck.config.json': prefix + '{"version":1}' });
    await assert.rejects(loadConfig(root), /Cannot parse envcheck.config.json/);
  }
});

test('missing configuration version is a distinct input error with and without BOM', async t => {
  for (const prefix of ['', bom]) {
    const text = prefix + '{"sources":["src"]}';
    const root = await fixture(t, { 'envcheck.config.json': text });
    await assert.rejects(loadConfig(root), /Configuration must declare version: 1/);
    const result = spawnSync(process.execPath, [cli, 'scan', root, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, 'INPUT_ERROR');
    assert.match(output.error.message, /version: 1/);
    assert.doesNotMatch(output.error.message, /Cannot parse/);
    assert.equal(await fs.readFile(path.join(root, 'envcheck.config.json'), 'utf8'), text);
  }
  for (const version of [0, 2, '1', null]) {
    const root = await fixture(t, { 'envcheck.config.json': bom + JSON.stringify({ version }) });
    await assert.rejects(loadConfig(root), /Unsupported configuration version/);
  }
  const malformed = await fixture(t, { 'envcheck.config.json': bom + `{"version":1,"variables":${privateValue}}` });
  const result = spawnSync(process.execPath, [cli, 'scan', malformed, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(JSON.parse(result.stdout).error.message, /Cannot parse envcheck.config.json/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(privateValue));
  const noConfig = await fixture(t);
  assert.equal((await loadConfig(noConfig)).version, 1);
});

test('BOM Compose YAML/JSON and ordinary/raw env_file keep declaration locations', async t => {
  for (const raw of [false, true]) {
    const root = await fixture(t, {
      'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } },
      'compose.yaml': `${bom}services:\r\n  api:\r\n    env_file:\r\n      - path: runtime.env\r\n${raw ? '        format: raw\r\n' : ''}`,
      'runtime.env': `${bom}API_KEY=${privateValue}\r\nAPI_KEY=\r\n`
    });
    const before = await bytes(root, 'compose.yaml');
    const report = await scanProject(root, { noValues: true });
    assert.equal(report.scope.complete, true);
    assert.equal(report.variables[0].compose.source.line, 2);
    assert.deepEqual(report.findings.find(f => f.rule === 'DUPLICATE_ENV_KEY')?.locations.map(l => [l.line, l.column]), [[1, 1], [2, 1]]);
    assert.ok(report.findings.some(f => f.rule === 'COMPOSE_VALUE_EMPTY'));
    assert.ok(!JSON.stringify(report).includes(privateValue));
    assert.ok((await bytes(root, 'compose.yaml')).equals(before));
  }
  const json = bom + '{"services":{"api":{"environment":{"API_KEY":""}}}}';
  const parsed = parseCompose(json, 'compose.json');
  assert.deepEqual(parsed.locations.get('services.api.environment.API_KEY'), { file: 'compose.json', line: 1, column: 36 });
  const yaml = parseCompose(`${bom}services:\r\n  api:\r\n    environment:\r\n      API_KEY: ""\r\n`, 'compose.yaml');
  assert.deepEqual(yaml.locations.get('services.api.environment.API_KEY'), { file: 'compose.yaml', line: 4, column: 7 });
  assert.throws(() => parseCompose(`${bom}services:\n  api:\n    environment:\n      API_KEY: ${privateValue}\n      API_KEY: empty\n`, 'compose.yaml'), { message: 'Invalid YAML.' });
});

test('both repairs preserve BOM, LF/CRLF, existing values and idempotence', async t => {
  for (const eol of ['\n', '\r\n']) {
    const originalExample = `${bom}API_KEY=${privateValue}${eol}`;
    const originalCompose = `${bom}services:${eol}  api:${eol}    environment:${eol}      API_KEY: "${privateValue}" # keep${eol}`;
    const root = await fixture(t, {
      'src/app.ts': 'process.env.API_KEY; process.env.MISSING_KEY;',
      'envcheck.config.json': bom + JSON.stringify({ version: 1, compose: { file: 'compose.yaml', service: 'api' } }),
      '.env.example': originalExample, 'compose.yaml': originalCompose, '.env': `${bom}API_KEY=${privateValue}${eol}`
    });
    const config = await bytes(root, 'envcheck.config.json'), local = await bytes(root, '.env');
    const examplePreview = await fixExample(root), composePreview = await fixCompose(root);
    assert.deepEqual(examplePreview.additions, ['MISSING_KEY']);
    assert.deepEqual(composePreview.additions, ['MISSING_KEY']);
    assert.equal(await fs.readFile(path.join(root, '.env.example'), 'utf8'), originalExample);
    assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), originalCompose);
    const example = await fixExample(root, { apply: true }), compose = await fixCompose(root, { apply: true });
    const updatedExample = await fs.readFile(path.join(root, '.env.example'), 'utf8');
    const updatedCompose = await fs.readFile(path.join(root, 'compose.yaml'), 'utf8');
    assert.equal(updatedExample, originalExample + `MISSING_KEY=${eol}`);
    assert.ok(updatedCompose.startsWith(bom + 'services:'));
    assert.equal([...updatedCompose].filter(c => c === bom).length, 1);
    assert.equal(updatedCompose.replaceAll(eol, '').includes('\n'), false);
    assert.ok(updatedCompose.includes('# keep'));
    assert.equal(parseCompose(updatedCompose, 'compose.yaml').data.services.api.environment.API_KEY, privateValue);
    for (const result of [examplePreview, composePreview, example, compose]) assert.ok(!JSON.stringify(result).includes(privateValue));
    assert.equal((await fixExample(root, { apply: true })).changed, false);
    assert.equal((await fixCompose(root, { apply: true })).changed, false);
    assert.equal(await fs.readFile(path.join(root, '.env.example'), 'utf8'), updatedExample);
    assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), updatedCompose);
    assert.ok((await bytes(root, 'envcheck.config.json')).equals(config));
    assert.ok((await bytes(root, '.env')).equals(local));
  }
});

test('BOM-only example gains a placeholder without a second BOM or extra blank line', async t => {
  const root = await fixture(t, { '.env.example': bom });
  await fixExample(root, { apply: true });
  assert.equal(await fs.readFile(path.join(root, '.env.example'), 'utf8'), bom + 'API_KEY=\n');
  assert.equal((await fixExample(root, { apply: true })).changed, false);
});

test('JSON Compose repair preserves its BOM and embedded U+FEFF value', async t => {
  const value = `left${bom}${privateValue}`;
  const text = bom + JSON.stringify({ services: { api: { environment: { API_KEY: value } } } });
  const root = await fixture(t, {
    'src/app.ts': 'process.env.API_KEY; process.env.MISSING_KEY;',
    '.env.example': 'API_KEY=\nMISSING_KEY=\n',
    'envcheck.config.json': { version: 1, compose: { file: 'compose.json', service: 'api' } }, 'compose.json': text
  });
  await fixCompose(root);
  assert.equal(await fs.readFile(path.join(root, 'compose.json'), 'utf8'), text);
  const result = await fixCompose(root, { apply: true });
  const updated = await fs.readFile(path.join(root, 'compose.json'), 'utf8');
  assert.ok(updated.startsWith(bom + '{'));
  assert.equal(parseCompose(updated, 'compose.json').data.services.api.environment.API_KEY, value);
  assert.ok(!JSON.stringify(result).includes(privateValue));
  assert.equal((await fixCompose(root, { apply: true })).changed, false);
  assert.equal(await fs.readFile(path.join(root, 'compose.json'), 'utf8'), updated);
});

test('source BOM before shebang is consumed once in memory for JS and TS', async t => {
  for (const file of ['app.mjs', 'app.js', 'app.ts']) for (const eol of ['\n', '\r\n']) {
    const source = `#!/usr/bin/env node${eol}process.env.API_KEY;${eol}`;
    const result = scanSource(bom + source, file);
    assert.equal(result.complete, true);
    assert.deepEqual(result, scanSource(source, file));
    assert.deepEqual(result.usages.map(u => [u.name, u.line, u.column]), [['API_KEY', 2, 1]]);
    assert.equal(scanSource(bom + bom + source, file).complete, false);
  }
  const root = await fixture(t, { 'src/app.ts': `${bom}#!/usr/bin/env node\r\nprocess.env.API_KEY;\r\n` });
  const original = await bytes(root, 'src/app.ts');
  assert.equal((await scanProject(root, { noValues: true })).scope.complete, true);
  assert.ok((await bytes(root, 'src/app.ts')).equals(original));
});

test('source first-line BOM does not shift read or unknown locations or alter embedded data', () => {
  for (const source of ['process.env.API_KEY;', 'process.env.API_KEY; process.env[dynamic];',
    `process.env.API_KEY ?? "left${bom}right";`]) {
    assert.deepEqual(scanSource(bom + source, 'app.ts'), scanSource(source, 'app.ts'));
  }
  assert.equal(scanSource(bom + bom + 'process.env.API_KEY;', 'app.ts').usages[0].column, 2);
  assert.equal(scanSource('\n' + bom + '#!/usr/bin/env node\nprocess.env.API_KEY;', 'app.ts').complete, false);
});

test('Compose refuses extra stream BOMs in preview/apply without changing any bytes', async t => {
  const json = '{"services":{"api":{}}}';
  for (const prefix of [bom + bom, '\n' + bom]) assert.throws(() => parseCompose(prefix + json, 'compose.json'), /additional or noninitial BOM/);
  for (const eol of ['\n', '\r\n']) for (const prefix of [bom + bom, eol + bom, bom + eol + bom, '# header' + eol + bom]) {
    const text = `${prefix}services:${eol}  api:${eol}    environment:${eol}      API_KEY: ${privateValue}${eol}`;
    assert.throws(() => parseCompose(text, 'compose.yaml'), /additional or noninitial BOM/);
    const root = await fixture(t, {
      'src/app.ts': 'process.env.API_KEY; process.env.MISSING_KEY;', '.env.example': 'API_KEY=\nMISSING_KEY=\n',
      'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }, 'compose.yaml': text
    });
    const original = await bytes(root, 'compose.yaml');
    const report = await scanProject(root, { noValues: true });
    assert.equal(report.scope.complete, false);
    const encodingFinding = report.findings.find(f => f.rule === 'COMPOSE_UNSUPPORTED' && /BOM/.test(f.message));
    assert.ok(encodingFinding);
    assert.deepEqual(encodingFinding.locations, [{ file: 'compose.yaml', line: prefix === bom + bom ? 1 : 2, column: 1 }]);
    assert.equal(report.variables.find(v => v.name === 'MISSING_KEY').compose.state, 'unknown');
    for (const apply of [false, true, true]) {
      await assert.rejects(fixCompose(root, { apply }), /additional or noninitial BOM/);
      assert.ok((await bytes(root, 'compose.yaml')).equals(original));
    }
    for (const args of [[], ['--apply']]) {
      const result = spawnSync(process.execPath, [cli, 'fix-compose', root, ...args, '--json'], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(JSON.parse(result.stdout).error.message, /additional or noninitial BOM/);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(privateValue));
      assert.ok((await bytes(root, 'compose.yaml')).equals(original));
    }
  }
});

test('Compose repairs retain U+FEFF in plain/quoted/block values and comments', async t => {
  for (const eol of ['\n', '\r\n']) {
    const text = `${bom}# comment left${bom}right${eol}services:${eol}  api:${eol}    environment:${eol}      API_KEY: left${bom}${privateValue} # inline ${bom}note${eol}      QUOTED: "${bom}value"${eol}      BLOCK: |${eol}        left${bom}right${eol}`;
    const root = await fixture(t, {
      'src/app.ts': 'process.env.API_KEY; process.env.MISSING_KEY;', '.env.example': 'API_KEY=\nMISSING_KEY=\n',
      'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }, 'compose.yaml': text
    });
    const before = parseCompose(text, 'compose.yaml').data.services.api.environment;
    await fixCompose(root);
    assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), text);
    const applied = await fixCompose(root, { apply: true });
    const updated = await fs.readFile(path.join(root, 'compose.yaml'), 'utf8');
    const after = parseCompose(updated, 'compose.yaml').data.services.api.environment;
    for (const name of Object.keys(before)) assert.equal(after[name], before[name]);
    assert.ok(updated.startsWith(bom + '# comment'));
    assert.ok(updated.includes(`# comment left${bom}right`));
    assert.ok(updated.includes(`# inline ${bom}note`));
    assert.ok(!updated.replaceAll(eol, '').includes('\n'));
    assert.ok(!JSON.stringify(applied).includes(privateValue));
    assert.equal((await fixCompose(root, { apply: true })).changed, false);
    assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), updated);
  }
});

test('dotenv keys with export substrings, hyphens and noninitial U+FEFF have proven positions', () => {
  const exported = parseEnvironment('# header\nexport port=first\n  port=last\n', '.env');
  assert.deepEqual(exported.findings[0].locations.map(at => [at.line, at.column]), [[2, 8], [3, 3]]);
  const text = `KNOWN="multiline\nBAD-KEY=not-a-declaration\n"\n  BAD-KEY=${privateValue}\n  BAD-KEY=last\n${bom}ODD=value\n`;
  const unusual = parseEnvironment(text, '.env');
  assert.deepEqual(unusual.definitions.get('BAD-KEY'), { file: '.env', line: 5, column: 3 });
  assert.deepEqual(unusual.findings[0]?.locations.map(at => [at.line, at.column]), [[4, 3], [5, 3]]);
  assert.deepEqual(unusual.definitions.get(bom + 'ODD'), { file: '.env', line: 6, column: 1 });
});

test('dotenv positions outside bounded line syntax remain file-only, never invented', async t => {
  const text = `KEY\rODD-KEY=${privateValue}\nAPI_KEY=\n`;
  const parsed = parseEnvironment(text, '.env.example');
  assert.equal(parsed.values['KEYODD-KEY'], privateValue);
  assert.deepEqual(parsed.definitions.get('KEYODD-KEY'), { file: '.env.example' });
  const root = await fixture(t, { '.env.example': text });
  const report = await scanProject(root, { noValues: true });
  assert.deepEqual(report.findings.find(f => f.variable === 'KEYODD-KEY').locations, [{ file: '.env.example' }]);
  const output = formatReport(report);
  assert.match(output, /\.env.example \(position unknown\)/);
  assert.doesNotMatch(output, /undefined|BOM-PRIVATE-SYNTHETIC/);
});

test('Compose refuses serialization that turns a data U+FEFF into a stream signature', async t => {
  for (const prefix of ['', bom]) for (const eol of ['\n', '\r\n']) {
    const text = `${prefix} ${bom}x-note: ${privateValue}${eol} services:${eol}   api:${eol}     environment:${eol}       API_KEY: fixture${eol}`;
    assert.ok(Object.hasOwn(parseCompose(text, 'compose.yaml').data, bom + 'x-note'));
    assert.throws(() => patchComposeService(text, 'compose.yaml', 'api', ['MISSING_KEY']), /cannot preserve U\+FEFF/);
    const root = await fixture(t, {
      'src/app.ts': 'process.env.API_KEY; process.env.MISSING_KEY;', '.env.example': 'API_KEY=\nMISSING_KEY=\n',
      'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }, 'compose.yaml': text
    });
    assert.equal((await scanProject(root, { noValues: true })).scope.complete, true);
    for (const apply of [false, true, true]) {
      await assert.rejects(fixCompose(root, { apply }), /cannot preserve U\+FEFF/);
      assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), text);
    }
    for (const args of [[], ['--apply']]) {
      const result = spawnSync(process.execPath, [cli, 'fix-compose', root, ...args, '--json'], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(JSON.parse(result.stdout).error.message, /cannot preserve U\+FEFF/);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(privateValue));
      assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), text);
    }
  }
});
