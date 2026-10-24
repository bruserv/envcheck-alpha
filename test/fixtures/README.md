# Test fixture provenance

The test files construct inert synthetic inputs for the scanner; they do not execute application code, Zod callbacks or containers. Except for the reduced motivating pattern below, test/fixtures/zod-outer-presence.json was authored for EnvCheck under the project MIT license.

The CORS transform/pipe/optional pattern (cors-optional and cors-nullish, adapted with synthetic variable names) is reduced from [JamieLivingstone/node-clean-architecture](https://github.com/JamieLivingstone/node-clean-architecture/blob/c94aacef32c7da8c0a1282ed4b78f7e284e6e90c/src/infrastructure/config/index.ts), commit c94aacef32c7da8c0a1282ed4b78f7e284e6e90c, src/infrastructure/config/index.ts. The original declared zod ^4.3.5; this does not establish an installed version or runtime semantics. Its [full MIT license and copyright](LICENSE.node-clean-architecture) are retained unchanged. No full external application is included.

The benchmark snippets used by some tests have separate [pinned provenance](../../benchmarks/provenance.json) and [MIT notices](../../benchmarks/LICENSES.md). Source strings and expected names/requiredness in that corpus are unchanged.
