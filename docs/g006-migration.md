# Historical LLM migration evidence (audit record)

> Historical evidence only. This document preserves the migration design evidence; it is not a current release, package, or consumer-installation guide.

The migration established these durable ownership boundaries:

- The LLM plugin consumes the vendored `@ss-helper/sdk@1.0.0` package rather than sibling source.
- Core owns the plugin session, typed registration surface, ordinary settings host, popup host, and Tavern generation capability.
- The LLM plugin exposes typed completion, structured-task, embedding, rerank, diagnostics, and route-change contracts.
- `SSHelperLLMDatabase` owns only LLM credentials, request logs, and payload-free migration evidence. Cutover validates the frozen legacy schema, copies only those stores transactionally, verifies parity, and retains the legacy data for fallback or rollback.
- Browser migration verification runs the production module against browser IndexedDB; `fake-indexeddb` is the fast unit-test layer.

Use the root README for current commands and `docs/integration-manual.md` for the supported consumer API.
