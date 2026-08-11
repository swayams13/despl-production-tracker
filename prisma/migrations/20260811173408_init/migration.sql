-- CreateEnum
CREATE TYPE "JobPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'COMPLETE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProcessEdgeType" AS ENUM ('FINISH_TO_START', 'START_TO_START_WITH_OVERLAP');

-- CreateEnum
CREATE TYPE "ScheduleMode" AS ENUM ('FORWARD', 'BACKWARD', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "ScheduleFeasibility" AS ENUM ('FEASIBLE', 'TIGHT', 'INFEASIBLE');

-- CreateEnum
CREATE TYPE "ProcessPlanStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETE', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "ComponentType" AS ENUM ('PLATE', 'PIPE', 'ELBOW', 'TEE', 'REDUCER', 'FLANGE', 'FORGING', 'TUBE', 'TUBE_SHEET', 'DISHED_END', 'CONE', 'SADDLE', 'SKIRT', 'LUG', 'PAD', 'FASTENER', 'PLUG', 'NIPPLE', 'UNION', 'COUPLING', 'VALVE', 'GASKET', 'STRUCTURAL_STEEL', 'PLATFORM', 'LADDER', 'OTHER');

-- CreateEnum
CREATE TYPE "ProcurementStatus" AS ENUM ('NOT_STARTED', 'INDENT_RAISED', 'INDENT_APPROVED', 'PO_PLACED', 'IN_STOCK');

-- CreateEnum
CREATE TYPE "MaterialReceivedStatus" AS ENUM ('NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "PmiResult" AS ENUM ('NA', 'PENDING', 'ACCEPT', 'REJECT');

-- CreateEnum
CREATE TYPE "CanonicalOperation" AS ENUM ('RECEIPT', 'MTC_VERIFICATION', 'CUTTING', 'EDGE_PREP', 'FORMING', 'MACHINING', 'FIT_UP', 'WELDING', 'GRINDING', 'NDT', 'SURFACE_PREP', 'PAINTING', 'INSPECTION', 'THREADING', 'EXPANSION', 'ASSEMBLY_CHECK');

-- CreateEnum
CREATE TYPE "Sourcing" AS ENUM ('IN_HOUSE', 'OUTSOURCE', 'NA');

-- CreateEnum
CREATE TYPE "ItemOperationStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETE');

-- CreateEnum
CREATE TYPE "TestType" AS ENUM ('RT', 'UT', 'HT', 'PNEUMATIC', 'DP', 'VACUUM');

-- CreateEnum
CREATE TYPE "TestResult" AS ENUM ('PENDING', 'ACCEPT', 'REJECT');

-- CreateEnum
CREATE TYPE "QcpItemKind" AS ENUM ('SECTION', 'CHECKPOINT');

-- CreateEnum
CREATE TYPE "QcpCode" AS ENUM ('P', 'W', 'H', 'R', 'RW', 'R_AND_A');

-- CreateEnum
CREATE TYPE "QcpExecutionResult" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'NA');

-- CreateEnum
CREATE TYPE "DrawingType" AS ENUM ('GA', 'FABRICATION', 'WELD_MAP', 'PID', 'ISOMETRIC');

-- CreateEnum
CREATE TYPE "DrawingStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'RELEASED');

-- CreateEnum
CREATE TYPE "DelayCategory" AS ENUM ('MATERIAL_DELAY', 'MANPOWER', 'MACHINE_BREAKDOWN', 'REWORK_QUALITY', 'CLIENT_HOLD', 'DRAWING_ENGINEERING_HOLD', 'OTHER');

-- CreateEnum
CREATE TYPE "DelayReviewStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'DISPUTED');

-- CreateTable
CREATE TABLE "clients" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" SERIAL NOT NULL,
    "job_number" TEXT NOT NULL,
    "client_id" INTEGER NOT NULL,
    "po_ref" TEXT,
    "design_code" TEXT,
    "order_date" TIMESTAMP(3),
    "delivery_date" TIMESTAMP(3),
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "JobStatus" NOT NULL DEFAULT 'ACTIVE',
    "work_order_no_in_file" TEXT,
    "remarks" TEXT,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipments" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "block_no" INTEGER,
    "remarks" TEXT,

    CONSTRAINT "equipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" SERIAL NOT NULL,
    "equipment_id" INTEGER NOT NULL,
    "serial_no" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_time_processes" (
    "code" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "main_activities" TEXT,
    "duration_min_days" INTEGER NOT NULL,
    "duration_max_days" INTEGER NOT NULL,
    "cumulative_printed" TEXT,
    "default_department_code" TEXT NOT NULL,
    "work_order_stages" INTEGER[],
    "envelope_finish_by_min_days" INTEGER NOT NULL,
    "envelope_finish_by_max_days" INTEGER NOT NULL,
    "envelope_start_by_min_days" INTEGER NOT NULL,
    "envelope_start_by_max_days" INTEGER NOT NULL,

    CONSTRAINT "lead_time_processes_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "process_edges" (
    "process_code" INTEGER NOT NULL,
    "predecessor_code" INTEGER NOT NULL,
    "type" "ProcessEdgeType" NOT NULL,
    "lag_days" INTEGER NOT NULL,

    CONSTRAINT "process_edges_pkey" PRIMARY KEY ("process_code","predecessor_code")
);

