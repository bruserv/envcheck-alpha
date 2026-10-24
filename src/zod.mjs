import { validName } from './config.mjs';

// Bounded, file-local schema inspection. This module never imports or executes
// the scanned application's Zod dependency, validators or fallback expressions.
const MODULES = new Set(['zod', 'zod/v3', 'zod/v4']);
const WRAPPERS = new Set(['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'ParenthesizedExpression']);
const PARSERS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const BASES = new Set(['string', 'number', 'boolean', 'bigint', 'date', 'enum', 'literal']);
const CHECKS = new Set(['min', 'max', 'length', 'nonempty', 'url', 'email', 'uuid', 'regex', 'startsWith', 'endsWith', 'includes', 'trim', 'toLowerCase', 'toUpperCase', 'int', 'positive', 'nonnegative', 'negative', 'nonpositive', 'finite', 'describe', 'brand', 'readonly', 'nullable']);
const unwrap = raw => {
  let node = raw;
  while (WRAPPERS.has(node?.type)) node = node.expression;
  return node;
};
const member = node => node?.type === 'MemberExpression';
const key = node => !node.computed && node.key.type === 'Identifier' ? node.key.name :
  node.key.type === 'StringLiteral' ? node.key.value : undefined;
const property = node => !node.computed && node.property.type === 'Identifier' ? node.property.name :
  node.property.type === 'StringLiteral' ? node.property.value : undefined;

function requiredModule(node, scope, modules = MODULES) {
  return node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
    !scope.getBinding('require') && node.arguments.length === 1 && modules.has(node.arguments[0]?.value);
}

function namespaceEscapes(binding) {
  return binding.referencePaths.some(ref => {
    // Qualified type names (e.g. z.infer) are not runtime module escapes.
    if (['TSQualifiedName', 'TSTypeQuery', 'TSTypeReference'].includes(ref.parentPath?.node.type)) return false;
    while (WRAPPERS.has(ref.parentPath?.node.type)) ref = ref.parentPath;
    if (!member(ref.parentPath?.node) || ref.parentPath.node.object !== ref.node) return true;
    while (member(ref.parentPath?.node) && ref.parentPath.node.object === ref.node) ref = ref.parentPath;
    const parent = ref.parentPath?.node;
    return (parent?.type === 'AssignmentExpression' && parent.left === ref.node) ||
      parent?.type === 'UpdateExpression' || (parent?.type === 'UnaryExpression' && parent.operator === 'delete');
  });
}

function namespace(raw, scope, modules = MODULES) {
  const node = unwrap(raw);
  if (requiredModule(node, scope, modules)) return true;
  if (node?.type !== 'Identifier') return false;
  const binding = scope.getBinding(node.name);
  if (!binding?.constant || namespaceEscapes(binding)) return false;
  const { path } = binding;
  if (binding.kind === 'module') {
    const decl = path.parentPath?.node;
    if (decl?.type !== 'ImportDeclaration' || !modules.has(decl.source.value) ||
      decl.importKind === 'type' || path.node.importKind === 'type') return false;
    return path.isImportNamespaceSpecifier() || path.isImportDefaultSpecifier() ||
      (path.isImportSpecifier() && (path.node.imported.name ?? path.node.imported.value) === 'z');
  }
  if (!path.isVariableDeclarator() || !requiredModule(unwrap(path.node.init), path.scope, modules)) return false;
  if (path.node.id.type === 'Identifier') return true;
  return path.node.id.type === 'ObjectPattern' && path.node.id.properties.some(p =>
    p.type === 'ObjectProperty' && key(p) === 'z' && p.value === binding.identifier);
}

// Restrict schema aliases to parsing and other similarly bounded aliases. Passing
// a schema to a function, exporting it or writing its properties can change it.
function safelyReferenced(binding, seen = new Set()) {
  if (seen.has(binding)) return false;
  seen.add(binding);
  if (!binding.constant || binding.path.parentPath?.parentPath?.isExportNamedDeclaration()) return false;
  for (let ref of binding.referencePaths) {
    while (WRAPPERS.has(ref.parentPath?.node.type)) ref = ref.parentPath;
    const parent = ref.parentPath;
    if (parent?.isTSTypeQuery()) continue; // `z.infer<typeof schema>` cannot mutate a schema.
    if (parent?.isVariableDeclarator() && parent.node.init === ref.node && parent.node.id.type === 'Identifier') {
      const alias = parent.scope.getBinding(parent.node.id.name);
      if (!alias || !safelyReferenced(alias, new Set(seen))) return false;
      continue;
    }
    if (!member(parent?.node) || parent.node.object !== ref.node || !PARSERS.has(property(parent.node))) return false;
    const call = parent.parentPath?.node;
    if (call?.type !== 'CallExpression' || call.callee !== parent.node) return false;
  }
  return true;
}

function resolve(raw, scope, seen = new Set()) {
  const node = unwrap(raw);
  if (node?.type !== 'Identifier') return { node, scope };
  const binding = scope.getBinding(node.name);
  if (!binding || seen.has(binding) || !binding.path.isVariableDeclarator() ||
    binding.path.node.id.type !== 'Identifier' || !safelyReferenced(binding)) return { node, scope };
  seen.add(binding);
  return resolve(binding.path.node.init, binding.path.scope, seen);
}

// Values are inspected for syntax only, never evaluated or retained in a report.
function staticValue(raw) {
  const node = unwrap(raw);
  if (!node) return false;
  if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'RegExpLiteral'].includes(node.type)) return true;
  if (node.type === 'TemplateLiteral') return node.expressions.length === 0;
  if (node.type === 'UnaryExpression') return ['+', '-'].includes(node.operator) && unwrap(node.argument)?.type === 'NumericLiteral';
  if (node.type === 'ArrayExpression') return node.elements.every(n => n !== null && staticValue(n));
  if (node.type === 'ObjectExpression') return node.properties.every(p =>
    p.type === 'ObjectProperty' && !p.computed && staticValue(p.value));
  return false;
}

