import fs from 'node:fs/promises';
import { exists, projectPath, stripLeadingBom } from './files.mjs';

const types = new Set(['string', 'number', 'integer', 'boolean', 'url', 'port']);
export const validName = name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);

export async function loadConfig(root) {
  const file = await projectPath(root, 'envcheck.config.json', true);
  let raw = {};
  const present = await exists(file);
  if (present) {
    try { raw = JSON.parse(stripLeadingBom(await fs.readFile(file, 'utf8'))); }
    catch { throw new Error('Cannot parse envcheck.config.json; check its JSON syntax.'); }
  }
  if (!object(raw)) throw new Error('Configuration must be a JSON object.');
  const allowed = new Set(['version', 'sources', 'example', 'envFiles', 'compose', 'ignore', 'variables']);
  if (Object.keys(raw).some(k => !allowed.has(k))) throw new Error('Unknown configuration field. See docs/configuration.md.');
  if (present && raw.version === undefined) throw new Error('Configuration must declare version: 1.');
  if (raw.version !== undefined && raw.version !== 1) throw new Error('Unsupported configuration version.');
  for (const key of ['sources', 'envFiles', 'ignore']) {
    if (raw[key] !== undefined && (!Array.isArray(raw[key]) || !raw[key].every(v => typeof v === 'string' && v.length))) {
      throw new Error('sources, envFiles and ignore must be arrays of nonempty strings.');
    }
  }
  if (raw.ignore?.some(name => !validName(name))) throw new Error('ignore accepts exact variable names only.');
  if (raw.example !== undefined && (typeof raw.example !== 'string' || !raw.example)) throw new Error('example must be a relative path.');
  if (raw.compose !== undefined && (!object(raw.compose) || typeof raw.compose.file !== 'string' || !raw.compose.file || typeof raw.compose.service !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.compose.service) || Object.keys(raw.compose).some(k => !['file', 'service'].includes(k)))) {
    throw new Error('compose must contain a relative file path and one service name.');
  }
  if (raw.variables !== undefined && !object(raw.variables)) throw new Error('variables must be an object.');
  for (const [name, value] of Object.entries(raw.variables ?? {})) {
    if (!validName(name) || !object(value) || Object.keys(value).some(k => !['type', 'required', 'when'].includes(k)) ||
      (value.type !== undefined && !types.has(value.type)) ||
      (value.required !== undefined && typeof value.required !== 'boolean') ||
      (value.when !== undefined && (!object(value.when) || typeof value.when.variable !== 'string' || !validName(value.when.variable) || typeof value.when.equals !== 'string' || Object.keys(value.when).some(k => !['variable', 'equals'].includes(k))))) {
      throw new Error('Invalid variable rule. See docs/configuration.md.');
    }
  }
  const sources = raw.sources ?? [await exists(await projectPath(root, 'src', true)) ? 'src' : '.'];
  if (!sources.length) throw new Error('At least one source path is required.');
  return {
    version: 1, sources,
    example: raw.example ?? '.env.example',
    envFiles: raw.envFiles ?? ['.env'],
    ignore: raw.ignore ?? [],
    variables: raw.variables ?? {},
    ...(raw.compose ? { compose: raw.compose } : {})
  };
}
