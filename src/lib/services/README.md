# lib/services

All business rules live here. Server Actions and Route Handlers (`/api/v1`) are thin callers into
this layer — they never hold rules themselves.

Enforced here, not in the UI: hard sequential gating (`stage_predecessors`), maker–checker on
`verify`, hold-point blocking, mandatory delay reasons, RBAC department scoping, and the
append-only audit write in the same transaction as every mutation. See CLAUDE.md's non-negotiable
invariants (§ Non-negotiable invariants) — they apply to this layer above all others.
