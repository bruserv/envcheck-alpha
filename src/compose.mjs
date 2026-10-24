import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { LineCounter, Parser, isAlias, isMap, isScalar, isSeq, parseAllDocuments, visit } from 'yaml';
import { displayPath, exists, locate, projectPath, stripLeadingBom } from './files.mjs';
import { parseEnvironment } from './env.mjs';
import { validName } from './config.mjs';

// Full YAML 1.2 parsing via the maintained `yaml` package, with Compose-style
// anchors, aliases and `<<` merge keys. Anything the parser reports as an error
// or warning (including Compose-only tags such as !reset/!override and
// multi-document files) fails closed. Error messages are generic on purpose:
// parser diagnostics can quote source text, which may contain values.
const isMergeKey = key => isScalar(key) && typeof key.value === 'symbol';

class ComposeBomError extends Error {
  constructor(location) {
    super('Compose contains an additional or noninitial BOM outside a value or comment. Automatic repair is refused; review the file encoding manually.');
    this.location = location;
  }
}

export function assertComposeBom(text, file) {
  const body = stripLeadingBom(text);
  if (!body.includes('\uFEFF')) return;
  try {
    // YAML 2.x silently discards stream BOM tokens, including after blank lines.
    // The public CST parser distinguishes these from scalar/comment content.
    // One leading signature was already consumed; any remaining stream BOM is
    // outside our encoding contract and cannot be repaired without losing data.
    for (const token of new Parser().parse(body)) {
      if (token.type === 'byte-order-mark') throw new ComposeBomError(locate(body, token.offset, file));
    }
  } catch (error) {
    if (error instanceof ComposeBomError) throw error;
    throw new Error('Invalid YAML.');
  }
}

function collectLocations(doc, lineCounter, file) {
  const locations = new Map();
  const at = node => {
    const { line, col } = lineCounter.linePos(node.range[0]);
    return { file, line, column: col };
  };
  const seen = new Set();
  // Resolve nested merge sources in the same order as YAML: explicit keys win,
  // then the first merge source that supplies a key. Keep the original pair so
  // diagnostics point at the winning declaration, including multi-hop merges.
  function effectivePairs(node, ancestors = new Set()) {
    if (isAlias(node)) node = node.resolve(doc);
    if (!isMap(node) || ancestors.has(node)) return new Map();
    const next = new Set(ancestors).add(node);
    const pairs = new Map();
    const merges = [];
    for (const pair of node.items) {
      if (isMergeKey(pair.key)) { merges.push(pair.value); continue; }
      if (isScalar(pair.key)) pairs.set(String(pair.key.value), pair);
    }
    for (const merge of merges) {
      for (const source of isSeq(merge) ? merge.items : [merge]) {
        for (const [name, pair] of effectivePairs(source, next)) {
          if (!pairs.has(name)) pairs.set(name, pair);
        }
      }
    }
    return pairs;
  }
  function walk(node, trail) {
    if (isAlias(node)) node = node.resolve(doc);
    if (!node || seen.has(node)) return;
    if (isMap(node)) {
      seen.add(node);
      for (const [name, pair] of effectivePairs(node)) {
        const key = [...trail, name].join('.');
        locations.set(key, at(pair.key));
        walk(pair.value, [...trail, name]);
      }
      seen.delete(node);
    } else if (isSeq(node)) {
      seen.add(node);
      node.items.forEach((item, index) => {
        const key = [...trail, String(index)].join('.');
        if (item?.range) locations.set(key, at(item));
        walk(item, [...trail, String(index)]);
      });
      seen.delete(node);
    }
  }
  walk(doc.contents, []);
  return locations;
}

export function parseCompose(text, file) {
  assertComposeBom(text, file);
  const lineCounter = new LineCounter();
  let documents;
  try {
    documents = parseAllDocuments(stripLeadingBom(text), { lineCounter, merge: true, uniqueKeys: true, prettyErrors: false });
  } catch { throw new Error('Invalid YAML.'); }
  if (!Array.isArray(documents) || documents.length === 0) throw new Error('Empty Compose file.');
  if (documents.length > 1) throw new Error('Multi-document YAML is unsupported.');
  const [doc] = documents;
  if (doc.errors.length) throw new Error('Invalid YAML.');
  if (doc.warnings.length) throw new Error('Unsupported YAML construct.');
  let data;
  try { data = doc.toJS({ maxAliasCount: 100 }); } catch { throw new Error('Unsupported YAML alias usage.'); }
  if (data === null || data === undefined) throw new Error('Empty Compose file.');
  return { data, locations: collectLocations(doc, lineCounter, file), file };
}

