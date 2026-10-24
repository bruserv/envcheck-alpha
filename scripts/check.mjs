import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let checked = 0;
for (const directory of ['src', 'scripts', 'test']) {
  for (const name of (await fs.readdir(path.join(root, directory))).filter(n => n.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, name)], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
    checked++;
  }
}
console.log(`Syntax checked ${checked} JavaScript modules.`);
