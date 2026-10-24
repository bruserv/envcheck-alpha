# Diagnostic benchmark

Run `node scripts/benchmark.mjs --json` (no application code is executed). The unchanged source corpus contains 42 cases: 33 synthetic and 9 commit-pinned real-world snippets. This is a diagnostic corpus, not an accuracy gate or representative sample.

It reports name hits, false positives and misses, requiredness matches/mismatches, expected and unexpected incomplete analysis. The retained baseline is 56 correct names, 0 false positives, 12 missed names, requiredness 49 correct / 7 mismatches and 16 expected unknown cases. No expectations were changed to improve the score. The historical NODE_ENV:false expectation remains despite an independent raw read; inferred requiredness is conservative source evidence, not a proven runtime need.

Nine missed cross-file names in unjs/std-env and three relative-import names in af/envalid remain. Six computed-fallback requirements in env-paths and the independent NODE_ENV requirement account for seven mismatches. Unknown cases must remain visible.

See the [source corpus](../benchmarks/source-cases.json), [provenance](../benchmarks/provenance.json) and [full MIT notices](../benchmarks/LICENSES.md). These files and this guide are checkout-only and are excluded from npm payloads.
