# Historical LLM migration evidence (audit record)

> Historical evidence only. This document preserves the migration design evidence; it is not a current release, package, or consumer-installation guide.

The historical migration established these boundaries; they are superseded by the new workspace architecture:

- The LLM plugin consumes the vendored `@ss-helper/sdk@0.0.1` package rather than sibling source.
- Core owns the plugin session, typed registration surface, ordinary settings host, popup host, and Tavern generation capability.
- The LLM plugin exposes typed completion, structured-task, embedding, rerank, diagnostics, and route-change contracts.
- The former `SSHelperLLMDatabase`/IndexedDB path is no longer used. No old data is discovered, migrated, imported, or deleted.
- LLM state now lives in the SDK workspace `owner=ss-helper.llm`, `workspace=llm:global`; API keys use SDK AES-256-GCM Secret storage and are excluded from backups.
- Browser verification uses the current workspace adapter and Tavern fallback; legacy migration tests are retained only as historical evidence.

Use the root README for current commands and `docs/integration-manual.md` for the supported consumer API.
