/**
 * Lean Core L2.11: the 08:30 IST morning digest email. Pure: a payload in, a
 * subject, an HTML body and a plain-text body out. No React, no database, no
 * mailer (design frame 09A/09B: one 600 px column that reflows on a phone).
 *
 * English only. Overrides are listed, never "acknowledged by": only the
 * Production Head may acknowledge (build prompt §8.2 item 10).
 */

export interface DigestJobAtRisk {
  jobNumber: string;
  health: "DELAYED" | "AT_RISK";
  /** ISO dates (YYYY-MM-DD), null when the schedule has no forecast / no promise. */
  forecast: string | null;
  committed: string | null;
  /** Days the forecast lands after the committed date; null when not late. */
  slipDays: number | null;
  percentComplete: number;
  topBlocker: string | null;
}

export interface DigestDeptOverdue {
  dept: string;
  overdue: number;
  topReason: string | null;
  /** How many of this department's overdue items filed that reason. */
  topReasonCount: number;
}

export interface DigestOverride {
  jobNumber: string;
  serialNo: string;
  title: string;
  by: string;
  /** ISO instant. */
  at: string;
  category: string;
  note: string | null;
}

export interface DigestRate {
  same: number;
  total: number;
  /** Whole percent; null when there were no updates. */
  rate: number | null;
}

export interface DigestPayload {
  /** The IST calendar day the digest goes out ("YYYY-MM-DD"). */
  date: string;
  /** The IST day the "yesterday" sections cover: the last working day before `date`. */
  workDay: string;
  /** ISO instant the figures were read. */
  asOf: string;
  jobsAtRisk: DigestJobAtRisk[];
  overdueTotal: number;
  overdueByDept: DigestDeptOverdue[];
  /** The first few only; `overridesTotal` is the full count. */
  overrides: DigestOverride[];
  overridesTotal: number;
  sameDay: { overall: DigestRate; byDept: Array<DigestRate & { dept: string }> };
  /** Base URL of the app, no trailing slash; null leaves the button out. */
  appUrl: string | null;
}

export interface RenderedDigest {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (r: DigestRate) => (r.rate === null ? "no updates" : `${r.rate}%`);

const IST = "Asia/Kolkata";
const fmtDay = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: IST });
const fmtShort = (iso: string | null) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: IST }) : "not set";
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST });
const fmtWhen = (iso: string) => `${new Date(iso).toLocaleDateString("en-IN", { weekday: "short", timeZone: IST })} ${fmtTime(iso)}`;

/** "yesterday" when the covered day is the day before the digest, else its weekday and date (a Monday covers Saturday). */
export function dayWord(d: Pick<DigestPayload, "date" | "workDay">): string {
  const prev = new Date(new Date(`${d.date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  return prev === d.workDay ? "yesterday" : new Date(`${d.workDay}T00:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: IST });
}

export function digestSubject(p: DigestPayload): string {
  const jobs = p.jobsAtRisk.length ? `${plural(p.jobsAtRisk.length, "job")} need${p.jobsAtRisk.length === 1 ? "s" : ""} attention` : "all jobs on track";
  return `DESPL daily — ${jobs} · same-day updates ${p.sameDay.overall.rate === null ? "n/a" : pct(p.sameDay.overall)}`;
}

export function digestPreheader(p: DigestPayload): string {
  const jobs = p.jobsAtRisk.slice(0, 2).map((j) => (j.slipDays ? `${j.jobNumber} +${j.slipDays} d` : j.jobNumber));
  const parts = [
    ...(jobs.length ? [jobs.join(" and ")] : []),
    `${plural(p.overdueTotal, "step")} overdue`,
    `${plural(p.overridesTotal, "out-of-sequence start")}`,
  ];
  return parts.join(" · ");
}

const C = { ink: "#0E1116", muted: "#4A5260", line: "#D5D9DF", bg: "#F6F7F9", red: "#C8202B", amber: "#9A5B00", accent: "#AE4B00" };
const td = (s: string, extra = "") => `<td style="padding:6px 0;border-top:1px solid ${C.line};font-size:14px;line-height:20px;${extra}">${s}</td>`;
const h2 = (s: string) =>
  `<h2 style="margin:24px 0 8px;font-size:12px;line-height:16px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}">${esc(s)}</h2>`;
