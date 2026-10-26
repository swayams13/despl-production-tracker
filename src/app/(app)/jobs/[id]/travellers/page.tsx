import { redirectToLogin } from "@/lib/auth/login-redirect";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadTravellers } from "@/lib/services/traveller.read";
import { fallbackLine, resolveOrigin, shortUrl, splitColumns } from "@/lib/shared/traveller";
import { PrintButton } from "./print-button";

/**
 * Lean Core L2.9 (frame 08A): one A5 portrait, black-only traveller per unit.
 * The QR is server-side SVG and points at /u/<publicId> on this deployment's
 * host (APP_URL overrides), never at the serial. Print CSS (`.tv-` block at the
 * end of globals.css) hides the app shell and page-breaks between units.
 */
export default async function TravellersPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");

  const jobId = Number((await params).id);
  if (!Number.isInteger(jobId) || jobId <= 0) notFound();

  const origin = resolveOrigin(await headers(), process.env.APP_URL);
  const sheet = await loadTravellers(actor, jobId, origin);
  if (!sheet) notFound();

  const n = sheet.travellers.length;
  const printed = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

  return (
    <div className="tv-root">
      <div className="page-h tv-screen">
        <h1>Travellers</h1>
        <span className="sub">
          <span className="mono">{sheet.jobNumber}</span> · <span data-testid="tv-count">{n} {n === 1 ? "unit" : "units"}</span> · A5 portrait, black only
        </span>
        <span style={{ marginLeft: "auto" }}>
          <PrintButton />
        </span>
      </div>

      {n === 0 && <p className="sub tv-screen">This job has no units yet.</p>}

      {sheet.travellers.map((t, i) => {
        const cols = splitColumns(t.stages);
        return (
          <section key={t.unitId} className="tv-sheet" data-testid="traveller">
            <div className="tv-top">
              <div className="tv-id">
                <div className="tv-kicker">Unit traveller</div>
                <div className="tv-serial">{t.serialNo}</div>
                <div className="tv-of">Unit <b>{i + 1}</b> of <b>{n}</b></div>
                <dl className="tv-facts">
                  <dt>Job</dt>
                  <dd><span className="tv-mono">{sheet.jobNumber}</span> · {sheet.description}</dd>
                  <dt>Client</dt>
                  <dd>{sheet.clientName}</dd>
                </dl>
              </div>
              <div className="tv-qrbox">
                <div className="tv-qr" role="img" aria-label={`QR code for ${t.serialNo}`} dangerouslySetInnerHTML={{ __html: t.qrSvg }} />
                <a className="tv-url" href={t.url}>{shortUrl(t.url)}</a>
              </div>
            </div>

            <p className="tv-backup">
              <b>Paper backup.</b> If the app is down, tick the stage, write the date and sign. Enter it in the app within 3 days.
            </p>

            <div className="tv-cols">
              {cols.map((rows, c) => (
                <div key={c} className="tv-col">
                  <div className="tv-row tv-head"><span /><span>No.</span><span>Stage</span><span>Date / sign</span></div>
                  {rows.map((s) => (
                    <div key={s.stageNo} className="tv-row" data-testid="tv-stage">
                      <span className="tv-box" />
                      <span className="tv-no">{s.stageNo}</span>
                      <span className="tv-name">{s.name}</span>
                      <span className="tv-sign" />
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <p className="tv-fallback">{fallbackLine(t.serialNo)}</p>
            <div className="tv-foot">
              <span>Printed {printed} · keep with the unit until dispatch</span>
              <span className="tv-mono tv-foot-serial">{t.serialNo}</span>
            </div>
          </section>
        );
      })}
    </div>
  );
}
