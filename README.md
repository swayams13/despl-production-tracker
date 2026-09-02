# DESPL Production Tracker

End-to-end production tracker for DESPL (Dhruv EPC Solutions, Vedanta Group): pressure-vessel
manufacturing from PO to dispatch across all departments — 25-stage work-order process, QCP/ITP
hold points, BOM + heat-number traceability, welding productivity, and daily management visibility.

Single Next.js 15 (App Router) full-stack app — Server Actions for every mutation, Prisma 6 +
PostgreSQL 16, deployed on Railway. See `CLAUDE.md` for the full stack breakdown, non-negotiable
invariants, and conventions; `docs/BUILD-SPEC-v2.md` for scheduling/architecture; `progress.md` for
the session-by-session build log.

## Getting started

```bash
pnpm install
pnpm dev          # :3000
```

Needs a local Postgres (`DATABASE_URL` / `DIRECT_URL` in `.env`) and a seeded database:

```bash
pnpm db:seed
pnpm db:bootstrap   # demo-only: generates a mid-flight DESPL-320 schedule
```

## Commands

```bash
pnpm test         # pure unit tests, no DB
pnpm test:db      # DB-gated tests against despl_test (never against despl_demo)
pnpm e2e          # Playwright
pnpm lint && pnpm typecheck
pnpm build
```
