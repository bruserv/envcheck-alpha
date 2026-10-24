import { parseEnv } from 'node:util';
import { locate, stripLeadingBom } from './files.mjs';

export function parseEnvironment(text, file) {
  text = stripLeadingBom(text);
  const values = parseEnv(text);
  const definitions = new Map();
  const findings = [];
  // Match complete dotenv assignments so multiline quoted content is not mistaken for keys.
  const pattern = /(?:^|\n)[ \t]*(?:export[ \t]+)?([^ \t\r\n#=][^=\r\n]*?)[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\r\n]*)/gd;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (!Object.hasOwn(values, name)) continue;
    const offset = match.indices[1][0];
    const location = locate(text, offset, file);
    if (definitions.has(name)) findings.push({
      rule: 'DUPLICATE_ENV_KEY', severity: 'error', variable: name,
      message: `${name} is declared more than once.`, locations: [definitions.get(name), location],
      action: 'Keep a single declaration to remove ambiguous configuration.'
    });
    definitions.set(name, location);
  }
  for (const name of Object.keys(values)) {
    // Node tolerates forms outside this bounded assignment matcher. Keep the
    // declaration, but do not invent a line/column for an unmatched key.
    if (!definitions.has(name)) definitions.set(name, { file });
  }
  return { values, definitions, findings };
}

export function validValue(value, type) {
  if (typeof value !== 'string' || !value.trim()) return false;
  switch (type) {
    case 'number': return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value));
    case 'integer': return /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value));
    case 'port': return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
    case 'boolean': return value === 'true' || value === 'false';
    case 'url': { try { return !!new URL(value).hostname; } catch { return false; } }
    default: return true;
  }
}
