import { redirect } from "next/navigation";
import { getActor, hasRole } from "@/lib/authz";
import { loadReviewPairs } from "@/lib/services/override-review.read";
import { IMPORT_VIEW_ROLES, MASTER_DATA_READ_ROLES } from "@/lib/services/master-data.service";
import { REVIEW_PAIR_MIN_UNITS } from "@/lib/shared/override-review";
import { RefusalCard } from "../_refusal";
import { MasterDataTabs } from "../_tabs";

/**
 * D2: the same step started early on at least half of a job's units (minimum
 * 3) points at a wrong assembly sequence in master data. Read-only: the fix is
 * a revision of the equipment type's assembly sequence.
 */
export default async function SequenceReviewPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ...MASTER_DATA_READ_ROLES)) return <RefusalCard title="Sequence review" />;

  const rows = await loadReviewPairs(actor);
  return (
    <>
      <div className="page-h">
        <h1>Master data</h1>
      </div>
      <MasterDataTabs active="sequence" showImport={hasRole(actor, ...IMPORT_VIEW_ROLES)} />
      <p style={{ margin: "0 0 12px", maxWidth: 640 }}>
        Steps the floor started early on at least half of a job&apos;s units (and on at least {REVIEW_PAIR_MIN_UNITS}). If the same early start keeps
        happening, the assembly sequence probably has these two steps in the wrong order.
      </p>
      {rows.length === 0 ? (
        <p className="note">No step pair has been started early this often.</p>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Started early</th>
                <th scope="col">Ahead of</th>
                <th scope="col">Units</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.jobId}|${r.step}|${r.skipped}`}>
                  <td>{r.jobNumber}</td>
                  <td>{r.stepTitle}</td>
                  <td>{r.skippedTitle}</td>
                  <td className="mono">
                    {r.units} of {r.totalUnits}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
