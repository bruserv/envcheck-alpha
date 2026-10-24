#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scanProject, VERSION } from './scan.mjs';
import { explainVariable, formatExplanation, formatPlan, formatReport, makePlan } from './format.mjs';
import { installSkill } from './skills.mjs';
import { exists, projectPath } from './files.mjs';
import { validName } from './config.mjs';
import { compareProjects, formatComparison, formatComparisonMarkdown } from './compare.mjs';
import { compareGit } from './git.mjs';
import { fixCompose, fixExample, formatComposeRepair, formatRepair } from './fix.mjs';

const help = `EnvCheck ${VERSION} — evidence-based configuration checks

Usage:
  envcheck scan [project] [--json] [--no-values] [--strict]
  envcheck explain VARIABLE [project] [--json] [--no-values] [--strict]
  envcheck plan [project] [--json] [--no-values]
  envcheck fix-example [project] [--apply] [--json] [--strict]
  envcheck fix-compose [project] [--apply] [--json] [--strict]
  envcheck compare BEFORE_PROJECT AFTER_PROJECT [--json] [--markdown] [--strict]
  envcheck compare [project] --base REF [--head REF] [--merge-base] [--json] [--markdown] [--strict]
  envcheck init [project]
  envcheck skill install [project] --agent codex|claude|both

Examples:
  envcheck scan /path/to/app
    Scan a project for missing declarations and undocumented variables.
  envcheck compare /path/to/app --base main
    Compare the working tree against local Git ref 'main' without checkout.
  envcheck fix-compose /path/to/app
    Preview Compose service declarations (writing repairs requires --apply).

Project defaults to the current directory. Configure scope in envcheck.config.json.
Configuration reference: docs/configuration.md inside the installed envcheck-workbench package.
--apply      Write repairs to disk (fix-example and fix-compose default to preview).
--merge-base Compare against the merge-base ancestor of REF and target (HEAD or --head).
--no-values  Skip local envFiles value checks (useful in CI).
--strict     Fail on warnings as well as errors.
--json       Emit a versioned, value-free JSON report.
--markdown   Emit a Markdown summary for compare (useful for PR descriptions).

Exit codes: 0 = no blocking findings; 1 = findings; 2 = invocation/input failure.
The scanner never runs project code, contacts services or treats shell values as application configuration.
`;

