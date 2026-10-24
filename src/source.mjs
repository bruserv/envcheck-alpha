import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { locate, stripLeadingBom } from './files.mjs';
import { validName } from './config.mjs';
import { classifyZodField, inspectZodParse } from './zod.mjs';

// AST-based scanner (Babel parser + scope analysis). It establishes which syntax
// is an environment read; it is not a type checker or a general data-flow engine.
// Anything it cannot classify is reported as incomplete, never silently dropped.

const PROCESS_MODULES = new Set(['process', 'node:process']);
const T3_ENV_MODULES = new Set(['@t3-oss/env-nextjs', '@t3-oss/env-core']);
const ZOD_MODULES = new Set(['zod', 'zod/v3', 'zod/v4', 'zod/v4-mini']);
const ENVALID_MODULES = new Set(['envalid']);
const ENVALID_VALIDATORS = new Set(['str', 'bool', 'num', 'email', 'host', 'port', 'url', 'json']);
const TS_WRAPPERS = new Set(['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'ParenthesizedExpression']);
const T3_KNOWN_OPTIONS = new Set([
  'server', 'client', 'shared', 'runtimeEnv', 'runtimeEnvStrict', 'experimental__runtimeEnv',
  'clientPrefix', 'skipValidation', 'emptyStringAsUndefined', 'onValidationError',
  'onInvalidAccess', 'isServer', 'createFinalSchema', 'extends'
]);

function parserOptions(file) {
  const ext = /\.([cm]?[jt]sx?)$/i.exec(file)?.[1].toLowerCase() ?? 'js';
  const typescript = ext.includes('t');
  const plugins = ['decorators-legacy', 'explicitResourceManagement'];
  if (typescript) plugins.push('typescript');
  // Plain .ts cannot contain JSX (angle-bracket assertions). JS files often do.
  if (ext.endsWith('x') || !typescript) plugins.push('jsx');
  const sourceType = ext.startsWith('m') ? 'module' : ext.startsWith('c') ? 'script' : 'unambiguous';
  return {
    sourceType, plugins, errorRecovery: true,
    allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true, allowUndeclaredExports: true
  };
}

function unwrap(node) {
  let current = node;
  while (current && TS_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

// Climb through TypeScript-only wrappers such as `x!`, `x as T`.
function outer(path) {
  let current = path;
  while (current.parentPath && TS_WRAPPERS.has(current.parentPath.node.type)) current = current.parentPath;
  return current;
}

const isMember = node => node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression';

// Static property name of a member access, or undefined when computed.
function propertyName(member) {
  const { property, computed } = member;
  if (!computed) return property.type === 'Identifier' ? property.name : undefined;
  if (property.type === 'StringLiteral') return property.value;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0) return property.quasis[0].value.cooked ?? undefined;
  return undefined;
}

function keyName(property) {
  if (!property.computed && property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'StringLiteral') return property.key.value;
  return undefined;
}

// 'literal' = a complete, usable default; 'empty' = undefined/null/''; 'computed' = anything else.
function classifyDefault(rawNode) {
  const node = unwrap(rawNode);
  if (!node) return 'computed';
  if (node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') return 'literal';
  if (node.type === 'UnaryExpression' && ['+', '-'].includes(node.operator) && unwrap(node.argument)?.type === 'NumericLiteral') return 'literal';
  if (node.type === 'StringLiteral') return node.value ? 'literal' : 'empty';
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ? 'literal' : 'empty';
  if (node.type === 'NullLiteral' || (node.type === 'Identifier' && node.name === 'undefined')) return 'empty';
  return 'computed';
}

const isRequireOf = (rawNode, scope, modules = PROCESS_MODULES) => {
  const node = unwrap(rawNode);
  return node?.type === 'CallExpression' && node.callee.type === 'Identifier' &&
    node.callee.name === 'require' && !scope.hasBinding('require') && node.arguments.length === 1 &&
    node.arguments[0].type === 'StringLiteral' && modules.has(node.arguments[0].value);
};

const isGlobalProcess = (rawNode, scope) => {
  const node = unwrap(rawNode);
  if (node?.type === 'Identifier' && node.name === 'process' && !scope.getBinding('process')) return true;
  if (isMember(node) && propertyName(node) === 'process' && node.object.type === 'Identifier' &&
    (node.object.name === 'globalThis' || node.object.name === 'global') && !scope.getBinding(node.object.name)) {
    return true;
  }
  return false;
};

const isImportMetaEnv = rawNode => {
  const node = unwrap(rawNode);
  return isMember(node) && propertyName(node) === 'env' &&
    node.object.type === 'MetaProperty' && node.object.meta.name === 'import' && node.object.property.name === 'meta';
};

const isExportedDeclarator = declaratorPath => declaratorPath.parentPath?.parentPath?.isExportNamedDeclaration() ?? false;

function environmentKind(raw, scope) {
  const node = unwrap(raw);
  if (isImportMetaEnv(node)) return 'vite';
  if (node?.type === 'Identifier') {
    const role = bindingRole(scope.getBinding(node.name));
    return role === 'env' ? 'process' : role === 'vite-env' ? 'vite' : undefined;
  }
  if (isMember(node) && propertyName(node) === 'env') {
    const object = unwrap(node.object);
    if (isGlobalProcess(object, scope) || isRequireOf(object, scope) ||
      (object?.type === 'Identifier' && bindingRole(scope.getBinding(object.name)) === 'process')) return 'process';
  }
  return undefined;
}

function environmentRead(raw, scope) {
  const node = unwrap(raw);
  const name = isMember(node) ? propertyName(node) : undefined;
  const kind = name && validName(name) ? environmentKind(node.object, scope) : undefined;
  return kind ? { node, name, kind } : undefined;
}

// What a binding stands for: 'process', 'env', 'vite-env', or undefined.
function bindingRole(binding, seen = new Set()) {
  if (!binding || seen.has(binding)) return undefined;
  seen.add(binding);
  const { path, identifier } = binding;
  if (binding.kind === 'module') {
    const declaration = path.parentPath?.node;
    if (declaration?.type !== 'ImportDeclaration' || !PROCESS_MODULES.has(declaration.source.value)) return undefined;
    if (declaration.importKind === 'type' || path.node.importKind === 'type') return undefined;
    if (path.isImportDefaultSpecifier() || path.isImportNamespaceSpecifier()) return 'process';
    if (path.isImportSpecifier()) {
      const imported = path.node.imported.type === 'Identifier' ? path.node.imported.name : path.node.imported.value;
      return imported === 'env' ? 'env' : undefined;
    }
    return undefined;
  }
  if (!binding.constant || !path.isVariableDeclarator()) return undefined;
  const { id } = path.node;
  const init = unwrap(path.node.init);
  const scope = path.scope;
  const initIsProcess = isRequireOf(init, scope) || isGlobalProcess(init, scope) ||
    (init?.type === 'Identifier' && bindingRole(scope.getBinding(init.name), seen) === 'process');
  if (id.type === 'Identifier') {
    if (initIsProcess) return 'process';
    if (!binding.referenced || isExportedDeclarator(path)) return undefined;
    if (isImportMetaEnv(init)) return 'vite-env';
    if (isMember(init) && propertyName(init) === 'env') {
      const obj = unwrap(init.object);
      if (isRequireOf(obj, scope) || isGlobalProcess(obj, scope) ||
        (obj?.type === 'Identifier' && bindingRole(scope.getBinding(obj.name), seen) === 'process')) {
        return 'env';
      }
    }
    return undefined;
  }
  if (id.type === 'ObjectPattern' && initIsProcess) {
    const property = id.properties.find(p => p.type === 'ObjectProperty' && p.value === identifier);
    if (property && keyName(property) === 'env' && binding.referenced && !isExportedDeclarator(path)) return 'env';
  }
  return undefined;
}

function t3Export(rawNode, scope) {
  const node = unwrap(rawNode);
  if (isRequireOf(node, scope, T3_ENV_MODULES)) return '*';
  if (isMember(node) && t3Export(node.object, scope) === '*') return propertyName(node);
  if (node?.type !== 'Identifier') return undefined;
  const binding = scope.getBinding(node.name);
  if (!binding?.constant) return undefined;
  const { path, identifier } = binding;
  if (binding.kind === 'module') {
    const decl = path.parentPath?.node;
    if (decl?.type !== 'ImportDeclaration' || !T3_ENV_MODULES.has(decl.source.value) ||
      decl.importKind === 'type' || path.node.importKind === 'type') return undefined;
    if (path.isImportDefaultSpecifier() || path.isImportNamespaceSpecifier()) return '*';
    if (path.isImportSpecifier()) return path.node.imported.name ?? path.node.imported.value;
  }
  if (!path.isVariableDeclarator() || !isRequireOf(path.node.init, path.scope, T3_ENV_MODULES)) return undefined;
  if (path.node.id.type === 'Identifier') return '*';
  if (path.node.id.type === 'ObjectPattern') {
    const prop = path.node.id.properties.find(p => p.type === 'ObjectProperty' && p.value === identifier);
    return prop ? keyName(prop) : undefined;
  }
  return undefined;
}

// Resolve only exports of the actual package, including renamed imports and CJS
// destructuring. Local functions, relative paths and mutable bindings are not evidence.
function envalidExport(rawNode, scope) {
  const node = unwrap(rawNode);
  if (isRequireOf(node, scope, ENVALID_MODULES)) return '*';
  if (isMember(node) && envalidExport(node.object, scope) === '*') return propertyName(node);
  if (node?.type !== 'Identifier') return undefined;
  const binding = scope.getBinding(node.name);
  if (!binding?.constant) return undefined;
  const { path, identifier } = binding;
  if (binding.kind === 'module') {
    const decl = path.parentPath?.node;
    if (decl?.type !== 'ImportDeclaration' || decl.source.value !== 'envalid' ||
      decl.importKind === 'type' || path.node.importKind === 'type') return undefined;
    if (path.isImportDefaultSpecifier() || path.isImportNamespaceSpecifier()) return '*';
    if (path.isImportSpecifier()) return path.node.imported.name ?? path.node.imported.value;
  }
  if (!path.isVariableDeclarator() || !isRequireOf(path.node.init, path.scope, ENVALID_MODULES)) return undefined;
  if (path.node.id.type === 'Identifier') return '*';
  if (path.node.id.type === 'ObjectPattern') {
    const prop = path.node.id.properties.find(p => p.type === 'ObjectProperty' && p.value === identifier);
    return prop ? keyName(prop) : undefined;
  }
  return undefined;
}

// Envalid defaults are output values, not input strings: even null, undefined
// and an empty string can make a setting optional. Never copy the value to output.
function isStaticEnvalidDefault(rawNode, scope) {
  const node = unwrap(rawNode);
  if (!node) return false;
  if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(node.type)) return true;
  if (node.type === 'Identifier') return node.name === 'undefined' && !scope.getBinding('undefined');
  if (node.type === 'TemplateLiteral') return node.expressions.length === 0;
  if (node.type === 'UnaryExpression' && ['+', '-'].includes(node.operator)) return unwrap(node.argument)?.type === 'NumericLiteral';
  if (node.type === 'ArrayExpression') return node.elements.every(n => n === null || isStaticEnvalidDefault(n, scope));
  if (node.type === 'ObjectExpression') return node.properties.every(p =>
    p.type === 'ObjectProperty' && !p.computed && isStaticEnvalidDefault(p.value, scope));
  return false;
}

// Contexts where `a ?? 'x'` is a condition rather than the value being defaulted.
function conditionContext(path) {
  const parent = path.parentPath;
  if (!parent) return false;
  const { node } = parent;
  if (['IfStatement', 'WhileStatement', 'DoWhileStatement', 'ForStatement', 'ConditionalExpression'].includes(node.type)) return node.test === path.node;
  return ['LogicalExpression', 'BinaryExpression', 'UnaryExpression'].includes(node.type);
}

export function scanSource(text, file) {
  text = stripLeadingBom(text);
  const usages = [];
  const findings = [];
  const unresolved = (rule, start, message) => findings.push({
    rule, severity: 'warning', message, locations: [locate(text, start ?? 0, file)],
    action: 'Use a supported direct read or add an explicit variable rule. This part of the scan is incomplete.'
  });
  let ast;
  try { ast = parse(text, parserOptions(file)); } catch {
    unresolved('SOURCE_UNREADABLE', 0, 'Source parsing failed.');
    return { usages, findings, complete: false };
  }
  if (ast.errors?.length) {
    unresolved('SOURCE_UNSUPPORTED', ast.errors[0].pos ?? 0, 'The parser recovered from syntax errors; reads in this file may be incomplete.');
  }

  const use = (name, kind, optional, start) => usages.push({ name, kind, optional, ...locate(text, start, file) });
  // Nodes whose environment access is already accounted for by a supported wrapper (e.g. T3 Env).
  const consumedEnvNodes = new Set();
  // Per-read optionality from bounded schema mappings (T3/Zod) and skipValidation.
  const overriddenOptional = new Map();

  function inspectEnvalid(callPath) {
    const { node, scope } = callPath;
    const input = unwrap(node.arguments[0]);
    const object = isMember(input) ? unwrap(input.object) : undefined;
    const isProcessEnv = isMember(input) && propertyName(input) === 'env' &&
      (isGlobalProcess(object, scope) || isRequireOf(object, scope) ||
        (object?.type === 'Identifier' && bindingRole(scope.getBinding(object.name)) === 'process'));
    const isEnvAlias = input?.type === 'Identifier' && bindingRole(scope.getBinding(input.name)) === 'env';
    if (!isProcessEnv && !isEnvAlias) {
      unresolved('SOURCE_UNSUPPORTED', node.start, 'cleanEnv input is not a supported Node environment object.');
      return;
    }
    const schema = unwrap(node.arguments[1]);
    if (node.arguments.length < 2 || node.arguments.length > 3 || schema?.type !== 'ObjectExpression') {
      unresolved('SOURCE_UNSUPPORTED', node.start, 'cleanEnv requires a static validator object and supported arguments.');
      return;
    }
    consumedEnvNodes.add(input);
    if (node.arguments.length === 3) {
      const options = unwrap(node.arguments[2]);
      if (options?.type !== 'ObjectExpression' || options.properties.length) {
        unresolved('SOURCE_UNSUPPORTED', node.arguments[2].start, 'Custom cleanEnv options or reporters are not analyzed.');
      }
    }
    for (const prop of schema.properties) {
      const name = prop.type === 'ObjectProperty' ? keyName(prop) : undefined;
      if (!name || !validName(name) || prop.computed) {
        unresolved('SOURCE_UNSUPPORTED', prop.start, 'Dynamic or invalid cleanEnv schema entry.');
        continue;
      }
      let optional = false;
      const validator = unwrap(prop.value);
      if (validator?.type !== 'CallExpression' || !ENVALID_VALIDATORS.has(envalidExport(validator.callee, scope)) ||
        validator.arguments.length > 1) {
        unresolved('SOURCE_UNSUPPORTED', prop.value.start, 'Custom or dynamic cleanEnv validator is not analyzed.');
      } else if (validator.arguments.length === 1) {
        const options = unwrap(validator.arguments[0]);
        let supported = options?.type === 'ObjectExpression';
        let hasDefault = false;
        const seen = new Set();
        for (const option of options?.type === 'ObjectExpression' ? options.properties : []) {
          const key = option.type === 'ObjectProperty' && !option.computed ? keyName(option) : undefined;
          if (!key || seen.has(key)) { supported = false; continue; }
          seen.add(key);
          if (key === 'default') {
            hasDefault = isStaticEnvalidDefault(option.value, scope);
            if (!hasDefault) supported = false;
          } else if (!['desc', 'example', 'docs', 'choices'].includes(key)) {
            // devDefault/testDefault depend on NODE_ENV; requiredWhen is executable.
            supported = false;
          }
        }
        if (!supported) unresolved('SOURCE_UNSUPPORTED', validator.start, 'Dynamic, conditional or unknown cleanEnv validator options are not analyzed.');
        else optional = hasDefault;
      }
      use(name, 'process', optional, prop.key.start);
    }
  }

  function inspectT3CreateEnv(callPath) {
    const { node, scope } = callPath;
    if (node.arguments.length !== 1) {
      unresolved('SOURCE_UNSUPPORTED', node.start, 'Unsupported createEnv call arguments.');
      return;
    }
    const arg = unwrap(node.arguments[0]);
    if (arg?.type !== 'ObjectExpression') {
      unresolved('SOURCE_UNSUPPORTED', node.start, 'createEnv options must be a static object literal.');
      return;
    }
    const props = new Map();
    for (const prop of arg.properties) {
      if (prop.type !== 'ObjectProperty') {
        unresolved('SOURCE_UNSUPPORTED', prop.start, 'Spread or method properties in createEnv options are not supported.');
        continue;
      }
      const name = keyName(prop);
      if (!name || !T3_KNOWN_OPTIONS.has(name)) {
        unresolved('SOURCE_UNSUPPORTED', prop.start, 'Unknown or computed option in createEnv.');
        continue;
      }
      props.set(name, prop.value);
    }
    if (props.has('createFinalSchema')) {
      unresolved('SOURCE_UNSUPPORTED', props.get('createFinalSchema').start, 'Custom createFinalSchema in createEnv is not analyzed.');
    }
    if (props.has('extends')) {
      const ext = unwrap(props.get('extends'));
      if (ext?.type !== 'ArrayExpression' || ext.elements.length > 0) {
        unresolved('SOURCE_UNSUPPORTED', props.get('extends').start, 'T3 Env presets in extends cannot be resolved statically.');
      }
    }

    let defaultKind = 'process';
    const sections = ['server', 'client', 'shared'].filter(s => props.has(s));
    const runtimeKeys = ['runtimeEnv', 'runtimeEnvStrict', 'experimental__runtimeEnv'].filter(k => props.has(k));
    if (runtimeKeys.length > 1) {
      unresolved('SOURCE_UNSUPPORTED', node.start, 'Multiple runtimeEnv options in createEnv are not supported.');
    }
    const runtimeKey = runtimeKeys[0];
    const runtimeNode = runtimeKey ? unwrap(props.get(runtimeKey)) : undefined;
    let runtimeMode = 'implicit';
    let stableRuntime = true;
    const runtimeEntries = new Map();

    if (runtimeKey) {
      const kind = environmentKind(runtimeNode, scope);
      if (kind) {
        defaultKind = kind;
        runtimeMode = 'whole';
        if (sections.length) consumedEnvNodes.add(runtimeNode);
      } else if (runtimeNode?.type === 'ObjectExpression') {
        runtimeMode = runtimeKey === 'experimental__runtimeEnv' ? 'experimental-map' : 'map';
        for (const item of runtimeNode.properties) {
          if (item.type !== 'ObjectProperty' || item.computed) {
            stableRuntime = false;
            unresolved('SOURCE_UNSUPPORTED', item.start, `Unsupported entry in createEnv ${runtimeKey}.`);
            continue;
          }
          const key = keyName(item);
          if (!key || !validName(key) || runtimeEntries.has(key)) {
            stableRuntime = false;
            unresolved('SOURCE_UNSUPPORTED', item.start, `Invalid or duplicate entry in createEnv ${runtimeKey}.`);
            continue;
          }
          const read = environmentRead(item.value, scope);
          if (!read) {
            unresolved('SOURCE_UNSUPPORTED', item.value.start, `createEnv ${runtimeKey} entry for ${key} is not a supported direct environment read.`);
          }
          runtimeEntries.set(key, { item, read });
        }
      } else {
        runtimeMode = 'invalid';
        unresolved('SOURCE_UNSUPPORTED', runtimeNode?.start ?? node.start, `Unsupported ${runtimeKey} in createEnv.`);
      }
    }

    let stableSchema = true;
    const schemaFields = new Map();
    for (const section of sections) {
      const secNode = unwrap(props.get(section));
      if (secNode?.type !== 'ObjectExpression') {
        stableSchema = false;
        unresolved('SOURCE_UNSUPPORTED', secNode?.start ?? node.start, `createEnv ${section} schema must be an object literal.`);
        continue;
      }
      const seenSection = new Set();
      const sectionStable = secNode.properties.every(item => {
        if (item.type !== 'ObjectProperty' || item.computed) return false;
        const name = keyName(item);
        if (!name || !validName(name) || seenSection.has(name)) return false;
        seenSection.add(name);
        return true;
      });
      if (!sectionStable) stableSchema = false;
      const seenItems = new Set();
      for (const item of secNode.properties) {
        if (item.type !== 'ObjectProperty' || item.computed) {
          unresolved('SOURCE_UNSUPPORTED', item.start, `Spread, computed or method in createEnv ${section} schema is not supported.`);
          continue;
        }
        const varName = keyName(item);
        if (!varName || !validName(varName) || seenItems.has(varName) || schemaFields.has(varName)) {
          unresolved('SOURCE_UNSUPPORTED', item.start, `Invalid or duplicate variable name in createEnv ${section} schema.`);
          continue;
        }
        seenItems.add(varName);
        const zodResult = classifyZodField(item.value, scope, { allowCoerce: true, modules: ZOD_MODULES });
        if (!zodResult.complete) {
          unresolved('SOURCE_UNSUPPORTED', item.value.start, `Schema validator or default for ${varName} in createEnv could not be statically classified.`);
        }
        schemaFields.set(varName, { section, item, optional: sectionStable && zodResult.optional });
      }
    }

    if (runtimeMode === 'map' || runtimeMode === 'experimental-map') {
      for (const [varName, field] of schemaFields) {
        if (runtimeEntries.has(varName)) {
          const { read } = runtimeEntries.get(varName);
          if (read) {
            const opt = stableSchema && stableRuntime && field.optional;
            overriddenOptional.set(read.node, opt);
            if (read.name === varName) {
              consumedEnvNodes.add(unwrap(read.node.object));
              use(varName, read.kind, opt, field.item.key.start);
            }
          }
        } else if (runtimeMode === 'experimental-map' && field.section === 'server') {
          const opt = stableSchema && field.optional;
          use(varName, defaultKind, opt, field.item.key.start);
        } else {
          unresolved('SOURCE_UNSUPPORTED', field.item.key.start, `createEnv schema field ${varName} is missing from ${runtimeKey}.`);
        }
      }
      for (const [key, entry] of runtimeEntries) {
        if (!schemaFields.has(key)) {
          unresolved('SOURCE_UNSUPPORTED', entry.item.key.start, `createEnv ${runtimeKey} entry ${key} is not declared in the schema.`);
        }
      }
    } else {
      for (const [varName, field] of schemaFields) {
        const opt = runtimeMode !== 'invalid' && stableSchema && field.optional;
        use(varName, defaultKind, opt, field.item.key.start);
      }
    }

    const skipNode = props.get('skipValidation');
    callPath.traverse({
      MemberExpression(p) {
        if (skipNode && p.node.start >= skipNode.start && p.node.end <= skipNode.end) overriddenOptional.set(p.node, true);
      },
      OptionalMemberExpression(p) {
        if (skipNode && p.node.start >= skipNode.start && p.node.end <= skipNode.end) overriddenOptional.set(p.node, true);
      }
    });
  }

  function destructure(pattern, kind) {
    for (const property of pattern.properties) {
      if (property.type !== 'ObjectProperty') { unresolved('SOURCE_UNSUPPORTED', property.start, 'Unsupported environment destructuring.'); continue; }
      const name = keyName(property);
      if (!name || !validName(name)) { unresolved('SOURCE_UNSUPPORTED', property.start, 'Unsupported environment destructuring.'); continue; }
      let value = property.value;
      let fallback;
      if (value.type === 'AssignmentPattern') { fallback = classifyDefault(value.right); value = value.left; }
      if (value.type !== 'Identifier') { unresolved('SOURCE_UNSUPPORTED', property.key.start, 'A nested environment binding could not be interpreted.'); continue; }
      if (fallback === 'computed') unresolved('SOURCE_UNSUPPORTED', property.key.start, 'A destructuring fallback could not be classified as a usable default.');
      use(name, kind, fallback === 'literal', property.key.start);
    }
  }

  // `envPath` is an expression that evaluates to the environment object.
  function environment(envPath, kind, start) {
    const ref = outer(envPath);
    if (consumedEnvNodes.has(ref.node) || consumedEnvNodes.has(envPath.node)) return;
    const parent = ref.parentPath;
    const { node } = parent;
    if (isMember(node) && node.object === ref.node) {
      const name = propertyName(node);
      if (!name || !validName(name)) { unresolved('UNRESOLVED_ENV_ACCESS', start, 'An environment object is accessed dynamically or through an unsupported alias.'); return; }
      const read = outer(parent);
      const context = read.parentPath?.node;
      if (context?.type === 'AssignmentExpression' && context.left === read.node) return; // write, including ??=
      if (context?.type === 'UpdateExpression' || (context?.type === 'UnaryExpression' && context.operator === 'delete')) return;
      let optional = (context?.type === 'UnaryExpression' && context.operator === 'typeof') || overriddenOptional.get(node) === true;
      if (context?.type === 'LogicalExpression' && context.left === read.node && ['??', '||'].includes(context.operator)) {
        const fallback = classifyDefault(context.right);
        if (fallback === 'literal' && !conditionContext(read.parentPath)) optional = true;
        else if (fallback !== 'empty') unresolved('SOURCE_UNSUPPORTED', start, 'A computed fallback could not be classified as a usable default.');
      }
      use(name, kind, optional, start);
      return;
    }
    if (node.type === 'BinaryExpression' && node.operator === 'in' && node.right === ref.node) {
      const left = unwrap(node.left);
      if (left?.type === 'StringLiteral' && validName(left.value)) {
        use(left.value, kind, true, left.start);
        return;
      }
      unresolved('UNRESOLVED_ENV_ACCESS', start, 'An environment object is accessed dynamically or through an unsupported alias.');
      return;
    }
    if (node.type === 'VariableDeclarator' && node.init === ref.node) {
      if (node.id.type === 'ObjectPattern' && !isExportedDeclarator(parent)) return destructure(node.id, kind);
      if (node.id.type === 'Identifier') {
        const role = bindingRole(parent.scope.getBinding(node.id.name));
        if (role === 'env' || role === 'vite-env') return;
      }
    }
    if (node.type === 'AssignmentExpression' && node.right === ref.node && node.left.type === 'ObjectPattern') return destructure(node.left, kind);
    if (node.type === 'AssignmentPattern' && node.right === ref.node && node.left.type === 'ObjectPattern') return destructure(node.left, kind);
    unresolved('UNRESOLVED_ENV_ACCESS', start, 'An environment object is accessed dynamically or through an unsupported alias.');
  }

  // Given an expression that is the process object, find a following `.env` or `{ env } = process`.
  function processObject(objectPath, start) {
    const ref = outer(objectPath);
    const parent = ref.parentPath?.node;
    if (isMember(parent) && parent.object === ref.node && propertyName(parent) === 'env') {
      environment(ref.parentPath, 'process', start);
      return;
    }
    if (parent?.type === 'VariableDeclarator' && parent.init === ref.node && parent.id.type === 'ObjectPattern') {
      for (const prop of parent.id.properties) {
        if (prop.type === 'RestElement') {
          unresolved('UNRESOLVED_ENV_ACCESS', prop.start, 'An environment object is accessed dynamically or through an unsupported alias.');
          continue;
        }
        if (prop.type !== 'ObjectProperty' || keyName(prop) !== 'env') continue;
        if (isExportedDeclarator(ref.parentPath)) {
          unresolved('UNRESOLVED_ENV_ACCESS', prop.start, 'An environment object is accessed dynamically or through an unsupported alias.');
        } else if (prop.value.type === 'ObjectPattern') {
          destructure(prop.value, 'process');
        } else if (prop.value.type === 'Identifier') {
          if (bindingRole(ref.scope.getBinding(prop.value.name)) !== 'env') {
            unresolved('UNRESOLVED_ENV_ACCESS', prop.start, 'An environment object is accessed dynamically or through an unsupported alias.');
          }
        } else {
          unresolved('SOURCE_UNSUPPORTED', prop.start, 'Unsupported environment destructuring.');
        }
      }
    }
  }

  // Pre-pass: account for supported wrappers before visiting their inner environment expressions.
  traverse(ast, {
    CallExpression(path) {
      inspectZodParse(path, {
        environmentKind,
        environmentRead,
        override: (node, optional) => overriddenOptional.set(node, optional),
        consume: node => consumedEnvNodes.add(node), use, unresolved
      });
      const callee = unwrap(path.node.callee);
      if (envalidExport(callee, path.scope) === 'cleanEnv') inspectEnvalid(path);
      if (t3Export(callee, path.scope) === 'createEnv') inspectT3CreateEnv(path);
      if (isRequireOf(path.node, path.scope, T3_ENV_MODULES)) {
        const ref = outer(path);
        const parent = ref.parentPath;
        const directCall = isMember(parent?.node) && parent.node.object === ref.node &&
          propertyName(parent.node) === 'createEnv' &&
          outer(parent).parentPath?.node.type === 'CallExpression' &&
          outer(parent).parentPath.node.callee === outer(parent).node;
        const validDeclarator = parent?.isVariableDeclarator() && parent.node.init === ref.node &&
          parent.parentPath?.node.kind === 'const' && (
            parent.node.id.type === 'Identifier' ||
            (parent.node.id.type === 'ObjectPattern' && parent.node.id.properties.every(p =>
              p.type === 'ObjectProperty' && !p.computed && keyName(p) === 'createEnv' && p.value.type === 'Identifier')));
        if (!directCall && !validDeclarator) {
          unresolved('SOURCE_UNSUPPORTED', path.node.start, 'Unsupported T3 Env require binding or usage.');
        }
      }
    }
  });

  const scopeWarned = new Set();
  traverse(ast, {
    ImportDeclaration(path) {
      const src = path.node.source?.value;
      if (!src || !T3_ENV_MODULES.has(src) || path.node.importKind === 'type') return;
      for (const spec of path.node.specifiers) {
        if (spec.importKind === 'type') continue;
        if (spec.type === 'ImportSpecifier' && (spec.imported.name ?? spec.imported.value) !== 'createEnv') {
          unresolved('SOURCE_UNSUPPORTED', spec.start ?? path.node.start, 'Unsupported T3 Env import specifier.');
        }
      }
    },
    ExportNamedDeclaration(path) {
      const src = path.node.source?.value;
      if (!src || !PROCESS_MODULES.has(src) || path.node.exportKind === 'type') return;
      for (const spec of path.node.specifiers) {
        if (spec.exportKind === 'type') continue;
        const local = spec.local?.type === 'Identifier' ? spec.local.name : spec.local?.value;
        if (!local || local === 'env' || local === 'default') {
          unresolved('UNRESOLVED_ENV_ACCESS', spec.start ?? path.node.start, 'An environment object is re-exported across module boundaries.');
        }
      }
    },
    ExportAllDeclaration(path) {
      const src = path.node.source?.value;
      if (src && PROCESS_MODULES.has(src) && path.node.exportKind !== 'type') {
        unresolved('UNRESOLVED_ENV_ACCESS', path.node.start, 'An environment object is re-exported across module boundaries.');
      }
    },
    MetaProperty(path) {
      if (path.node.meta.name !== 'import' || path.node.property.name !== 'meta') return;
      const parent = path.parentPath?.node;
      if (isMember(parent) && parent.object === path.node && propertyName(parent) === 'env') environment(path.parentPath, 'vite', path.node.start);
    },
    Identifier(path) {
      if (!path.isReferencedIdentifier()) return;
      const { name } = path.node;
      const binding = path.scope.getBinding(name);
      if (name === 'process' && !binding) return processObject(path, path.node.start);
      if ((name === 'globalThis' || name === 'global') && !binding) {
        const parent = path.parentPath?.node;
        if (isMember(parent) && parent.object === path.node && propertyName(parent) === 'process') processObject(path.parentPath, path.node.start);
        return;
      }
      if (!binding) return;
      const t3Role = t3Export(path.node, path.scope);
      if (t3Role === 'createEnv') {
        const ref = outer(path);
        if (ref.parentPath?.node.type !== 'CallExpression' || ref.parentPath.node.callee !== ref.node) {
          unresolved('SOURCE_UNSUPPORTED', path.node.start, 'createEnv alias or higher-order usage is not supported.');
        }
        return;
      }
      if (t3Role === '*') {
        const ref = outer(path);
        const parent = ref.parentPath;
        const validMemberCall = isMember(parent?.node) && parent.node.object === ref.node &&
          propertyName(parent.node) === 'createEnv' &&
          outer(parent).parentPath?.node.type === 'CallExpression' &&
          outer(parent).parentPath.node.callee === outer(parent).node;
        if (!validMemberCall) {
          unresolved('SOURCE_UNSUPPORTED', path.node.start, 'Unsupported T3 Env namespace usage.');
        }
        return;
      }
      const role = bindingRole(binding);
      if (role === 'process') return processObject(path, path.node.start);
      if (role === 'env') return environment(path, 'process', path.node.start);
      if (role === 'vite-env') return environment(path, 'vite', path.node.start);
      if (name === 'process') {
        const ref = outer(path);
        const parent = ref.parentPath?.node;
        const accessesEnv = (isMember(parent) && propertyName(parent) === 'env') ||
          (parent?.type === 'VariableDeclarator' && parent.init === ref.node && parent.id.type === 'ObjectPattern' &&
            parent.id.properties.some(p => p.type === 'RestElement' || (p.type === 'ObjectProperty' && keyName(p) === 'env')));
        if (accessesEnv && !scopeWarned.has(binding)) {
          scopeWarned.add(binding);
          unresolved('SOURCE_SCOPE_UNRESOLVED', binding.identifier.start, 'A local process binding makes Node reads through it ambiguous; they were not interpreted.');
        }
      }
    }
  });
  usages.sort((a, b) => a.line - b.line || a.column - b.column);
  return { usages, findings, complete: findings.length === 0 };
}
