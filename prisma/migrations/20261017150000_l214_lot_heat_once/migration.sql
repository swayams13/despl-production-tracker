-- Lean Core L2.14 — a lot received without a heat number can be given one, once.
-- stock_lots is an append-only ledger for the app role (SELECT + INSERT only).
-- Stores receives material before its heat number is always known, and a lot with
-- no heat number cannot be picked from at cutting (D2 H2), so the one column is
-- opened: the app role may UPDATE heat_number and nothing else, and a trigger
-- allows exactly one change per row, NULL to a value, with every other column
-- unchanged. It applies to every role including the table owner. The audit row
-- written by recordLotHeat keeps who set it and when.
-- No backfill, no data change, no RLS change (the existing policies cover UPDATE).

SET LOCAL lock_timeout = '5s';

GRANT UPDATE ("heat_number") ON "stock_lots" TO despl_app;

CREATE FUNCTION stock_lots_heat_set_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.heat_number IS NOT NULL THEN
    RAISE EXCEPTION 'stock_lots.heat_number is already set; QC corrects a recorded heat number'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.heat_number IS NULL OR btrim(NEW.heat_number) = '' THEN
    RAISE EXCEPTION 'stock_lots.heat_number may only be set to a value'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.bom_item_id, NEW.location, NEW.qty, NEW.received_at, NEW.source_procurement_event_id, NEW.job_id, NEW.tenant_id)
     IS DISTINCT FROM
     (OLD.id, OLD.bom_item_id, OLD.location, OLD.qty, OLD.received_at, OLD.source_procurement_event_id, OLD.job_id, OLD.tenant_id) THEN
    RAISE EXCEPTION 'stock_lots is append-only except for a first heat_number'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_lots_heat_set_once
  BEFORE UPDATE ON "stock_lots"
  FOR EACH ROW EXECUTE FUNCTION stock_lots_heat_set_once();
