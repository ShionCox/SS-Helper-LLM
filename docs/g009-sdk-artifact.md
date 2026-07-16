# SDK artifact consumption

## Current package identity

This plugin consumes the public SS-Helper SDK package below:

- Package: `@ss-helper/sdk@2.0.0`
- Local artifact: `vendor/ss-helper-sdk-2.0.0.tgz`
- SHA-256: `1e40f5510e817292c4b9a7510ac536da725b8410de4b3c2ce0c89ceac28902dd`
- Resolution: the root pnpm override pins `@ss-helper/sdk` to the vendored tgz.

The dependency is intentionally package-based. It has no workspace, link, sibling-source, or machine-specific absolute-path dependency.

## Core and LLM boundary

Core owns session bootstrap/reconnect, typed service and event registration, host capabilities, settings hosting, and popup hosting. The LLM plugin consumes those SDK contracts and exposes completion, structured-task, embedding, rerank, route-diagnostics, and route-change surfaces. It does not embed Core, a SillyTavern adapter, or a second RPC/global bridge.

For consumer usage, see [integration-manual.md](integration-manual.md).
