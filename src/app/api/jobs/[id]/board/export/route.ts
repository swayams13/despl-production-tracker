import * as XLSX from "xlsx";
import { NextResponse } from "next/server";
import { requireActor, assertNotClientUser } from "@/lib/authz";
import { AppError, ERROR_CODES, isAppError, ERROR_MESSAGES } from "@/lib/shared/errors";
import { loadTrackerSheet } from "@/lib/services/board.export.read";
import { intParam, type RouteCtx } from "../../../../_lib";

// GET /api/jobs/:id/board/export — the "Units x Process Tracker" sheet of
// docs/DESPL-320 Production Tracker.xlsx for any job: title rows, header row 4
// (# Process Department Start-by Finish-by <serials>), one row per process.
// Values only: the installed xlsx writer has no cell styles, so the workbook's
// pale-yellow cells and its status dropdown are not reproduced.
export async function GET(req: Request, ctx: RouteCtx) {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
    const actor = await requireActor();
    assertNotClientUser(actor); // this route bypasses api/_lib.ts's route() wrapper
    const jobId = intParam((await ctx.params).id);
    const sheet = await loadTrackerSheet(actor, jobId);
    if (!sheet) throw new AppError(ERROR_CODES.NOT_FOUND);

    const aoa: (string | number)[][] = [
      ["Units × Process Tracker"],
      [`Floor-level daily tracker — ${sheet.rows.length} processes × ${sheet.serials.length} units. Mark each cell as a unit completes that process.`],
      ["Status words: - · Started · Submitted · Verified · Complete · Hold"],
      ["#", "Process", "Department", "Start by", "Finish by", ...sheet.serials],
      ...sheet.rows.map((r) => [r.seq, r.name, r.department, r.startBy, r.finishBy, ...r.cells]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 5 }, { wch: 42 }, { wch: 22 }, { wch: 13 }, { wch: 13 }, ...sheet.serials.map(() => ({ wch: 11 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Units x Process Tracker");
    const buffer: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${sheet.jobNumber}-units-x-process-tracker.xlsx"`,
      },
    });
  } catch (e) {
    if (isAppError(e)) {
      return NextResponse.json(
        { error: { code: e.code, message: ERROR_MESSAGES[e.code] ?? "Request failed." } },
        { status: e.code === "NOT_FOUND" ? 404 : 403 },
      );
    }
    console.error("[api] board export failed", { requestId, error: e });
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Something went wrong." } },
      { status: 500, headers: { "x-request-id": requestId } },
    );
  }
}