-- CreateTable
CREATE TABLE "departments" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "process_departments" (
    "process_code" INTEGER NOT NULL,
    "department_code" TEXT NOT NULL,

    CONSTRAINT "process_departments_pkey" PRIMARY KEY ("process_code")
);

-- CreateTable
CREATE TABLE "project_schedules" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "equipment_id" INTEGER,
    "version" INTEGER NOT NULL,
    "mode" "ScheduleMode" NOT NULL,
    "project_start_date" TIMESTAMP(3) NOT NULL,
    "required_delivery_date" TIMESTAMP(3),
    "feasibility" "ScheduleFeasibility",
    "override_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_process_plans" (
    "id" SERIAL NOT NULL,
    "project_schedule_id" INTEGER NOT NULL,
    "process_code" INTEGER NOT NULL,
    "baseline_start" TIMESTAMP(3),
    "baseline_finish" TIMESTAMP(3),
    "planned_start" TIMESTAMP(3),
    "planned_finish" TIMESTAMP(3),
    "actual_start" TIMESTAMP(3),
    "actual_finish" TIMESTAMP(3),
    "duration_override_days" INTEGER,
    "override_reason" TEXT,
    "status" "ProcessPlanStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "owner_department_code" TEXT NOT NULL,

    CONSTRAINT "project_process_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_items" (
    "id" SERIAL NOT NULL,
    "equipment_id" INTEGER NOT NULL,
    "item_no" INTEGER NOT NULL,
    "block_no" INTEGER,
    "part_name" TEXT NOT NULL,
    "description" TEXT,
    "material" TEXT,
    "qty" TEXT NOT NULL,
    "unit" TEXT,
    "component_type" "ComponentType",
    "remarks" TEXT,

    CONSTRAINT "bom_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurements" (
    "id" SERIAL NOT NULL,
    "bom_item_id" INTEGER NOT NULL,
    "indent_no" TEXT,
    "indent_date" TIMESTAMP(3),
    "approved_date" TIMESTAMP(3),
    "status" "ProcurementStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "po_no" TEXT,
    "po_date" TIMESTAMP(3),
    "received_status" "MaterialReceivedStatus",
    "received_date" TIMESTAMP(3),

    CONSTRAINT "procurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_identifications" (
    "id" SERIAL NOT NULL,
    "bom_item_id" INTEGER NOT NULL,
    "heat_number" TEXT NOT NULL,
    "mtc_ref" TEXT,
    "pmi_result" "PmiResult",

    CONSTRAINT "material_identifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_operations" (
    "id" SERIAL NOT NULL,
    "bom_item_id" INTEGER NOT NULL,
    "operation" "CanonicalOperation" NOT NULL,
    "sourcing" "Sourcing",
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "status" "ItemOperationStatus" NOT NULL DEFAULT 'NOT_STARTED',

    CONSTRAINT "item_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_tests" (
    "id" SERIAL NOT NULL,
    "bom_item_id" INTEGER NOT NULL,
    "type" "TestType" NOT NULL,
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "result" "TestResult" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "item_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_parties" (
    "id" SERIAL NOT NULL,
    "qcp_template_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "inspection_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qcp_templates" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER,
    "job_label" TEXT NOT NULL,
    "vessel" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "design_code" TEXT,

    CONSTRAINT "qcp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qcp_items" (
    "id" SERIAL NOT NULL,
    "qcp_template_id" INTEGER NOT NULL,
    "sr_no" TEXT NOT NULL,
    "kind" "QcpItemKind" NOT NULL,
    "section" TEXT,
    "activity" TEXT NOT NULL,
    "characteristic" TEXT,
    "extent_of_check" TEXT,
    "applicable_document" TEXT,
    "acceptance_criteria" TEXT,
    "record" TEXT,
    "remarks" TEXT,
    "lead_time_process_codes" INTEGER[],

    CONSTRAINT "qcp_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qcp_item_party_codes" (
    "qcp_item_id" INTEGER NOT NULL,
    "inspection_party_id" INTEGER NOT NULL,
    "code" "QcpCode" NOT NULL,

    CONSTRAINT "qcp_item_party_codes_pkey" PRIMARY KEY ("qcp_item_id","inspection_party_id")
);

-- CreateTable
CREATE TABLE "qcp_executions" (
    "id" SERIAL NOT NULL,
    "qcp_item_id" INTEGER NOT NULL,
    "unit_id" INTEGER NOT NULL,
    "result" "QcpExecutionResult" NOT NULL DEFAULT 'PENDING',
    "call_given_on" TIMESTAMP(3),
    "call_attended_on" TIMESTAMP(3),
    "cleared_by" TEXT,
    "waiver_approved_by" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qcp_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assembly_drawings" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "type" "DrawingType" NOT NULL,
    "revision_no" TEXT,
    "status" "DrawingStatus" NOT NULL DEFAULT 'DRAFT',
    "approved_date" TIMESTAMP(3),
    "released_date" TIMESTAMP(3),

    CONSTRAINT "assembly_drawings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delay_reasons" (
    "id" SERIAL NOT NULL,
    "project_process_plan_id" INTEGER NOT NULL,
    "category" "DelayCategory" NOT NULL,
    "detail" TEXT,
    "filed_by" TEXT NOT NULL,
    "filed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_status" "DelayReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,

    CONSTRAINT "delay_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "recipient_ref" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entity_ref" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_ref" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_code_key" ON "clients"("code");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_job_number_key" ON "jobs"("job_number");

-- CreateIndex
CREATE UNIQUE INDEX "units_equipment_id_serial_no_key" ON "units"("equipment_id", "serial_no");

-- CreateIndex
CREATE UNIQUE INDEX "project_schedules_job_id_equipment_id_version_key" ON "project_schedules"("job_id", "equipment_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "project_process_plans_project_schedule_id_process_code_key" ON "project_process_plans"("project_schedule_id", "process_code");

-- CreateIndex
CREATE UNIQUE INDEX "procurements_bom_item_id_key" ON "procurements"("bom_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_parties_qcp_template_id_code_key" ON "inspection_parties"("qcp_template_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "qcp_items_qcp_template_id_sr_no_key" ON "qcp_items"("qcp_template_id", "sr_no");

-- CreateIndex
CREATE UNIQUE INDEX "qcp_executions_qcp_item_id_unit_id_key" ON "qcp_executions"("qcp_item_id", "unit_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipments" ADD CONSTRAINT "equipments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_time_processes" ADD CONSTRAINT "lead_time_processes_default_department_code_fkey" FOREIGN KEY ("default_department_code") REFERENCES "departments"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_edges" ADD CONSTRAINT "process_edges_process_code_fkey" FOREIGN KEY ("process_code") REFERENCES "lead_time_processes"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_edges" ADD CONSTRAINT "process_edges_predecessor_code_fkey" FOREIGN KEY ("predecessor_code") REFERENCES "lead_time_processes"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_departments" ADD CONSTRAINT "process_departments_process_code_fkey" FOREIGN KEY ("process_code") REFERENCES "lead_time_processes"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_departments" ADD CONSTRAINT "process_departments_department_code_fkey" FOREIGN KEY ("department_code") REFERENCES "departments"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_schedules" ADD CONSTRAINT "project_schedules_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_schedules" ADD CONSTRAINT "project_schedules_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_process_plans" ADD CONSTRAINT "project_process_plans_project_schedule_id_fkey" FOREIGN KEY ("project_schedule_id") REFERENCES "project_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_process_plans" ADD CONSTRAINT "project_process_plans_process_code_fkey" FOREIGN KEY ("process_code") REFERENCES "lead_time_processes"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_process_plans" ADD CONSTRAINT "project_process_plans_owner_department_code_fkey" FOREIGN KEY ("owner_department_code") REFERENCES "departments"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurements" ADD CONSTRAINT "procurements_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_identifications" ADD CONSTRAINT "material_identifications_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_operations" ADD CONSTRAINT "item_operations_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_tests" ADD CONSTRAINT "item_tests_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_parties" ADD CONSTRAINT "inspection_parties_qcp_template_id_fkey" FOREIGN KEY ("qcp_template_id") REFERENCES "qcp_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_templates" ADD CONSTRAINT "qcp_templates_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_items" ADD CONSTRAINT "qcp_items_qcp_template_id_fkey" FOREIGN KEY ("qcp_template_id") REFERENCES "qcp_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_item_party_codes" ADD CONSTRAINT "qcp_item_party_codes_qcp_item_id_fkey" FOREIGN KEY ("qcp_item_id") REFERENCES "qcp_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_item_party_codes" ADD CONSTRAINT "qcp_item_party_codes_inspection_party_id_fkey" FOREIGN KEY ("inspection_party_id") REFERENCES "inspection_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_executions" ADD CONSTRAINT "qcp_executions_qcp_item_id_fkey" FOREIGN KEY ("qcp_item_id") REFERENCES "qcp_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_executions" ADD CONSTRAINT "qcp_executions_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_drawings" ADD CONSTRAINT "assembly_drawings_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delay_reasons" ADD CONSTRAINT "delay_reasons_project_process_plan_id_fkey" FOREIGN KEY ("project_process_plan_id") REFERENCES "project_process_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariant #5 (CLAUDE.md): audit_log is append-only. The app's DB role
-- must never hold UPDATE/DELETE on this table.
-- NOTE: local dev connects as the Postgres superuser (`postgres`), which
-- bypasses GRANT/REVOKE entirely — this statement is a no-op until a
-- lower-privileged app role exists (Railway deploy, Step 14). Re-run this
-- REVOKE against that role once it's created.
REVOKE UPDATE, DELETE ON "audit_log" FROM PUBLIC;