async function main() {
  let args;
  try {
    args = parseArgs({ options: {
      json: { type: 'boolean', default: false },
      markdown: { type: 'boolean', default: false },
      'merge-base': { type: 'boolean', default: false },
      'no-values': { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      agent: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }
    }, allowPositionals: true, strict: true });
  } catch { throw new Error('Invalid CLI options. Run envcheck --help.'); }
  if (args.values.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (args.values.help || !args.positionals.length) { process.stdout.write(help); return; }
  const [command, ...positionals] = args.positionals;
  const options = args.values;
  if (!['scan', 'explain', 'plan', 'fix-example', 'fix-compose', 'compare', 'init', 'skill'].includes(command)) throw new Error('Unknown command. Run envcheck --help.');
  if (options.apply && !['fix-example', 'fix-compose'].includes(command)) throw new Error('--apply is only valid with fix-example or fix-compose.');
  if (options.agent && command !== 'skill') throw new Error('--agent is only valid with skill install.');
  if (options.markdown && command !== 'compare') throw new Error('--markdown is only valid with compare.');
  if (options.json && options.markdown) throw new Error('--json and --markdown cannot be used together.');
  if ((options.base || options.head || options['merge-base']) && command !== 'compare') throw new Error('--base, --head and --merge-base are only valid with compare.');
  if (options.head && !options.base) throw new Error('--head requires --base.');
  if (options['merge-base'] && !options.base) throw new Error('--merge-base requires --base.');
  if (command === 'compare') {
    if (options.base ? positionals.length > 1 : positionals.length !== 2) throw new Error('Use compare BEFORE AFTER, or compare [project] --base REF [--head REF].');
    const report = options.base
      ? await compareGit(path.resolve(positionals[0] ?? '.'), { base: options.base, head: options.head, mergeBase: options['merge-base'], tempDir: process.env.ENVCHECK_TMPDIR })
      : await compareProjects(path.resolve(positionals[0]), path.resolve(positionals[1]));
    if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else if (options.markdown) process.stdout.write(formatComparisonMarkdown(report));
    else process.stdout.write(formatComparison(report));
    process.exitCode = report.summary.currentErrors || report.summary.blockingChanges || (options.strict && (!report.scope.complete || report.summary.currentWarnings || report.changes.some(c => c.severity === 'warning'))) ? 1 : 0;
    return;
  }
  if (command === 'skill') {
    if (positionals[0] !== 'install' || positionals.length > 2) throw new Error('Use skill install [project] --agent codex|claude|both.');
    if (options['no-values'] || options.strict) throw new Error('Scan options do not apply to skill installation.');
    const result = await installSkill(path.resolve(positionals[1] ?? '.'), options.agent);
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' : `EnvCheck skill installed for ${options.agent}; ${result.filesAdded} file(s) added.\nStart a new agent session if the skill is not discovered yet.\n`);
    return;
  }
  const isExplain = command === 'explain';
  if (positionals.length > (isExplain ? 2 : 1)) throw new Error('Too many positional arguments. Run envcheck --help.');
  if (isExplain && (!positionals[0] || !validName(positionals[0]))) throw new Error('explain requires a valid variable name.');
  const root = path.resolve(positionals[isExplain ? 1 : 0] ?? '.');
  if (command === 'fix-example') {
    const result = await fixExample(root, { apply: options.apply });
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' : formatRepair(result));
    process.exitCode = result.report.summary.errors || (options.strict && (!result.report.scope.complete || result.report.summary.warnings)) ? 1 : 0;
    return;
  }
  if (command === 'fix-compose') {
    const result = await fixCompose(root, { apply: options.apply });
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' : formatComposeRepair(result));
    process.exitCode = result.report.summary.errors || (options.strict && (!result.report.scope.complete || result.report.summary.warnings)) ? 1 : 0;
    return;
  }
  if (command === 'init') {
    if (options['no-values'] || options.strict) throw new Error('Scan options do not apply to init.');
    const actualRoot = await fs.realpath(root);
    const target = await projectPath(actualRoot, 'envcheck.config.json', true);
    if (await exists(target)) throw new Error('envcheck.config.json already exists; it was not changed.');
    const config = { version: 1, sources: [await exists(await projectPath(actualRoot, 'src', true)) ? 'src' : '.'], example: '.env.example', envFiles: ['.env'], variables: {} };
    await fs.writeFile(target, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(options.json ? JSON.stringify({ created: 'envcheck.config.json' }) + '\n' : 'Created envcheck.config.json. Select one app/service before enabling Compose checks.\n');
    return;
  }
  const report = await scanProject(root, { noValues: options['no-values'] });
  if (isExplain) {
    const explanation = explainVariable(report, positionals[0]);
    process.stdout.write(options.json ? JSON.stringify(explanation, null, 2) + '\n' : formatExplanation(explanation));
    // found retains its source/rule-list meaning; related example findings do
    // not change it or the existing not-found/project-wide exit semantics.
    if (!explanation.found) { process.exitCode = 1; return; }
  } else if (command === 'plan') {
    const plan = makePlan(report);
    process.stdout.write(options.json ? JSON.stringify(plan, null, 2) + '\n' : formatPlan(plan));
  } else process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report));
  process.exitCode = report.summary.errors || (options.strict && report.summary.warnings) ? 1 : 0;
}

main().catch(error => {
  // Do not print parser messages or source snippets that might contain credentials.
  const known = error instanceof Error && !error.code && !error.message.includes('\n') ? error.message : 'Input could not be read. Check the selected root, relative paths and file permissions.';
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ schemaVersion: 1, error: { code: 'INPUT_ERROR', message: known } }, null, 2) + '\n');
  else process.stderr.write(`EnvCheck: ${known}\n`);
  process.exitCode = 2;
});
