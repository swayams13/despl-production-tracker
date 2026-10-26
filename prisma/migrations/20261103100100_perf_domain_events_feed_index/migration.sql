-- AUD-023 (perf): the activity feed (`loadEvents`) orders one aggregate_type's events by
-- (at DESC, id DESC) and stops after `limit` rows. The existing indexes lead with
-- (tenant_id, aggregate_type, aggregate_id, ...) or (tenant_id, type, ...), neither of which serves
-- "newest N of an aggregate_type", so the feed sorted every event of the type. Additive, no data touched.
-- (Plain CREATE INDEX: it briefly blocks event INSERTs while it builds; domain_events is small at DESPL's scale.)
CREATE INDEX "domain_events_tenant_id_aggregate_type_at_id_idx" ON "domain_events"("tenant_id", "aggregate_type", "at", "id");
