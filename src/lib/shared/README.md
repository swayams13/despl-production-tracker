# lib/shared

zod schemas, types, and constants (roles, process/status enums, error codes) shared by client and
server. The zod schema here is the single source of validation truth — both Server Actions and
the browser import from this directory rather than duplicating validation logic.

Stable error codes used across the app (`GATING_BLOCKED`, `MAKER_CHECKER_VIOLATION`,
`REASON_REQUIRED`, `HOLD_POINT_OPEN`, …) are defined here per CLAUDE.md invariant #12.
