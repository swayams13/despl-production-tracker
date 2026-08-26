import * as XLSX from "xlsx";
import { NextResponse } from "next/server";
import { requireActor, assertNotClientUser } from "@/lib/authz";
import { AppError, ERROR_CODES, isAppError, ERROR_MESSAGES } from "@/lib/shared/errors";
import { loadQcpGrid } from "@/lib/services/qcp-grid.read";
import { intParam, type RouteCtx } from "../../../../_lib";

// GET /api/jobs/:id/qcp/export?unit=:unitId — QCP checklist for one unit as .xlsx.
export async function GET(req: Request, ctx: RouteCtx) {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
    const actor = await requireActor();
    assertNotClientUser(actor); // audit H3 — this route bypasses api/_lib.ts's route() wrapper
    const params = await ctx.params;
    const jobId = intParam(params.id);
    const unitParam = new URL(req.url).searchParams.get("unit");
    const unitId = unitParam ? intParam(unitParam) : undefined;

    const grid = await loadQcpGrid(actor, jobId, unitId);
    if (!grid || grid.units.length === 0) throw new AppError(ERROR_CODES.NOT_FOUND);

    const rows = grid.sections.flatMap((sec) =>
      sec.rows.map((r) => ({
        "Sr No": r.srNo,
        Section: sec.title,
        Activity: r.activity,
        Class: r.classCode,
        "Acceptance criteria": r.acceptanceCriteria ?? "",
        QC: r.qcCode ?? "",
        TPI: r.tpiCode ?? "",
        Status: r.status,
        "Age (days)": r.ageDays,
      })),
    );

    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet["!cols"] = [{ wch: 8 }, { wch: 22 }, { wch: 40 }, { wch: 8 }, { wch: 40 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 10 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "QCP");
    const buffer: Buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="QCP-unit-${grid.serialNo}.xlsx"`,
      },
    });
  } catch (e) {
    if (isAppError(e)) {
      return NextResponse.json({ error: { code: e.code, message: ERROR_MESSAGES[e.code] ?? "Request failed." } }, { status: e.code === "NOT_FOUND" ? 404 : 403 });
    }
    console.error("[api] qcp export failed", { requestId, error: e });
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Something went wrong." } },
      { status: 500, headers: { "x-request-id": requestId } },
    );
  }
}
