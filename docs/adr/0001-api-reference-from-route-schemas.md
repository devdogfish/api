# API Reference from Route Schemas

Girke API will generate its API reference from Zod-backed Hono route schemas instead of maintaining a separate hand-written OpenAPI file. The runtime app serves an OpenAPI JSON document and a Scalar reference UI from those schemas, so request validation and API documentation share the same source of truth.

## Considered Options

- Route schemas in code via `@hono/zod-openapi`
- A manually maintained OpenAPI JSON or YAML file
- Generated documentation from Markdown specs

## Consequences

Every current and future API route needs a route schema as part of the implementation. Request validation is enforced from those schemas; response schemas document the contract, with runtime response validation left as an optional later hardening step.
