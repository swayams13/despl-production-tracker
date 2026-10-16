import Link from "next/link";
import { redirect } from "next/navigation";
import { landingFor } from "@/lib/shared/nav";
import { FEATURES } from "@/lib/shared/flags";
import { getActor, ROLES, hasRole } from "@/lib/authz";
import { loadPortfolio, loadPortfolioFacts } from "@/lib/services/portfolio.read";
import { HEALTH_LABEL } from "@/lib/services/job-health";
import {
  ATTENTION_LIMIT,
  actionsDue,
  bottlenecks,
  buildExceptions,
  buildTiles,
  forecastPastCommitted,
  healthFromSlug,
  parseJobParam,
  portfolioHref,
  rankExceptions,
  topBlockerByJob,
} from "@/lib/shared/portfolio";
import { PageHeader } from "@/components/industrial/page-header";
import { LegacyDashboard } from "./_legacy";
import { Attention, Bottlenecks, HealthTable, Tiles } from "./_view";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Portfolio (Lean Core L2.7, audit/06 §11). With `leanFloor` off the page is the
 * pre-L2.7 dashboard, unchanged. The URL is the state: `?health=` filters the
 * project table, `?job=` focuses the table, the bars and the queue on one job
 * (and rides along on every link out of them).
 */
export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.MANAGEMENT, ROLES.PRODUCTION_HEAD, ROLES.ADMIN)) redirect(landingFor(actor.roles, { leanFloor: FEATURES.leanFloor }));
  if (!FEATURES.leanFloor) return <LegacyDashboard actor={actor} searchParams={searchParams} />;

  const sp = await searchParams;
  const portfolio = await loadPortfolio(actor);
  const { rows, counts } = portfolio;
  const health = healthFromSlug(first(sp.health));
  const requested = parseJobParam(sp.job);
  const focus = rows.find((r) => r.id === requested) ?? null;
  const jobId = focus?.id ?? null;

  if (rows.length === 0) {
    return (
      <>
        <PageHeader title="Portfolio" />
        <p className="note">
          No projects yet. Create a job to start tracking it here. <Link href="/jobs" className="btn btn-ghost">Go to jobs</Link>
        </p>
      </>
    );
  }

  const facts = await loadPortfolioFacts(actor, rows);
  const ranked = rankExceptions(buildExceptions(facts, null), rows.map((r) => r.id));
  const attention = jobId ? ranked.filter((e) => e.jobId === jobId) : ranked;
  const shown = rows.filter((r) => (!health || r.health === health) && (!jobId || r.id === jobId));
  const tiles = buildTiles({ counts, actionsDue: actionsDue(facts, null), health, jobId });
  const fc = forecastPastCommitted(rows);

  return (
    <>
      <PageHeader
        title="Portfolio"
        actions={
          <span className="sub">
            {new Date().toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" })}
          </span>
        }
      />

      <p className="pf-line" role="status">
        <b className="mono">{fc.late}</b> of <b className="mono">{fc.known}</b> jobs forecast past committed date
        {fc.late > 0 && <> · total slip <b className="mono">{fc.slipDays}</b> days</>}
      </p>

      <Tiles tiles={tiles} />

      {focus && (
        <p className="pf-focusbar">
          Showing <b className="mono">{focus.jobNumber}</b> only.{" "}
          <Link href={portfolioHref({ health })}>Show all jobs</Link>
        </p>
      )}

      <section id="projects" className="card pf-sec" aria-labelledby="pf-projects">
        <div className="hd">
          <h3 id="pf-projects">Project health</h3>
          {health ? (
            <Link href={portfolioHref({ jobId }, "projects")} className="chip pf-clear">
              <i />
              {HEALTH_LABEL[health]} · clear
            </Link>
          ) : (
            <span className="sub pf-hint">Worst first</span>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="note">
            No projects match. <Link href={portfolioHref({})}>Show all</Link>
          </p>
        ) : (
          <HealthTable rows={shown} topBlocker={topBlockerByJob(ranked)} health={health} jobId={jobId} />
        )}
        {portfolio.cancelledCount > 0 && <p className="pf-more">{portfolio.cancelledCount} cancelled, not shown.</p>}
      </section>

      <section id="bottlenecks" className="card pf-sec" aria-labelledby="pf-bn">
        <div className="hd">
          <h3 id="pf-bn">Where work is stuck</h3>
          <span className="sub pf-hint">Worst first</span>
        </div>
        <Bottlenecks bars={bottlenecks(facts, jobId)} />
      </section>

      <section id="needs-attention" className="card pf-sec" aria-labelledby="pf-att">
        <div className="hd">
          <h3 id="pf-att">Needs attention</h3>
          <span className="sub pf-hint">
            <span className="mono">{attention.length}</span> · worst job first
          </span>
        </div>
        <Attention items={attention.slice(0, ATTENTION_LIMIT)} total={attention.length} />
      </section>
    </>
  );
}
