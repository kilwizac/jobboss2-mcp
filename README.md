# JobBOSS2 MCP server

An unofficial [Model Context Protocol](https://modelcontextprotocol.io/) server for the
[JobBOSS² Public API](https://integrations.ecimanufacturing.com/api.html?family=jb2).

The server targets JobBOSS² API v2, which ECI recommends for agents. It covers all 230 operations in
ECI's v2 OpenAPI document, groups 217 of them into focused tools, and keeps 13 APS and ShopView
operations without request or response schemas behind an explicit opt-in.

## Requirements

- Node.js 22.12 or newer
- pnpm 11
- A JobBOSS² Integration Engine API user

## Install

```sh
pnpm install
pnpm build
```

## Authentication

Client credentials are the preferred setup. The server obtains tokens from ECI's documented OAuth
2.0 client credentials endpoint, caches them, refreshes before expiration, and retries one read
request after a `401` response. Writes are never replayed automatically.

```env
JOBBOSS2_CLIENT_ID=your-client-id
JOBBOSS2_CLIENT_SECRET=your-client-secret
```

A pre-issued access token also works, but the server cannot refresh it:

```env
JOBBOSS2_ACCESS_TOKEN=your-access-token
```

Do not set both authentication methods.

## MCP client configuration

Build the project, then point an MCP client at `dist/cli.js`. Use an absolute path.

```json
{
  "mcpServers": {
    "jobboss2": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\jobboss2-mcp\\dist\\cli.js"],
      "env": {
        "JOBBOSS2_CLIENT_ID": "your-client-id",
        "JOBBOSS2_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

After the package is published, clients can run it without a local checkout:

```json
{
  "mcpServers": {
    "jobboss2": {
      "command": "pnpm",
      "args": ["dlx", "jobboss2-mcp"],
      "env": {
        "JOBBOSS2_CLIENT_ID": "your-client-id",
        "JOBBOSS2_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

## Tools

| Tool                                | Purpose                                                           | Access          |
| ----------------------------------- | ----------------------------------------------------------------- | --------------- |
| `jobboss2_describe_resource`        | List resources, views, and actions, or inspect keys and schemas   | Read-only       |
| `jobboss2_list`                     | List records with fields, filters, sorting, and paging            | Read-only       |
| `jobboss2_get`                      | Get one record using its documented path keys                     | Read-only       |
| `jobboss2_create`                   | Create a record after OpenAPI request validation                  | Write opt-in    |
| `jobboss2_update`                   | Patch a record after OpenAPI request validation                   | Write opt-in    |
| `jobboss2_delete`                   | Delete an order, quote, estimate, invoice, line, step, or BOM row | Write opt-in    |
| `jobboss2_run_action`               | Copy, process, unprocess, ship, or bulk-update quote lines        | Write opt-in    |
| `jobboss2_get_view`                 | Get rollups, snapshots, worklists, capabilities, and calendar     | Read-only       |
| `jobboss2_list_documents`           | List documents attached to a record                               | Read-only       |
| `jobboss2_attach_document`          | Link a repository document or upload a new file to a record       | Write opt-in    |
| `jobboss2_detach_document`          | Remove a document link from a record                              | Write opt-in    |
| `jobboss2_issuing_materials_lookup` | List bins, jobs, or routing steps                                 | Read-only       |
| `jobboss2_transfer_stock_to_job`    | Transfer stock and update related job records                     | Write opt-in    |
| `jobboss2_create_report`            | Submit a report request                                           | Write opt-in    |
| `jobboss2_get_report`               | Retrieve a report by request ID                                   | Read-only       |
| `jobboss2_undocumented_request`     | Call underspecified APS or ShopView paths                         | Separate opt-in |

Call `jobboss2_describe_resource` before writes. ECI's OpenAPI document has no `operationId` values,
so this server assigns stable snake-case resource names from the API tags and names views and
actions by their path below `/api/v2/`, such as `orders/backlog-summary` or
`quotes/{quoteNumber}/copy`. When a tag has two operations of the same kind, the second resource
takes a key suffix, such as `routings_by_unique_id` for routing steps addressed by `uniqueID`.

## Views

Views are ECI's agent-helper endpoints. They answer common questions in one call, so prefer them to
paging list tools for counts, rankings, and totals:

```json
{
  "view": "orders/backlog-summary",
  "query": { "groupBy": "customer", "take": 25 }
}
```

Pass path keys in `keys`, for example `{ "jobNumber": "1234" }` for `jobs/{jobNumber}/snapshot`, and
only the query parameters the view documents in `query`. Call `me/capabilities` once per session to
see which areas the API user can read and write, and `me/calendar-context` before building a
relative date window: JobBOSS² year-to-date is fiscal, and the shop's today can differ from the UTC
date. Many views need a specific JobBOSS² report privilege, so a `403` means the API user lacks it.

## Filters and paging

List tools use ECI's documented filter syntax. Supply a filter map instead of building a query
string:

```json
{
  "resource": "customers",
  "fields": ["customerCode", "customerDescription", "lastModDate"],
  "filters": {
    "customerCode[in]": ["ACME", "ECI"],
    "lastModDate[gte]": "2026-01-01"
  },
  "sort": ["+customerCode"],
  "skip": 0,
  "take": 50
}
```

Supported operators are `eq`, `ne`, `gte`, `lte`, `gt`, `lt`, `in`, `notin`, `null`, `cont`
(contains), `ncont` (does not contain), `sw` (starts with), and `ew` (ends with). Arrays are
serialized as pipe-separated values for `in` and `notin`. List calls are capped at 200 records; page
with `skip` and `take` while the response's `hasMore` is `true`. Set `includeTotalCount` to also get
`totalCount`, which costs JobBOSS² an extra count query.

The server rejects `revisedDate[null]` because ECI documents that expression as causing a server
error.

## Write access

Create, update, delete, record actions, document attach and detach, report creation, stock transfer,
and undocumented POST calls are disabled by default. Enable them only for MCP clients you trust:

```env
JOBBOSS2_ALLOW_WRITES=true
```

`jobboss2_transfer_stock_to_job` changes bin quantities and can create job materials, inventory
transactions, and job requirements. Processing a packing list runs JobBOSS² inventory and order
processing; ECI documents that the public API never syncs it to QuickBooks or Xero. The API does not
document idempotency for these calls, so the server never retries a write automatically.

`jobboss2_attach_document` takes either a `repositoryId` for a file already in the JobBOSS² document
repository or a `file` object with `fileName`, base64-encoded `base64`, and an optional
`contentType`. Uploads may set `folderId` from the `repository-folders` view.

## Undocumented operations

The OpenAPI document includes 13 APS and ShopView operations without request or response schemas.
They are omitted from the default tool list. To expose `jobboss2_undocumented_request`:

```env
JOBBOSS2_ENABLE_UNDOCUMENTED=true
```

POST calls through this tool also require `JOBBOSS2_ALLOW_WRITES=true`.

## Configuration

| Variable                       | Default                       | Description                                |
| ------------------------------ | ----------------------------- | ------------------------------------------ |
| `JOBBOSS2_CLIENT_ID`           |                               | Integration Engine API user client ID      |
| `JOBBOSS2_CLIENT_SECRET`       |                               | Integration Engine API user client secret  |
| `JOBBOSS2_ACCESS_TOKEN`        |                               | Static bearer token alternative            |
| `JOBBOSS2_BASE_URL`            | ECI production API            | JobBOSS² API origin                        |
| `JOBBOSS2_TOKEN_URL`           | ECI production token endpoint | OAuth token URL                            |
| `JOBBOSS2_REQUEST_TIMEOUT_MS`  | `30000`                       | Per-request timeout from 100 to 300000 ms  |
| `JOBBOSS2_ALLOW_WRITES`        | `false`                       | Enable POST, PATCH, and DELETE tools       |
| `JOBBOSS2_ENABLE_UNDOCUMENTED` | `false`                       | Register the underspecified operation tool |

Custom URLs must use HTTPS. Plain HTTP is accepted only for localhost development.

## API behavior

- JobBOSS² API v2 accepts and returns dates in UTC. Documented input formats are
  `yyyy-MM-ddTHH:mm:ssZ` and `yyyy-MM-dd`. View `fromDate`, `toDate`, and `asOf` parameters are shop
  calendar dates.
- Most list endpoints return a default field set. Pass `fields` to choose exact fields.
- Quote and quote-line-item currency pairs accept either the company-currency field or the foreign
  field on POST/PATCH, not both. ECI calculates the other value.
- Report request and response shapes are absent from the current OpenAPI document.
- The server retries only one read after a `401` when it owns refreshable client credentials. It
  never retries writes, other API errors, or network failures.

## Development

```sh
pnpm dev
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm build
pnpm check
```

The project uses released TypeScript 7 and emits declarations during every build.

### Update the API catalog

```sh
pnpm sync:openapi
pnpm check
```

`sync:openapi` fetches ECI's live API v2 OpenAPI document and writes `src/generated/catalog.json`.
The generator keeps route metadata and JSON request schemas, but drops changing examples and the
rest of the full specification. It fails when a new operation does not fit the resource, view,
action, or document groups, so review API changes before committing the generated file.

## Security

Keep JobBOSS² credentials in the MCP client's environment configuration. Do not put them in this
repository or pass them as tool arguments. See [SECURITY.md](SECURITY.md) for vulnerability reports.

## Disclaimer

This project is not affiliated with or endorsed by ECI Software Solutions. JobBOSS and JobBOSS² are
marks of their respective owner. The API documentation remains the authority for JobBOSS² behavior.

## License

[MIT](LICENSE)
