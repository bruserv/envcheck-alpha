import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function fixture(t, files = {}) {
  const base = path.resolve(process.env.ENVCHECK_TEST_TMP ?? '.envcheck-test-work');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'envcheck-test-'));
  t.after(async () => {
    const relative = path.relative(base, root);
    if (path.isAbsolute(relative) || relative.startsWith('..') || !relative.startsWith('envcheck-test-') || relative.includes(path.sep)) throw new Error('Refusing cleanup outside test directory.');
    // A Git process or filesystem can briefly race recursive removal (observed
    // as ENOTEMPTY on the Linux runner). Retry only transient errors; persistent
    // failures and permission errors must still fail the test, preserving data.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error.code) || attempt >= 5) throw error;
        await delay(100 * (attempt + 1));
      }
    }
  });
  const initial = { 'src/app.ts': 'export const key = process.env.API_KEY;\n', '.env.example': 'API_KEY=\n', ...files };
  for (const [name, content] of Object.entries(initial)) {
    if (content === null) continue;
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}