function usableDefault(raw) {
  const node = unwrap(raw);
  if (!staticValue(node)) return false;
  if (node.type === 'NullLiteral') return false;
  if (node.type === 'StringLiteral') return node.value.length > 0;
  if (node.type === 'TemplateLiteral') return Boolean(node.quasis[0].value.cooked);
  return ['NumericLiteral', 'BooleanLiteral', 'UnaryExpression'].includes(node.type);
}

function fieldChain(raw) {
  let current = unwrap(raw);
  const chain = [];
  while (current?.type === 'CallExpression' && member(unwrap(current.callee))) {
    const callee = unwrap(current.callee);
    chain.push({ name: property(callee), args: current.arguments });
    current = unwrap(callee.object);
  }
  return { current, chain };
}

// A deliberately small syntax/provenance check for inline pipe targets. This
// does not establish target validation, input/output compatibility or presence.
// Aliases, factories, callbacks and unknown methods in a target stay unresolved.
function inlinePipeTarget(raw, scope, modules) {
  const { current, chain } = fieldChain(raw);
  if (!namespace(current, scope, modules) || !chain.length) return false;
  const base = chain.pop();
  if (base.name === 'array') {
    if (base.args.length !== 1 || !inlinePipeTarget(base.args[0], scope, modules)) return false;
  } else if ((!BASES.has(base.name) && base.name !== 'url') || !base.args.every(staticValue) ||
    (['enum', 'literal'].includes(base.name) && base.args.length !== 1)) return false;
  return chain.every(method => ['optional', 'nullish'].includes(method.name) ? method.args.length === 0 :
    CHECKS.has(method.name) && method.args.every(staticValue));
}

