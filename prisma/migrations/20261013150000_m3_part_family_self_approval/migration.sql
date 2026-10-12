-- Lean Core M3 — a single Production Head may approve a part family he edited.
--
-- M1 (20261013100000) added part_families_approver_not_preparer_chk. DESPL has
-- one Production Head, so that rule made his own edits unapprovable by anyone.
-- Decision (Swayam, 13 Oct): he may self-approve, and it is flagged instead of
-- forbidden. The flag is derived (approved_by_id = prepared_by_id) and carried
-- on the audit row and the part's detail screen; no new column is needed.
--
-- Everything else stays: APPROVED still needs an approver and a date
-- (part_families_approved_needs_approver_chk), and only the Production Head role
-- can approve at all (service layer).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "part_families" DROP CONSTRAINT "part_families_approver_not_preparer_chk";
