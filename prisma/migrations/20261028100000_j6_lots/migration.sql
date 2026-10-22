-- J6 (D21, default Serial): a LOT line is one unit carrying a quantity. Additive only; every default keeps today's behaviour.
CREATE TYPE "TrackingMode" AS ENUM ('SERIAL', 'LOT', 'LOT_THEN_SERIAL');

ALTER TABLE "equipments" ADD COLUMN "tracking_mode" "TrackingMode" NOT NULL DEFAULT 'SERIAL';

ALTER TABLE "units" ADD COLUMN "qty_planned" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "units" ADD CONSTRAINT "units_qty_planned_check" CHECK ("qty_planned" >= 1);

-- NULL qty_planned = not quantity-tracked (serial units, JOB-grain plans).
ALTER TABLE "process_plans" ADD COLUMN "qty_planned" INTEGER, ADD COLUMN "qty_done" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_qty_check"
  CHECK ("qty_done" >= 0 AND ("qty_planned" IS NULL OR ("qty_planned" >= 1 AND "qty_done" <= "qty_planned")));

ALTER TABLE "assembly_steps" ADD COLUMN "qty_planned" INTEGER, ADD COLUMN "qty_done" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assembly_steps" ADD CONSTRAINT "assembly_steps_qty_check"
  CHECK ("qty_done" >= 0 AND ("qty_planned" IS NULL OR ("qty_planned" >= 1 AND "qty_done" <= "qty_planned")));

-- D17 default: bands are stored and shown as a warning, never applied to dates (invariant 10).
ALTER TABLE "template_processes" ADD COLUMN "qty_bands" JSONB;
ALTER TABLE "template_processes" ADD CONSTRAINT "template_processes_qty_bands_check"
  CHECK ("qty_bands" IS NULL OR jsonb_typeof("qty_bands") = 'array');
ALTER TABLE "job_processes" ADD COLUMN "qty_bands" JSONB;
ALTER TABLE "job_processes" ADD CONSTRAINT "job_processes_qty_bands_check"
  CHECK ("qty_bands" IS NULL OR jsonb_typeof("qty_bands") = 'array');
