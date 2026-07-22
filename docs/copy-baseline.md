# Historical copy baseline (audit record)

> Historical evidence only. This file records the original copy-first baseline and is not a description of the current package, dependency, or runtime contract.

The LLM source was copied as a tracked-file baseline before its standalone SDK integration. The source tree was left untouched; generated directories and local caches were excluded. The baseline recorded legacy SDK, host, settings, and shared-database coupling so that later migration work could be audited.

Current state is documented in the root README and the package-shipped consumer guides. The current plugin resolves `@ss-helper/sdk@0.0.1` from its vendored tgz, exposes typed services through Core, registers ordinary settings through the Core Settings Host, and stores all LLM state in the generic `ss-helper.llm/llm:global` workspace. Provider credentials are encrypted SecretPort values rather than ordinary Workspace records; configuration exports exclude them and custom Providers must support CORS.

Historical assertions about development-machine locations, migration phases, or expected standalone build failures have been removed because they are not durable consumer guidance.
