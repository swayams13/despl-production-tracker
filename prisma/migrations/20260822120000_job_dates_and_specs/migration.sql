-- Split Job.deliveryDate into the two commitments it was conflating, and add
-- the design-configuration blob. RENAME, not DROP+ADD: the live CSV import
-- already loaded real dates into delivery_date and they must survive.
ALTER TABLE "jobs" RENAME COLUMN "delivery_date" TO "committed_delivery_date";
ALTER TABLE "jobs" ADD COLUMN "target_dispatch_date" TIMESTAMP(3);
ALTER TABLE "jobs" ADD COLUMN "specs" JSONB;