function callbackMethod(method) {
  const callback = unwrap(method.args[0]);
  return ['Identifier', 'ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type) &&
    (method.name === 'refine' ? method.args.length >= 1 && method.args.length <= 2 && method.args.slice(1).every(staticValue) :
      ['superRefine', 'transform'].includes(method.name) && method.args.length === 1);
}

export function classifyZodField(raw, scope, { allowCoerce = false, modules = MODULES } = {}) {
  const { current, chain } = fieldChain(raw);
  const coerced = allowCoerce && member(current) && property(current) === 'coerce';
  const root = coerced ? unwrap(current.object) : current;
  if (!namespace(root, scope, modules) || !chain.length) return { optional: false, complete: false };
  const base = chain.pop();
  if (!BASES.has(base.name) || (coerced && ['enum', 'literal'].includes(base.name)) || !base.args.every(staticValue) ||
    (['enum', 'literal'].includes(base.name) && base.args.length !== 1)) return { optional: false, complete: false };
  let optional = false;
  let complete = true;
  let knownChain = true;
  // Presence proof and completeness are independent. Zod 4's optional wrapper
  // can delegate to an inner schema with optin=optional, unlike Zod 3. Track a
  // conservative possibility of that delegation separately from success.
  let acceptsMissing = false;
  let unsafeMissing = false;
  let opaque = false;
  const pipeModules = new Set([...modules].filter(name => name !== 'zod/v4-mini'));
  for (const method of chain.reverse()) {
    if (['optional', 'nullish'].includes(method.name) && method.args.length === 0) {
      optional = knownChain && !unsafeMissing;
      acceptsMissing = true;
    }
    else if (['default', 'catch'].includes(method.name)) {
      const usable = method.args.length === 1 && usableDefault(method.args[0]);
      // Defaults differ between v3/v4; catch does not catch arbitrary throws.
      // Do not use either to prove missing-input success across opaque work.
      optional = knownChain && usable && !opaque;
      if (!usable || opaque) { complete = false; unsafeMissing = true; }
      acceptsMissing = true;
    } else if (method.name === 'pipe') {
      optional = false;
      complete = false;
      opaque = true;
      if (acceptsMissing) unsafeMissing = true;
      // Pipe is never a presence-preserving check. Only retain schema identity
      // for a bounded genuine-Zod target; its behavior remains unknown.
      if (!namespace(root, scope, pipeModules) || method.args.length !== 1 ||
        !inlinePipeTarget(method.args[0], scope, pipeModules)) knownChain = false;
    } else if (!CHECKS.has(method.name) || !method.args.every(staticValue)) {
      optional = false;
      complete = false;
      opaque = true;
      if (acceptsMissing) unsafeMissing = true;
      // Known callback methods return a schema, but a callback reached after
      // accepting missing input may throw even through a later optional().
      // Unknown methods/arguments can also break schema identity entirely.
      if (!callbackMethod(method)) knownChain = false;
    }
  }
  return { optional, complete };
}

// Resolve one object initializer through aliases which are read only by this
// parse call. Other consumers could mutate the object, even with a const binding.
function mappedInput(raw, scope, call, inputPath, seen = new Set()) {
  const node = unwrap(raw);
  if (node?.type !== 'Identifier') return { node, scope, path: inputPath, stable: true };
  const binding = scope.getBinding(node.name);
  if (!binding || seen.has(binding) || !binding.path.isVariableDeclarator() ||
    binding.path.node.id.type !== 'Identifier') return { node, scope, stable: false };
  seen.add(binding);
  const resolved = mappedInput(binding.path.node.init, binding.path.scope, call, binding.path.get('init'), seen);
  const stable = binding.constant && binding.path.parentPath?.node.kind === 'const' &&
    !binding.path.parentPath?.parentPath?.isExportNamedDeclaration() &&
    binding.referencePaths.length === 1 && binding.referencePaths.every(ref => {
      while (WRAPPERS.has(ref.parentPath?.node.type)) ref = ref.parentPath;
      return (ref.parentPath?.node === call && call.arguments[0] === ref.node) ||
        (ref.parentPath?.isVariableDeclarator() && ref.parentPath.node.init === ref.node &&
          seen.has(ref.parentPath.scope.getBinding(ref.parentPath.node.id.name)));
    });
  return { ...resolved, stable: resolved.stable && stable };
}

export function inspectZodParse(callPath, { environmentKind, environmentRead, override, consume, use, unresolved }) {
  const { node, scope } = callPath;
  const callee = unwrap(node.callee);
  if (!member(callee) || !PARSERS.has(property(callee))) return;
  const input = unwrap(node.arguments[0]);
  const kind = environmentKind(input, scope);
  const mapped = kind ? undefined : mappedInput(input, scope, node, callPath.get('arguments.0'));
  const mapping = mapped?.node?.type === 'ObjectExpression' ? mapped.node : undefined;
  let hasMappedRead = false;
  if (mapping) {
    const inspect = path => { if (environmentRead(path.node, path.scope)) hasMappedRead = true; };
    mapped.path.traverse({ MemberExpression: inspect, OptionalMemberExpression: inspect });
  }
  // Parsing arbitrary input is not evidence of an environment contract.
  if (!kind && !hasMappedRead) return;
  const resolved = resolve(callee.object, scope);
  const schema = resolved.node;
  const schemaCallee = unwrap(schema?.callee);
  if (schema?.type !== 'CallExpression' || !member(schemaCallee) ||
    property(schemaCallee) !== 'object' || !namespace(schemaCallee.object, resolved.scope)) return;
  const shape = unwrap(schema.arguments[0]);
  if (schema.arguments.length !== 1 || shape?.type !== 'ObjectExpression' || node.arguments.length !== 1) {
    unresolved('SOURCE_UNSUPPORTED', node.start, 'Zod parsing requires an inline object shape and no custom parse options.');
    return;
  }
  if (kind) consume(input);
  const inputs = new Map();
  let stableInput = true;
  if (mapping) {
    stableInput = mapped.stable;
    for (const entry of mapping.properties) {
      const name = entry.type === 'ObjectProperty' && !entry.computed ? key(entry) : undefined;
      if (!name || inputs.has(name)) { stableInput = false; continue; }
      inputs.set(name, environmentRead(entry.value, mapped.scope));
    }
    if (!stableInput) unresolved('SOURCE_UNSUPPORTED', input.start, 'Zod input mapping is dynamic, duplicated, mutated or used outside this parse call.');
  }
  const names = new Set();
  const stableShape = shape.properties.every(entry => {
    if (entry.type !== 'ObjectProperty' || entry.computed) return false;
    const name = key(entry);
    if (!name || !validName(name) || names.has(name)) return false;
    names.add(name);
    return true;
  });
  names.clear();
  for (const entry of shape.properties) {
    const name = entry.type === 'ObjectProperty' ? key(entry) : undefined;
    if (!name || !validName(name) || entry.computed || names.has(name)) {
      unresolved('SOURCE_UNSUPPORTED', entry.start, 'Dynamic, duplicate or invalid Zod environment schema entry.');
      continue;
    }
    names.add(name);
    const result = classifyZodField(entry.value, resolved.scope);
    if (!result.complete) unresolved('SOURCE_UNSUPPORTED', entry.value.start, 'Zod environment validator or default cannot be classified statically.');
    // A spread/computed/duplicate property could override even a known key.
    if (kind) use(name, kind, stableShape && result.optional, entry.key.start);
    else {
      const read = inputs.get(name);
      if (!read) {
        unresolved('SOURCE_UNSUPPORTED', entry.key.start, 'Zod schema field has no supported direct environment input mapping.');
        continue;
      }
      if (stableShape && stableInput) override(read.node, result.optional);
    }
  }
}
