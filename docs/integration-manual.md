# SS-Helper LLM typed integration manual

SS-Helper LLM is consumed only through the public `@ss-helper/sdk` contracts exposed by SS-Helper Core. Consumers must not read a legacy cross-plugin global, import LLM internals, mount LLM settings, or call raw SillyTavern APIs.

## Connect and call a service

Use a Core-managed plugin session and a typed service token. The session owns timeout, abort, Core reload, and disposal behavior.

```ts
import {
  LLM_STRUCTURED_TASK_V0,
  bootstrapSSHelper,
} from '@ss-helper/sdk';

const bootstrap = await bootstrapSSHelper({
  id: 'example.consumer',
  displayName: 'Example consumer',
  pluginVersion: '0.0.1',
  capabilities: [],
}, async (session) => {
  const result = await session.services.call(LLM_STRUCTURED_TASK_V0, {
    task: 'summarize',
    input: { text: 'Plain-data input' },
    outputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
    timeoutMs: 30_000,
  });

  console.log(result.output);
});

// Plugin shutdown:
bootstrap.dispose();
```

Every request and response is plain data. Do not place DOM nodes, functions, storage handles, SDK/Core private objects, or raw host objects in a DTO.

## Public LLM contracts

Import tokens from the package root only:

- `LLM_COMPLETION_V0` — chat-style text completion.
- `LLM_STRUCTURED_TASK_V0` — schema-constrained structured tasks.
- `LLM_EMBEDDING_V0` — one or more embedding inputs.
- `LLM_RERANK_V0` — provider-backed document reranking.
- `LLM_ROUTE_DIAGNOSTICS_V0` — payload-safe route diagnostics.
- `LLM_ROUTE_CHANGED_V0` — typed route-change event.

Calls accept the SDK-provided `AbortSignal` through the service context. Provider timeout, cancellation, disposal, late results, and Core replacement are handled by the typed service/session lifecycle; consumers must not build a second RPC bus or global compatibility bridge.

## Embedding example

```ts
import { LLM_EMBEDDING_V0 } from '@ss-helper/sdk';

const response = await session.services.call(LLM_EMBEDDING_V0, {
  input: ['first document', 'second document'],
});

console.log(response.embeddings);
```

## Rerank example

```ts
import { LLM_RERANK_V0 } from '@ss-helper/sdk';

const response = await session.services.call(LLM_RERANK_V0, {
  query: 'matching query',
  documents: [
    { id: 'a', text: 'first document' },
    { id: 'b', text: 'second document' },
  ],
  topN: 2,
});
```

Rerank fails closed when no native rerank provider is available; a lexical fallback is not reported as a provider result.

## Settings and personalized UI

Ordinary LLM settings are registered by the LLM plugin through the single Core Settings Host. A consumer must not create another settings root or mutate LLM storage directly. Personalized advanced routing UI is opened only through the registered Core popup token; arbitrary settings HTML is not a public API.

## Availability and cleanup

Use SDK connection/reconnect behavior rather than polling globals. Keep the returned bootstrap handle for shutdown, and register listeners/services through the session so Core replacement or plugin disposal releases them deterministically.
