# Contributing

## Setup

Use Node.js 22.12 or newer and the pnpm version declared in `package.json`.

```sh
pnpm install
pnpm check
```

## Changes

- Keep credentials and customer data out of tests, fixtures, issues, and commits.
- Add tests for behavior changes.
- Keep write operations gated by `JOBBOSS2_ALLOW_WRITES`.
- Do not add automatic retries for POST or PATCH requests without a documented idempotency contract.
- Run `pnpm sync:openapi` only when updating the API catalog, then review the generated diff.

Open a focused pull request and explain any user-visible MCP tool or configuration changes.
