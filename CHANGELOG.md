# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## Unreleased

- Move to JobBOSS² API v2, ECI's recommended API for agents, and cover all 230 of its operations.
- Add `jobboss2_get_view` for ECI's agent-helper rollups, snapshots, worklists, capabilities, and
  calendar context.
- Add `jobboss2_delete`, `jobboss2_run_action`, and document list, attach, and detach tools. Writes
  stay behind `JOBBOSS2_ALLOW_WRITES`.
- Add the `cont`, `ncont`, `sw`, and `ew` filter operators and the `includeTotalCount` list option.
- Add the Online resource and routing-step updates by `uniqueID`.
- Remove the User Transactions resource and the OAuth exchange operation, which API v2 does not
  include.

## 0.1.0

- Add OAuth client credentials and static token authentication.
- Add MCP tools for JobBOSS² resource discovery, reads, writes, issuing materials, and reports.
- Add OpenAPI request validation and a deterministic catalog generator.
- Gate writes and underspecified operations behind separate environment flags.
