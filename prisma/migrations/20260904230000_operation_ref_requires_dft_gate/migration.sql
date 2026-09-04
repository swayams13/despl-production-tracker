-- B6: declarative flag replacing component.service.ts's operationCode === "PAINTING" literal.
ALTER TABLE "operation_refs" ADD COLUMN "requires_dft_gate" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: the only op that gate applied to today, behavior-preserving.
UPDATE "operation_refs" SET "requires_dft_gate" = true WHERE "code" = 'PAINTING';
