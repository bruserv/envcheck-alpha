import fs from 'node:fs/promises';
import { scanSource } from '../src/source.mjs';

const cases = JSON.parse(await fs.readFile(new URL('../benchmarks/source-cases.json', import.meta.url), 'utf8'));
let truePositives = 0;
let falsePositives = 0;
let falseNegatives = 0;
let requiredCorrect = 0;
let requiredMismatches = 0;
let incompleteCases = 0;
let expectedIncompleteCases = 0;
let unexpectedIncompleteCases = 0;
let missedIncompleteCases = 0;
const results = [];

for (const entry of cases) {
  const files = entry.files ?? [{ file: entry.file, source: entry.source }];
  const fileResults = files.map(f => scanSource(f.source, f.file));
  const complete = fileResults.every(r => r.complete);
  const usages = fileResults.flatMap(r => r.usages);
  const findings = fileResults.flatMap(r => r.findings);

  const actual = new Set(usages.map(u => u.name));
  const expected = new Set(entry.expected);
  const missed = [...expected].filter(name => !actual.has(name));
  const extra = [...actual].filter(name => !expected.has(name));
  const detectedExpected = [...actual].filter(name => expected.has(name));

  const actualRequired = {};
  for (const name of actual) {
    actualRequired[name] = usages.filter(u => u.name === name).some(u => !u.optional);
  }

  const caseRequiredMismatches = [];
  for (const name of detectedExpected) {
    const expReq = entry.required?.[name] ?? true;
    const actReq = actualRequired[name];
    if (actReq === expReq) requiredCorrect += 1;
    else {
      requiredMismatches += 1;
      caseRequiredMismatches.push({ name, expected: expReq, actual: actReq });
    }
  }

  const actualUnknown = !complete;
  const expectedUnknown = Boolean(entry.unknown);
  truePositives += detectedExpected.length;
  falsePositives += extra.length;
  falseNegatives += missed.length;
  incompleteCases += Number(actualUnknown);
  expectedIncompleteCases += Number(expectedUnknown);
  unexpectedIncompleteCases += Number(actualUnknown && !expectedUnknown);
  missedIncompleteCases += Number(!actualUnknown && expectedUnknown);

  results.push({
    name: entry.name,
    category: entry.category ?? 'synthetic',
    ...(entry.origin ? { origin: entry.origin } : {}),
    complete,
    expectedUnknown,
    ...(entry.unknownReason ? { unknownReason: entry.unknownReason } : {}),
    findingRules: [...new Set(findings.map(f => f.rule))],
    expected: [...expected],
    detected: [...actual],
    missed,
    extra,
    expectedRequired: entry.required ?? {},
    actualRequired,
    requiredMismatches: caseRequiredMismatches
  });
}

const report = {
  schemaVersion: 2,
  dataset: 'synthetic-and-pinned-real-world-source-cases',
  summary: {
    cases: cases.length,
    syntheticCases: results.filter(r => r.category === 'synthetic').length,
    realWorldCases: results.filter(r => r.category === 'real-world').length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null,
    recall: truePositives + falseNegatives ? truePositives / (truePositives + falseNegatives) : null,
    requiredCorrect,
    requiredMismatches,
    incompleteCases,
    expectedIncompleteCases,
    unexpectedIncompleteCases,
    missedIncompleteCases
  },
  results,
  note: 'Diagnostic measurements on synthetic and commit-pinned real-world source cases. Misses, false alarms, requiredness mismatches, and incomplete (unknown) analysis are reported separately. This command is not a passing accuracy gate.'
};

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`EnvCheck benchmark: ${cases.length} cases (${report.summary.syntheticCases} synthetic, ${report.summary.realWorldCases} real-world)`);
  console.log(`Variable names: ${truePositives} correct, ${falsePositives} false alarms, ${falseNegatives} missed.`);
  console.log(`Requiredness (on ${truePositives} detected expected vars): ${requiredCorrect} correct, ${requiredMismatches} mismatches.`);
  console.log(`Incomplete (unknown) analysis: ${incompleteCases} incomplete cases (${expectedIncompleteCases} expected, ${unexpectedIncompleteCases} unexpected, ${missedIncompleteCases} missed unknown).`);
  for (const result of results) {
    if (!result.missed.length && !result.extra.length && !result.requiredMismatches.length && result.complete === !result.expectedUnknown) continue;
    const parts = [];
    if (result.missed.length) parts.push(`missed [${result.missed.join(', ')}]`);
    if (result.extra.length) parts.push(`false alarms [${result.extra.join(', ')}]`);
    if (result.requiredMismatches.length) parts.push(`requiredness mismatches [${result.requiredMismatches.map(m => `${m.name}: expected=${m.expected} actual=${m.actual}`).join(', ')}]`);
    if (!result.complete) parts.push(`incomplete (${result.findingRules.join(', ')})`);
    console.log(`- ${result.name}: ${parts.join('; ')}`);
  }
  console.log(report.note);
}