const p = (s: string, extra = "") => `<p style="margin:0 0 6px;font-size:14px;line-height:20px;${extra}">${s}</p>`;

export function renderDigest(d: DigestPayload): RenderedDigest {
  const subject = digestSubject(d);
  const preheader = digestPreheader(d);
  const day = dayWord(d);
  const when = day === "yesterday" ? day : `on ${day}`;

  const jobsHtml = d.jobsAtRisk.length
    ? d.jobsAtRisk
        .map(
          (j) =>
            `<div style="padding:10px 0;border-top:1px solid ${C.line}">` +
            p(
              `<b>${esc(j.jobNumber)}</b> <span style="color:${j.health === "DELAYED" ? C.red : C.amber};font-weight:600">${j.health === "DELAYED" ? "Delayed" : "At risk"}${j.slipDays ? ` · +${j.slipDays} d` : ""}</span>`,
            ) +
            p(`Forecast ${esc(fmtShort(j.forecast))} · committed ${esc(fmtShort(j.committed))} · ${j.percentComplete}% complete`, `color:${C.muted}`) +
            (j.topBlocker ? p(`Top blocker: ${esc(j.topBlocker)}`) : "") +
            `</div>`,
        )
        .join("")
    : p("No job is at risk this morning.", `color:${C.muted}`);

  const deptHtml = d.overdueByDept.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${d.overdueByDept
        .map((x) =>
          `<tr>${td(`<b>${esc(x.dept)}</b><br><span style="color:${C.muted}">${
            x.topReason ? `Top reason: ${esc(x.topReason)} · ${x.topReasonCount}` : "No reason filed yet"
          }</span>`)}${td(`<b style="color:${C.red}">${x.overdue}</b> overdue`, "text-align:right;white-space:nowrap")}</tr>`,
        )
        .join("")}</table>`
    : p("Nothing is overdue in any department.", `color:${C.muted}`);

  const overrideHtml = d.overrides.length
    ? d.overrides
        .map(
          (o) =>
            `<div style="padding:8px 0;border-top:1px solid ${C.line}">` +
            p(`<b>${esc(o.serialNo)}</b> · ${esc(o.title)} <span style="color:${C.muted}">(${esc(o.jobNumber)})</span>`) +
            p(`Started by ${esc(o.by)}, ${esc(fmtWhen(o.at))}`, `color:${C.muted}`) +
            p(`Reason: ${esc(o.category)}${o.note ? ` — ${esc(o.note)}` : ""}`) +
            `</div>`,
        )
        .join("") +
      (d.overridesTotal > d.overrides.length ? p(`and ${d.overridesTotal - d.overrides.length} more`, `color:${C.muted}`) : "")
    : p(`No stage was started out of sequence ${when}.`, `color:${C.muted}`);

  const rateHtml = d.sameDay.overall.total
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="padding:4px 0;font-size:12px;color:${C.muted}">Department</td><td style="padding:4px 0;font-size:12px;color:${C.muted};text-align:right">Same day</td><td style="padding:4px 0;font-size:12px;color:${C.muted};text-align:right">Rate</td></tr>
${d.sameDay.byDept
  .map((r) => `<tr>${td(esc(r.dept))}${td(`${r.same} of ${r.total}`, "text-align:right")}${td(`<b>${esc(pct(r))}</b>`, "text-align:right")}</tr>`)
  .join("")}
<tr>${td("<b>All departments</b>")}${td(`<b>${d.sameDay.overall.same} of ${d.sameDay.overall.total}</b>`, "text-align:right")}${td(`<b>${esc(pct(d.sameDay.overall))}</b>`, "text-align:right")}</tr>
</table>
${p("Same day means recorded on the day the work was done. Worst first.", `color:${C.muted};font-size:12px;margin-top:8px`)}`
    : p(`No updates were recorded ${when}.`, `color:${C.muted}`);

  const button = d.appUrl
    ? `<p style="margin:24px 0 0"><a href="${esc(d.appUrl)}/dashboard" style="display:inline-block;background:${C.accent};color:#FFFFFF;text-decoration:none;font-weight:600;font-size:16px;line-height:48px;padding:0 24px;border-radius:6px">Open dashboard</a></p>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};color:${C.ink};font-family:Inter,Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border:1px solid ${C.line};border-radius:8px"><tr><td style="padding:20px 24px">
<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}">DESPL · Daily digest</div>
<div style="font-size:20px;line-height:28px;font-weight:600;margin:4px 0 12px">${esc(fmtDay(d.date))}</div>
${p(`${d.sameDay.overall.rate === null ? `No updates were recorded ${when}.` : `<b style="font-size:24px">${esc(pct(d.sameDay.overall))}</b> of ${day === "yesterday" ? "yesterday's updates" : `the updates ${when}`} were recorded the same day.`} <b>${d.overdueTotal}</b> ${d.overdueTotal === 1 ? "step is" : "steps are"} overdue this morning, and <b>${d.overridesTotal}</b> ${d.overridesTotal === 1 ? "stage was" : "stages were"} started out of sequence ${when}.`)}
${h2("Jobs at risk")}${jobsHtml}
${h2("Overdue by department")}${deptHtml}
${h2(`Out of sequence ${when}`)}${overrideHtml}
${h2("Same-day updates by department")}${rateHtml}
${button}
<p style="margin:24px 0 0;font-size:12px;line-height:16px;color:${C.muted}">Sent every working day at 08:30 IST to the MD, CEO and Production Head. Figures are from ${esc(fmtTime(d.asOf))} IST.</p>
</td></tr></table></td></tr></table></body></html>`;

  const text = [
    `DESPL daily digest — ${fmtDay(d.date)}`,
    "",
    `${d.sameDay.overall.rate === null ? `No updates were recorded ${when}.` : `${pct(d.sameDay.overall)} of ${day === "yesterday" ? "yesterday's updates" : `the updates ${when}`} were recorded the same day.`} ${plural(d.overdueTotal, "step")} overdue this morning, ${plural(d.overridesTotal, "stage")} started out of sequence ${when}.`,
    "",
    "JOBS AT RISK",
    ...(d.jobsAtRisk.length
      ? d.jobsAtRisk.flatMap((j) => [
          `${j.jobNumber} — ${j.health === "DELAYED" ? "Delayed" : "At risk"}${j.slipDays ? ` +${j.slipDays} d` : ""}`,
          `  Forecast ${fmtShort(j.forecast)}, committed ${fmtShort(j.committed)}, ${j.percentComplete}% complete`,
          ...(j.topBlocker ? [`  Top blocker: ${j.topBlocker}`] : []),
        ])
      : ["No job is at risk this morning."]),
    "",
    "OVERDUE BY DEPARTMENT",
    ...(d.overdueByDept.length
      ? d.overdueByDept.map((x) => `${x.dept}: ${x.overdue} overdue${x.topReason ? ` (top reason: ${x.topReason}, ${x.topReasonCount})` : ""}`)
      : ["Nothing is overdue in any department."]),
    "",
    `OUT OF SEQUENCE ${when.toUpperCase()}`,
    ...(d.overrides.length
      ? [
          ...d.overrides.map((o) => `${o.serialNo} ${o.title} (${o.jobNumber}) — started by ${o.by}, ${fmtWhen(o.at)}. Reason: ${o.category}${o.note ? ` — ${o.note}` : ""}`),
          ...(d.overridesTotal > d.overrides.length ? [`and ${d.overridesTotal - d.overrides.length} more`] : []),
        ]
      : [`No stage was started out of sequence ${when}.`]),
    "",
    "SAME-DAY UPDATES BY DEPARTMENT",
    ...(d.sameDay.overall.total
      ? [...d.sameDay.byDept.map((r) => `${r.dept}: ${r.same} of ${r.total} (${pct(r)})`), `All departments: ${d.sameDay.overall.same} of ${d.sameDay.overall.total} (${pct(d.sameDay.overall)})`]
      : [`No updates were recorded ${when}.`]),
    ...(d.appUrl ? ["", `Open dashboard: ${d.appUrl}/dashboard`] : []),
    "",
    `Figures are from ${fmtTime(d.asOf)} IST.`,
  ].join("\n");

  return { subject, preheader, html, text };
}
