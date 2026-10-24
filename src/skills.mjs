import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, projectPath } from './files.mjs';

const bundled = fileURLToPath(new URL('../skills/envcheck/', import.meta.url));
const resources = ['SKILL.md', 'references/workflow.md'];

export async function installSkill(inputRoot, agent) {
  if (!['codex', 'claude', 'both'].includes(agent)) throw new Error('Choose --agent codex, claude or both.');
  const root = await fs.realpath(inputRoot);
  const destinations = agent === 'both' ? ['.agents/skills/envcheck', '.claude/skills/envcheck'] : [agent === 'codex' ? '.agents/skills/envcheck' : '.claude/skills/envcheck'];
  const operations = [];
  // Preflight every destination before writing anything. Never overwrite a user's skill.
  for (const directory of destinations) for (const resource of resources) {
    const relative = `${directory}/${resource}`;
    const target = await projectPath(root, relative, true);
    const content = await fs.readFile(path.join(bundled, resource), 'utf8');
    if (await exists(target)) {
      if (await fs.readFile(target, 'utf8') !== content) throw new Error('An existing EnvCheck skill differs; preserve it and resolve the installation manually.');
    } else operations.push({ target, content, relative });
  }
  for (const { target, content } of operations) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { flag: 'wx' });
  }
  return { installed: destinations, filesAdded: operations.length };
}
