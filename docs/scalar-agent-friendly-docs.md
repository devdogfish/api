# Agent-Friendly Scalar Docs

Goal: do not make agents scrape `/reference` HTML. Treat Scalar UI as human-facing, and expose small, structured, Markdown/API surfaces for machines.

## Recommended Layers

1. Keep `/reference` as the Scalar API Reference for humans.
2. Keep `/openapi.json` as the canonical machine contract.
3. Add `/llms.txt`, generated from the same OpenAPI document with `@scalar/openapi-to-markdown`.
4. Add optional per-operation Markdown routes, e.g. `/llms/operations/{operationId}.md`, so agents can fetch one endpoint instead of reading the full reference.
5. Use Scalar Agent/MCP when agents need to call the API, not just read docs.

## Why

Scalar’s Hono docs explicitly recommend a “Markdown for LLMs” route: install `@scalar/openapi-to-markdown`, generate Markdown from the OpenAPI document, and serve it at `/llms.txt`. For Zod OpenAPI Hono, Scalar shows using `app.getOpenAPI31Document(...)` as the source.

The same package supports targeted Markdown generation for a single operation by `operationId`, by `path + method`, or by JSON pointer. That is the best fit for efficient agent lookup.

Scalar Agent/MCP is the higher-level path for tool use. Scalar says it indexes uploaded OpenAPI documents, exposes lean just-in-time tools, supports delegated auth, and avoids dumping large API specs into the model context. Its MCP setup also lets teams choose endpoint exposure and set endpoints to lookup-only (`Search`) or real execution (`Execute`).

## Sources

- Scalar Hono integration, “Markdown for LLMs”: https://scalar.com/products/api-references/integrations/hono
- Scalar OpenAPI-to-Markdown package: https://github.com/scalar/scalar/blob/main/packages/openapi-to-markdown/README.md
- Scalar MCP & Agent overview: https://scalar.com/products/agent/getting-started
- Scalar MCP Servers: https://scalar.com/products/agent/mcp
- Agent in Scalar API Reference: https://scalar.com/products/agent/api-reference
- Scalar Docs OpenAPI sources: https://scalar.com/products/docs/configuration/navigation
- `/llms.txt` proposal: https://llmstxt.org/