const mapping = v => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (object, key) => mapping(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const ENV_FILE_KEYS = new Set(['path', 'required', 'format']);

function parseEnvFileItem(item) {
  if (typeof item === 'string') return item && !item.includes('$') ? { path: item, required: true } : undefined;
  if (!mapping(item) || Object.keys(item).some(key => !ENV_FILE_KEYS.has(key))) return undefined;
  if (typeof item.path !== 'string' || !item.path || item.path.includes('$')) return undefined;
  if (item.required !== undefined && typeof item.required !== 'boolean') return undefined;
  if (item.format !== undefined && item.format !== 'raw') return undefined;
  return { path: item.path, required: item.required ?? true, ...(item.format ? { format: item.format } : {}) };
}

export function composeEnvFilePaths(service) {
  const raw = service?.env_file;
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  return list.map(parseEnvFileItem).filter(Boolean).map(entry => entry.path);
}

// Safely add missing variable interpolation entries to the selected service's environment
// while preserving comments, anchors and line endings. Fails closed on aliased/merged targets.
export function patchComposeService(text, file, serviceName, additions = []) {
  if (!Array.isArray(additions)) throw new Error('Compose repair additions must be an array.');
  const parsed = parseCompose(text, file);
  const data = parsed.data;
  if (!mapping(data) || !mapping(own(data, 'services')) || !mapping(own(data.services, serviceName))) {
    throw new Error('The selected Compose service is missing or invalid.');
  }
  if (Object.hasOwn(data, 'include') || Object.hasOwn(data.services[serviceName], 'extends')) {
    throw new Error('Automatic Compose repair cannot safely edit a Compose file or service that uses include or extends.');
  }
  const [doc] = parseAllDocuments(stripLeadingBom(text), { merge: true, uniqueKeys: true, prettyErrors: false });
  const sharedNodes = new Set();
  visit(doc, { Alias(_key, node) { sharedNodes.add(node.resolve(doc)); } });
  const requireUnshared = node => {
    if (sharedNodes.has(node)) throw new Error('Automatic Compose repair cannot safely edit a shared YAML anchor; other declarations would also change.');
  };
  if (!isMap(doc.contents)) throw new Error('Invalid Compose root mapping.');
  requireUnshared(doc.contents);
  const servicesPair = doc.contents.items.find(pair => isScalar(pair.key) && String(pair.key.value) === 'services');
  if (!servicesPair || !isMap(servicesPair.value) || isAlias(servicesPair.value)) {
    throw new Error('Automatic Compose repair cannot safely edit an aliased services mapping.');
  }
  requireUnshared(servicesPair.value);
  const servicePair = servicesPair.value.items.find(pair => isScalar(pair.key) && String(pair.key.value) === serviceName);
  if (!servicePair || !isMap(servicePair.value) || isAlias(servicePair.value)) {
    throw new Error('Automatic Compose repair cannot safely edit an aliased service definition.');
  }
  const serviceNode = servicePair.value;
  requireUnshared(serviceNode);
  const envPair = serviceNode.items.find(pair => isScalar(pair.key) && String(pair.key.value) === 'environment');
  if (!envPair) {
    if (Object.hasOwn(data.services[serviceName], 'environment')) {
      throw new Error('Automatic Compose repair cannot safely add environment when the service inherits environment via YAML merge keys.');
    }
    if (additions.length) {
      const envKey = doc.createNode('environment');
      const envMap = doc.createNode({});
      if (serviceNode.flow) { envKey.type = 'QUOTE_DOUBLE'; envMap.flow = true; }
      for (const name of additions) {
        const k = doc.createNode(name);
        const v = doc.createNode(`\${${name}:?Set ${name} locally}`);
        if (envMap.flow) { k.type = 'QUOTE_DOUBLE'; v.type = 'QUOTE_DOUBLE'; }
        envMap.items.push(doc.createPair(k, v));
      }
      serviceNode.items.push(doc.createPair(envKey, envMap));
    }
  } else {
    const envNode = envPair.value;
    if (isAlias(envNode)) throw new Error('Automatic Compose repair cannot safely edit an aliased service environment.');
    requireUnshared(envNode);
    if (isScalar(envNode) && envNode.value === null) {
      if (additions.length) {
        const envMap = doc.createNode({});
        if (envNode.comment) envPair.key.comment = envNode.comment;
        if (envNode.commentBefore) envMap.commentBefore = envNode.commentBefore;
        if (envNode.spaceBefore) envMap.spaceBefore = envNode.spaceBefore;
        if (envNode.anchor) envMap.anchor = envNode.anchor;
        if (serviceNode.flow) envMap.flow = true;
        for (const name of additions) {
          const k = doc.createNode(name);
          const v = doc.createNode(`\${${name}:?Set ${name} locally}`);
          if (envMap.flow) { k.type = 'QUOTE_DOUBLE'; v.type = 'QUOTE_DOUBLE'; }
          envMap.items.push(doc.createPair(k, v));
        }
        envPair.value = envMap;
      }
    } else if (isMap(envNode)) {
      if (envNode.items.some(pair => isMergeKey(pair.key))) {
        throw new Error('Automatic Compose repair cannot safely edit an environment mapping with YAML merge keys.');
      }
      for (const [name, value] of Object.entries(data.services[serviceName].environment ?? {})) {
        if (!validName(name) || (value !== null && !['string', 'number', 'boolean'].includes(typeof value))) {
          throw new Error('Unsupported Compose environment entry for automatic repair.');
        }
      }
      for (const name of additions) {
        const k = doc.createNode(name);
        const v = doc.createNode(`\${${name}:?Set ${name} locally}`);
        if (envNode.flow) { k.type = 'QUOTE_DOUBLE'; v.type = 'QUOTE_DOUBLE'; }
        envNode.items.push(doc.createPair(k, v));
      }
    } else if (isSeq(envNode)) {
      for (const entry of data.services[serviceName].environment ?? []) {
        if (typeof entry !== 'string') throw new Error('Unsupported Compose environment entry for automatic repair.');
        const equal = entry.indexOf('=');
        const name = equal === -1 ? entry : entry.slice(0, equal);
        if (!validName(name)) throw new Error('Unsupported Compose environment entry for automatic repair.');
      }
      for (const name of additions) {
        const item = doc.createNode(`${name}=\${${name}:?Set ${name} locally}`);
        if (envNode.flow) item.type = 'QUOTE_DOUBLE';
        envNode.items.push(item);
      }
    } else {
      throw new Error('Unsupported Compose environment structure for automatic repair.');
    }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const replacement = (text.startsWith('\uFEFF') ? '\uFEFF' : '') + doc.toString().replace(/\r?\n/g, eol);
  if (text.includes('\uFEFF')) {
    let preserved = false;
    try {
      // A scalar key can move to the first column during serialization and
      // turn its initial U+FEFF into a stream BOM. Compare intended vs re-read
      // data without exposing either value or relying on character counts.
      preserved = isDeepStrictEqual(doc.toJS({ maxAliasCount: 100 }), parseCompose(replacement, file).data);
    } catch { /* An output which cannot be interpreted safely is not writable. */ }
    if (!preserved) throw new Error('Automatic Compose repair cannot preserve U+FEFF data through serialization. Review this unusual input manually; the file was not changed.');
  }
  return additions.length ? replacement : text;
}

// No values are exported from this module; only declarations and provenance.
export async function inspectCompose(root, config) {
  const findings = [];
  const declarations = new Map();
  let complete = true;
  const location = { file: config.file, line: 1, column: 1 };
  function issue(rule, message, severity = 'warning', at = location) {
    complete = false;
    findings.push({ rule, severity, message, locations: [at], action: 'Inspect the selected service and docs/limitations.md. Resolve unsupported inputs before relying on this result.' });
  }
  const file = await projectPath(root, config.file, true);
  if (!await exists(file)) {
    issue('COMPOSE_FILE_MISSING', 'The configured Compose file does not exist.', 'error');
    return { declarations, findings, complete };
  }
  let parsed;
  try { parsed = parseCompose(await fs.readFile(file, 'utf8'), config.file); }
  catch (error) {
    if (error instanceof ComposeBomError) issue('COMPOSE_UNSUPPORTED', error.message, 'warning', error.location);
    else issue('COMPOSE_UNSUPPORTED', 'Compose syntax could not be fully interpreted. Invalid YAML, multiple documents, Compose-specific tags and overlays are not supported.');
    return { declarations, findings, complete };
  }
  const data = parsed.data;
  if (!mapping(data) || !mapping(own(data, 'services')) || !mapping(own(data.services, config.service))) {
    issue('COMPOSE_SERVICE_MISSING', 'The selected Compose service is missing or invalid.', 'error');
    return { declarations, findings, complete };
  }
  const service = data.services[config.service];
  const at = key => parsed.locations.get(`services.${config.service}.${key}`) ?? location;
  if (Object.hasOwn(data, 'include') || Object.hasOwn(service, 'extends')) issue('COMPOSE_UNSUPPORTED', 'Compose includes and extends need manual resolution.');
  let envFiles = service.env_file ?? [];
  if (typeof envFiles === 'string') envFiles = [envFiles];
  if (!Array.isArray(envFiles)) { issue('COMPOSE_UNSUPPORTED', 'Unsupported env_file declaration.', 'warning', at('env_file')); envFiles = []; }
  for (const [index, item] of envFiles.entries()) {
    const entryAt = parsed.locations.get(`services.${config.service}.env_file.${index}`) ?? at('env_file');
    const spec = parseEnvFileItem(item);
    if (!spec) {
      declarations.clear();
      issue('COMPOSE_UNSUPPORTED', 'Unsupported env_file entry; only literal paths and { path, required, format: "raw" } objects are supported.', 'warning', entryAt);
      continue;
    }
    const relative = path.join(path.dirname(config.file), spec.path);
    let envPath;
    try { envPath = await projectPath(root, relative, true); }
    catch {
      declarations.clear();
      issue('COMPOSE_ENV_FILE_UNREADABLE', 'A service env_file is outside the project or linked.', 'error', entryAt);
      continue;
    }
    if (!await exists(envPath)) {
      if (spec.required) {
        declarations.clear();
        issue('COMPOSE_ENV_FILE_MISSING', 'A service env_file does not exist.', 'error', entryAt);
      }
      continue;
    }
    const text = await fs.readFile(envPath, 'utf8');
    const envFile = displayPath(root, envPath);
    if (spec.format === 'raw') {
      // Compose raw env_file passes quotes, # and $ through literally. Node's
      // dotenv parser would erase quotes/comments and report false empty values.
      // Only conventional one-line assignments are interpreted here. Host-only
      // keys and other syntax remain unknown; never consult process.env.
      const seen = new Map();
      for (const [index, line] of stripLeadingBom(text).split(/\r?\n/).entries()) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        const match = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        const source = { file: envFile, line: index + 1, column: match ? line.indexOf(match[1]) + 1 : 1 };
        if (!match) {
          // A bare key or unsupported assignment can replace an earlier
          // assignment. Its value and presence are unknown here.
          const named = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]*|[ \t]+.*|[ \t]*=.*)$/.exec(line);
          if (named) declarations.delete(named[1]);
          issue('COMPOSE_UNSUPPORTED', 'Unsupported raw env_file entry; only one-line NAME=value assignments are interpreted.', 'warning', source);
          continue;
        }
        const name = match[1];
        if (seen.has(name)) findings.push({
          rule: 'DUPLICATE_ENV_KEY', severity: 'error', variable: name,
          message: `${name} is declared more than once.`, locations: [seen.get(name), source],
          action: 'Keep a single declaration to remove ambiguous configuration.'
        });
        seen.set(name, source);
        declarations.set(name, { source, kind: 'env-file', empty: match[2].length === 0, valueKnown: true });
      }
      continue;
    }
    const env = parseEnvironment(text, envFile);
    findings.push(...env.findings);
    for (const [name, source] of env.definitions) {
      declarations.set(name, { source, kind: 'env-file', empty: !env.values[name]?.trim(), valueKnown: true });
    }
  }
  const environment = service.environment ?? {};
  const entries = Array.isArray(environment)
    ? environment.map((entry, index) => {
      if (typeof entry !== 'string') {
        if (mapping(entry)) {
          for (const k of Object.keys(entry)) if (validName(k.trim())) declarations.delete(k.trim());
        }
        return [undefined, undefined, String(index)];
      }
      const equal = entry.indexOf('=');
      return equal === -1 ? [entry, null, String(index)] : [entry.slice(0, equal), entry.slice(equal + 1), String(index)];
    })
    : mapping(environment) ? Object.entries(environment).map(([name, value]) => [name, value, name]) : [];
  if (!mapping(environment) && !Array.isArray(environment)) {
    declarations.clear();
    issue('COMPOSE_UNSUPPORTED', 'Unsupported environment declaration.', 'warning', at('environment'));
  }
  const seen = new Set();
  for (const [name, value, key] of entries) {
    if (typeof name !== 'string' || !validName(name) || (value !== null && !['string', 'number', 'boolean'].includes(typeof value))) {
      if (typeof name === 'string' && validName(name.trim())) declarations.delete(name.trim());
      issue('COMPOSE_UNSUPPORTED', 'Unsupported environment entry.', 'warning', at('environment'));
      continue;
    }
    const source = at(`environment.${key}`);
    if (seen.has(name)) findings.push({ rule: 'DUPLICATE_COMPOSE_KEY', severity: 'error', variable: name, message: `${name} is repeated in service environment.`, locations: [source], action: 'Keep a single service declaration for this variable.' });
    seen.add(name);
    const interpolation = typeof value === 'string' && /\$(?!\$)/.test(value.replace(/\$\$/g, ''));
    declarations.set(name, {
      source,
      kind: value === null ? 'host-pass-through' : interpolation ? 'interpolation' : 'literal',
      empty: typeof value === 'string' && !value.trim(),
      valueKnown: value !== null && !interpolation
    });
  }
  return { declarations, findings, complete };
}
