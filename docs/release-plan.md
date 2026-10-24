# EnvCheck 0.2.0-alpha.1: release candidate plan

Status: local candidate pending owner approval. No public repository, Git history, tag or release is created by this preparation. npm remains unpublished, the working name is envcheck-workbench and private:true remains set.

The intended first alpha identifier is consistently 0.2.0-alpha.1 in package.json, lockfile, CLI/API VERSION, installation instructions and CHANGELOG. A possible later tag is v0.2.0-alpha.1; it does not exist. The artifact is envcheck-workbench-0.2.0-alpha.1.tgz with its separately verified SHA256SUMS. Do not reuse a checksum from an older archive. The archive checksum is supplied beside the archive rather than embedded into its own README.

After approval of the exact public file inventory and artifact: initialize fresh history using only this candidate tree; confirm author identity and destination; run the configured eight-job CI matrix on that new exact commit before making remote validation claims. Any GitHub repository creation, push, tag or release requires separate authorization. Do not change visibility of the private development repository. A public source release does not authorize publishing npm or changing the working package name/private flag.

If any public file changes, regenerate the inventory, audit documentation links, rerun relevant checks and rebuild/retest the archive with a new checksum. Dependency installation needs registry access or a complete cache; offline cache absence is blocked, not passed.

Suggested alpha description: a local CLI, ESM API and portable skill for developers/agents reviewing environment declarations, bounded source requirements and one selected Compose service. Invite testers to try their own app, inspect previews and report incorrect/missing findings with minimal sanitized source. Do not claim production readiness, unique coverage, secret validity or application startup. Unknowns, the diagnostic benchmark misses/mismatches, and the lack of remote validation of this export remain explicit. See [limitations](limitations.md).
