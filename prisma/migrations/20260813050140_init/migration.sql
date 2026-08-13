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
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProcurementStatus" AS ENUM ('NOT_STARTED', 'INDENT_RAISED', 'INDENT_APPROVED', 'PO_PLACED', 'IN_STOCK');

-- CreateEnum
CREATE TYPE "MaterialReceivedStatus" AS ENUM ('NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "PmiResult" AS ENUM ('NA', 'PENDING', 'ACCEPT', 'REJECT');

-- CreateEnum
CREATE TYPE "Sourcing" AS ENUM ('IN_HOUSE', 'OUTSOURCE', 'NA');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETE');

-- CreateEnum
CREATE TYPE "TestResult" AS ENUM ('PENDING', 'ACCEPT', 'REJECT');

-- CreateEnum
CREATE TYPE "QcpItemKind" AS ENUM ('SECTION', 'CHECKPOINT');

-- CreateEnum
CREATE TYPE "QcpExecutionResult" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'NA');

-- CreateEnum
CREATE TYPE "DrawingStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'RELEASED');

-- CreateEnum
CREATE TYPE "DelayReviewStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "SnapshotCadence" AS ENUM ('LIVE', 'DAILY', 'WEEKLY');

-- CreateTable
CREATE TABLE "organizations" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "client_id" INTEGER,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "employee_code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" INTEGER NOT NULL,
    "role_id" INTEGER NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_departments" (
    "user_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,

    CONSTRAINT "user_departments_pkey" PRIMARY KEY ("user_id","department_id")
);

-- CreateTable
CREATE TABLE "component_type_refs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "component_type_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_refs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_department_id" INTEGER,
    "source_column" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "operation_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_type_refs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "test_type_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_type_refs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "drawing_type_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delay_category_refs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "delay_category_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qcp_code_refs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "blocks_completion" BOOLEAN NOT NULL DEFAULT false,
    "requires_call" BOOLEAN NOT NULL DEFAULT false,
    "waivable" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "qcp_code_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_calendars" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "week_off_days" INTEGER[],
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "work_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" SERIAL NOT NULL,
    "calendar_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_families" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "product_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_templates" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "process_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_template_versions" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMP(3),
    "published_by" INTEGER,
    "notes" TEXT,

    CONSTRAINT "process_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_processes" (
    "id" SERIAL NOT NULL,
    "version_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "main_activities" TEXT,
    "duration_min_days" INTEGER NOT NULL,
    "duration_max_days" INTEGER NOT NULL,
    "cumulative_printed" TEXT,
    "default_department_id" INTEGER NOT NULL,
    "work_order_stages" INTEGER[],
    "envelope_finish_by_min_days" INTEGER NOT NULL,
    "envelope_finish_by_max_days" INTEGER NOT NULL,
    "envelope_start_by_min_days" INTEGER NOT NULL,
    "envelope_start_by_max_days" INTEGER NOT NULL,
    "optional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "template_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_edges" (
    "id" SERIAL NOT NULL,
    "version_id" INTEGER NOT NULL,
    "process_id" INTEGER NOT NULL,
    "predecessor_id" INTEGER NOT NULL,
    "type" "ProcessEdgeType" NOT NULL,
    "lag_days" INTEGER NOT NULL,

    CONSTRAINT "template_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "public_id" TEXT NOT NULL,
    "client_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "template_version_id" INTEGER NOT NULL,
    "calendar_id" INTEGER,
    "job_number" TEXT NOT NULL,
    "client_order_no" TEXT,
    "project_name" TEXT,
    "po_ref" TEXT,
    "design_code" TEXT,
    "order_date" TIMESTAMP(3),
    "delivery_date" TIMESTAMP(3),
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "JobStatus" NOT NULL DEFAULT 'ACTIVE',
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
CREATE TABLE "job_processes" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "template_process_id" INTEGER,
    "seq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" INTEGER NOT NULL,
    "duration_min_days" INTEGER NOT NULL,
    "duration_max_days" INTEGER NOT NULL,
    "envelope_finish_by_min_days" INTEGER NOT NULL,
    "envelope_finish_by_max_days" INTEGER NOT NULL,
    "work_order_stages" INTEGER[],
    "included" BOOLEAN NOT NULL DEFAULT true,
    "duration_override_days" INTEGER,
    "override_reason" TEXT,

    CONSTRAINT "job_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_process_edges" (
    "id" SERIAL NOT NULL,
    "process_id" INTEGER NOT NULL,
    "predecessor_id" INTEGER NOT NULL,
    "type" "ProcessEdgeType" NOT NULL,
    "lag_days" INTEGER NOT NULL,

    CONSTRAINT "job_process_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_runs" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "equipment_id" INTEGER,
    "version" INTEGER NOT NULL,
    "mode" "ScheduleMode" NOT NULL,
    "project_start_date" TIMESTAMP(3) NOT NULL,
    "required_delivery_date" TIMESTAMP(3),
    "feasibility" "ScheduleFeasibility",
    "shortfall_days" INTEGER,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_plans" (
    "id" SERIAL NOT NULL,
    "schedule_run_id" INTEGER NOT NULL,
    "job_process_id" INTEGER NOT NULL,
    "unit_id" INTEGER,
    "baseline_start" TIMESTAMP(3),
    "baseline_finish" TIMESTAMP(3),
    "planned_start" TIMESTAMP(3),
    "planned_finish" TIMESTAMP(3),
    "actual_start" TIMESTAMP(3),
    "actual_finish" TIMESTAMP(3),
    "status" "ProcessPlanStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "submitted_by" INTEGER,
    "verified_by" INTEGER,
    "owner_department_id" INTEGER NOT NULL,

    CONSTRAINT "process_plans_pkey" PRIMARY KEY ("id")
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
    "component_type_id" INTEGER,
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
    "pmiResult" "PmiResult",

    CONSTRAINT "material_identifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_templates" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "component_type_id" INTEGER NOT NULL,
    "family_id" INTEGER,
    "name" TEXT NOT NULL,

    CONSTRAINT "route_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_template_versions" (
    "id" SERIAL NOT NULL,
    "route_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'PUBLISHED',
    "printed_route" TEXT,

    CONSTRAINT "route_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_steps" (
    "id" SERIAL NOT NULL,
    "route_version_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "operation_id" INTEGER NOT NULL,
    "printed" TEXT,
    "optional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "route_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "components" (
    "id" SERIAL NOT NULL,
    "equipment_id" INTEGER NOT NULL,
    "unit_id" INTEGER,
    "bom_item_id" INTEGER,
    "tag" TEXT NOT NULL,
    "component_type_id" INTEGER NOT NULL,
    "route_version_id" INTEGER,

    CONSTRAINT "components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "component_operations" (
    "id" SERIAL NOT NULL,
    "component_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "operation_id" INTEGER NOT NULL,
    "sourcing" "Sourcing",
    "status" "OperationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "submitted_by" INTEGER,
    "verified_by" INTEGER,

    CONSTRAINT "component_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_tests" (
    "id" SERIAL NOT NULL,
    "bom_item_id" INTEGER NOT NULL,
    "test_type_id" INTEGER NOT NULL,
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "result" "TestResult" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "item_tests_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "inspection_parties" (
    "id" SERIAL NOT NULL,
    "qcp_template_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "inspection_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qcp_items" (
    "id" SERIAL NOT NULL,
    "qcp_template_id" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
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

    CONSTRAINT "qcp_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qcp_item_processes" (
    "qcp_item_id" INTEGER NOT NULL,
    "job_process_id" INTEGER NOT NULL,

    CONSTRAINT "qcp_item_processes_pkey" PRIMARY KEY ("qcp_item_id","job_process_id")
);

-- CreateTable
CREATE TABLE "qcp_item_party_codes" (
    "qcp_item_id" INTEGER NOT NULL,
    "inspection_party_id" INTEGER NOT NULL,
    "qcp_code_id" INTEGER NOT NULL,

    CONSTRAINT "qcp_item_party_codes_pkey" PRIMARY KEY ("qcp_item_id","inspection_party_id")
);

-- CreateTable
CREATE TABLE "qcp_executions" (
    "id" SERIAL NOT NULL,
    "qcp_item_id" INTEGER NOT NULL,
    "unit_id" INTEGER NOT NULL,
    "attempt_no" INTEGER NOT NULL DEFAULT 1,
    "result" "QcpExecutionResult" NOT NULL DEFAULT 'PENDING',
    "call_given_on" TIMESTAMP(3),
    "call_attended_on" TIMESTAMP(3),
    "cleared_by" INTEGER,
    "cleared_by_party_ref" TEXT,
    "waiver_approved_by" INTEGER,
    "remarks" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qcp_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assembly_drawings" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "drawing_type_id" INTEGER NOT NULL,
    "drawing_no" TEXT,
    "revision_no" TEXT,
    "status" "DrawingStatus" NOT NULL DEFAULT 'DRAFT',
    "approved_date" TIMESTAMP(3),
    "released_date" TIMESTAMP(3),
    "revised_date" TIMESTAMP(3),
    "remarks" TEXT,

    CONSTRAINT "assembly_drawings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delay_reasons" (
    "id" SERIAL NOT NULL,
    "process_plan_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "detail" TEXT,
    "filed_by" INTEGER NOT NULL,
    "filed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_status" "DelayReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" INTEGER,

    CONSTRAINT "delay_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "recipient_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" INTEGER,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "payload" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_visibility_policies" (
    "client_id" INTEGER NOT NULL,
    "show_progress" BOOLEAN NOT NULL DEFAULT true,
    "show_stage_status" BOOLEAN NOT NULL DEFAULT true,
    "show_dates" BOOLEAN NOT NULL DEFAULT true,
    "show_qcp" BOOLEAN NOT NULL DEFAULT true,
    "cadence" "SnapshotCadence" NOT NULL DEFAULT 'WEEKLY',
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "client_visibility_policies_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "progress_snapshots" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "job_id" INTEGER NOT NULL,
    "equipment_id" INTEGER,
    "unit_id" INTEGER,
    "as_of" TIMESTAMP(3) NOT NULL,
    "overall_pct" INTEGER NOT NULL,
    "detail" JSONB,
    "published_by" INTEGER,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "progress_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "actor_id" INTEGER,
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

-- CreateTable
CREATE TABLE "domain_events" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actor_id" INTEGER,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_code_key" ON "organizations"("code");

-- CreateIndex
CREATE INDEX "clients_tenant_id_idx" ON "clients"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tenant_id_code_key" ON "clients"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE INDEX "users_client_id_idx" ON "users"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "roles_tenant_id_idx" ON "roles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_code_key" ON "roles"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE INDEX "departments_tenant_id_idx" ON "departments"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_code_key" ON "departments"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "user_departments_department_id_idx" ON "user_departments"("department_id");

-- CreateIndex
CREATE INDEX "component_type_refs_tenant_id_idx" ON "component_type_refs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "component_type_refs_tenant_id_code_key" ON "component_type_refs"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "operation_refs_tenant_id_idx" ON "operation_refs"("tenant_id");

-- CreateIndex
CREATE INDEX "operation_refs_default_department_id_idx" ON "operation_refs"("default_department_id");

-- CreateIndex
CREATE UNIQUE INDEX "operation_refs_tenant_id_code_key" ON "operation_refs"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "test_type_refs_tenant_id_idx" ON "test_type_refs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_type_refs_tenant_id_code_key" ON "test_type_refs"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "drawing_type_refs_tenant_id_idx" ON "drawing_type_refs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "drawing_type_refs_tenant_id_code_key" ON "drawing_type_refs"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "delay_category_refs_tenant_id_idx" ON "delay_category_refs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "delay_category_refs_tenant_id_code_key" ON "delay_category_refs"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "qcp_code_refs_tenant_id_idx" ON "qcp_code_refs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "qcp_code_refs_tenant_id_code_key" ON "qcp_code_refs"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "work_calendars_tenant_id_idx" ON "work_calendars"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_calendars_tenant_id_code_key" ON "work_calendars"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "holidays_calendar_id_idx" ON "holidays"("calendar_id");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_calendar_id_date_key" ON "holidays"("calendar_id", "date");

-- CreateIndex
CREATE INDEX "product_families_tenant_id_idx" ON "product_families"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_families_tenant_id_code_key" ON "product_families"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "process_templates_tenant_id_idx" ON "process_templates"("tenant_id");

-- CreateIndex
CREATE INDEX "process_templates_family_id_idx" ON "process_templates"("family_id");

-- CreateIndex
CREATE INDEX "process_template_versions_template_id_idx" ON "process_template_versions"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "process_template_versions_template_id_version_key" ON "process_template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "template_processes_version_id_idx" ON "template_processes"("version_id");

-- CreateIndex
CREATE INDEX "template_processes_default_department_id_idx" ON "template_processes"("default_department_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_processes_version_id_code_key" ON "template_processes"("version_id", "code");

-- CreateIndex
CREATE INDEX "template_edges_version_id_idx" ON "template_edges"("version_id");

-- CreateIndex
CREATE INDEX "template_edges_predecessor_id_idx" ON "template_edges"("predecessor_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_edges_process_id_predecessor_id_key" ON "template_edges"("process_id", "predecessor_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_public_id_key" ON "jobs"("public_id");

-- CreateIndex
CREATE INDEX "jobs_tenant_id_idx" ON "jobs"("tenant_id");

-- CreateIndex
CREATE INDEX "jobs_client_id_idx" ON "jobs"("client_id");

-- CreateIndex
CREATE INDEX "jobs_family_id_idx" ON "jobs"("family_id");

-- CreateIndex
CREATE INDEX "jobs_template_version_id_idx" ON "jobs"("template_version_id");

-- CreateIndex
CREATE INDEX "jobs_calendar_id_idx" ON "jobs"("calendar_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_tenant_id_job_number_key" ON "jobs"("tenant_id", "job_number");

-- CreateIndex
CREATE INDEX "equipments_job_id_idx" ON "equipments"("job_id");

-- CreateIndex
CREATE INDEX "units_equipment_id_idx" ON "units"("equipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "units_equipment_id_serial_no_key" ON "units"("equipment_id", "serial_no");

-- CreateIndex
CREATE INDEX "job_processes_job_id_idx" ON "job_processes"("job_id");

-- CreateIndex
CREATE INDEX "job_processes_department_id_idx" ON "job_processes"("department_id");

-- CreateIndex
CREATE INDEX "job_processes_template_process_id_idx" ON "job_processes"("template_process_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_processes_job_id_code_key" ON "job_processes"("job_id", "code");

-- CreateIndex
CREATE INDEX "job_process_edges_predecessor_id_idx" ON "job_process_edges"("predecessor_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_process_edges_process_id_predecessor_id_key" ON "job_process_edges"("process_id", "predecessor_id");

-- CreateIndex
CREATE INDEX "schedule_runs_job_id_idx" ON "schedule_runs"("job_id");

-- CreateIndex
CREATE INDEX "schedule_runs_equipment_id_idx" ON "schedule_runs"("equipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_runs_job_id_equipment_id_version_key" ON "schedule_runs"("job_id", "equipment_id", "version");

-- CreateIndex
CREATE INDEX "process_plans_schedule_run_id_idx" ON "process_plans"("schedule_run_id");

-- CreateIndex
CREATE INDEX "process_plans_job_process_id_idx" ON "process_plans"("job_process_id");

-- CreateIndex
CREATE INDEX "process_plans_unit_id_idx" ON "process_plans"("unit_id");

-- CreateIndex
CREATE INDEX "process_plans_owner_department_id_planned_finish_idx" ON "process_plans"("owner_department_id", "planned_finish");

-- CreateIndex
CREATE INDEX "process_plans_status_idx" ON "process_plans"("status");

-- CreateIndex
CREATE UNIQUE INDEX "process_plans_schedule_run_id_job_process_id_unit_id_key" ON "process_plans"("schedule_run_id", "job_process_id", "unit_id");

-- CreateIndex
CREATE INDEX "bom_items_equipment_id_idx" ON "bom_items"("equipment_id");

-- CreateIndex
CREATE INDEX "bom_items_component_type_id_idx" ON "bom_items"("component_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "procurements_bom_item_id_key" ON "procurements"("bom_item_id");

-- CreateIndex
CREATE INDEX "procurements_status_idx" ON "procurements"("status");

-- CreateIndex
CREATE INDEX "material_identifications_bom_item_id_idx" ON "material_identifications"("bom_item_id");

-- CreateIndex
CREATE INDEX "material_identifications_heat_number_idx" ON "material_identifications"("heat_number");

-- CreateIndex
CREATE INDEX "route_templates_tenant_id_idx" ON "route_templates"("tenant_id");

-- CreateIndex
CREATE INDEX "route_templates_component_type_id_idx" ON "route_templates"("component_type_id");

-- CreateIndex
CREATE INDEX "route_templates_family_id_idx" ON "route_templates"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "route_templates_tenant_id_component_type_id_family_id_key" ON "route_templates"("tenant_id", "component_type_id", "family_id");

-- CreateIndex
CREATE INDEX "route_template_versions_route_id_idx" ON "route_template_versions"("route_id");

-- CreateIndex
CREATE UNIQUE INDEX "route_template_versions_route_id_version_key" ON "route_template_versions"("route_id", "version");

-- CreateIndex
CREATE INDEX "route_steps_route_version_id_idx" ON "route_steps"("route_version_id");

-- CreateIndex
CREATE INDEX "route_steps_operation_id_idx" ON "route_steps"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "route_steps_route_version_id_seq_key" ON "route_steps"("route_version_id", "seq");

-- CreateIndex
CREATE INDEX "components_equipment_id_idx" ON "components"("equipment_id");

-- CreateIndex
CREATE INDEX "components_unit_id_idx" ON "components"("unit_id");

-- CreateIndex
CREATE INDEX "components_bom_item_id_idx" ON "components"("bom_item_id");

-- CreateIndex
CREATE INDEX "components_component_type_id_idx" ON "components"("component_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "components_equipment_id_tag_key" ON "components"("equipment_id", "tag");

-- CreateIndex
CREATE INDEX "component_operations_component_id_idx" ON "component_operations"("component_id");

-- CreateIndex
CREATE INDEX "component_operations_operation_id_idx" ON "component_operations"("operation_id");

-- CreateIndex
CREATE INDEX "component_operations_status_idx" ON "component_operations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "component_operations_component_id_seq_key" ON "component_operations"("component_id", "seq");

-- CreateIndex
CREATE INDEX "item_tests_bom_item_id_idx" ON "item_tests"("bom_item_id");

-- CreateIndex
CREATE INDEX "item_tests_test_type_id_idx" ON "item_tests"("test_type_id");

-- CreateIndex
CREATE INDEX "qcp_templates_job_id_idx" ON "qcp_templates"("job_id");

-- CreateIndex
CREATE INDEX "inspection_parties_qcp_template_id_idx" ON "inspection_parties"("qcp_template_id");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_parties_qcp_template_id_code_key" ON "inspection_parties"("qcp_template_id", "code");

-- CreateIndex
CREATE INDEX "qcp_items_qcp_template_id_idx" ON "qcp_items"("qcp_template_id");

-- CreateIndex
CREATE UNIQUE INDEX "qcp_items_qcp_template_id_sequence_key" ON "qcp_items"("qcp_template_id", "sequence");

-- CreateIndex
CREATE INDEX "qcp_item_processes_job_process_id_idx" ON "qcp_item_processes"("job_process_id");

-- CreateIndex
CREATE INDEX "qcp_item_party_codes_inspection_party_id_idx" ON "qcp_item_party_codes"("inspection_party_id");

-- CreateIndex
CREATE INDEX "qcp_item_party_codes_qcp_code_id_idx" ON "qcp_item_party_codes"("qcp_code_id");

-- CreateIndex
CREATE INDEX "qcp_executions_qcp_item_id_idx" ON "qcp_executions"("qcp_item_id");

-- CreateIndex
CREATE INDEX "qcp_executions_unit_id_idx" ON "qcp_executions"("unit_id");

-- CreateIndex
CREATE INDEX "qcp_executions_result_idx" ON "qcp_executions"("result");

-- CreateIndex
CREATE UNIQUE INDEX "qcp_executions_qcp_item_id_unit_id_attempt_no_key" ON "qcp_executions"("qcp_item_id", "unit_id", "attempt_no");

-- CreateIndex
CREATE INDEX "assembly_drawings_job_id_idx" ON "assembly_drawings"("job_id");

-- CreateIndex
CREATE INDEX "assembly_drawings_drawing_type_id_idx" ON "assembly_drawings"("drawing_type_id");

-- CreateIndex
CREATE INDEX "delay_reasons_process_plan_id_idx" ON "delay_reasons"("process_plan_id");

-- CreateIndex
CREATE INDEX "delay_reasons_category_id_idx" ON "delay_reasons"("category_id");

-- CreateIndex
CREATE INDEX "delay_reasons_review_status_idx" ON "delay_reasons"("review_status");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_idx" ON "notifications"("tenant_id");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_read_at_idx" ON "notifications"("recipient_id", "read_at");

-- CreateIndex
CREATE INDEX "progress_snapshots_tenant_id_idx" ON "progress_snapshots"("tenant_id");

-- CreateIndex
CREATE INDEX "progress_snapshots_job_id_as_of_idx" ON "progress_snapshots"("job_id", "as_of");

-- CreateIndex
CREATE INDEX "progress_snapshots_equipment_id_idx" ON "progress_snapshots"("equipment_id");

-- CreateIndex
CREATE INDEX "progress_snapshots_unit_id_idx" ON "progress_snapshots"("unit_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_entity_type_entity_id_at_idx" ON "audit_log"("tenant_id", "entity_type", "entity_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_actor_id_at_idx" ON "audit_log"("tenant_id", "actor_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_at_idx" ON "audit_log"("tenant_id", "at");

-- CreateIndex
CREATE INDEX "domain_events_tenant_id_aggregate_type_aggregate_id_at_idx" ON "domain_events"("tenant_id", "aggregate_type", "aggregate_id", "at");

-- CreateIndex
CREATE INDEX "domain_events_tenant_id_type_at_idx" ON "domain_events"("tenant_id", "type", "at");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_type_refs" ADD CONSTRAINT "component_type_refs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_refs" ADD CONSTRAINT "operation_refs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_refs" ADD CONSTRAINT "operation_refs_default_department_id_fkey" FOREIGN KEY ("default_department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_type_refs" ADD CONSTRAINT "test_type_refs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drawing_type_refs" ADD CONSTRAINT "drawing_type_refs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delay_category_refs" ADD CONSTRAINT "delay_category_refs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_code_refs" ADD CONSTRAINT "qcp_code_refs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_calendars" ADD CONSTRAINT "work_calendars_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "work_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_families" ADD CONSTRAINT "product_families_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_templates" ADD CONSTRAINT "process_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_templates" ADD CONSTRAINT "process_templates_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "product_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_template_versions" ADD CONSTRAINT "process_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "process_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_processes" ADD CONSTRAINT "template_processes_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "process_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_processes" ADD CONSTRAINT "template_processes_default_department_id_fkey" FOREIGN KEY ("default_department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_edges" ADD CONSTRAINT "template_edges_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "process_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_edges" ADD CONSTRAINT "template_edges_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "template_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_edges" ADD CONSTRAINT "template_edges_predecessor_id_fkey" FOREIGN KEY ("predecessor_id") REFERENCES "template_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "product_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "process_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "work_calendars"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipments" ADD CONSTRAINT "equipments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_processes" ADD CONSTRAINT "job_processes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_processes" ADD CONSTRAINT "job_processes_template_process_id_fkey" FOREIGN KEY ("template_process_id") REFERENCES "template_processes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_processes" ADD CONSTRAINT "job_processes_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_process_edges" ADD CONSTRAINT "job_process_edges_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "job_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_process_edges" ADD CONSTRAINT "job_process_edges_predecessor_id_fkey" FOREIGN KEY ("predecessor_id") REFERENCES "job_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_schedule_run_id_fkey" FOREIGN KEY ("schedule_run_id") REFERENCES "schedule_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_job_process_id_fkey" FOREIGN KEY ("job_process_id") REFERENCES "job_processes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_plans" ADD CONSTRAINT "process_plans_owner_department_id_fkey" FOREIGN KEY ("owner_department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_component_type_id_fkey" FOREIGN KEY ("component_type_id") REFERENCES "component_type_refs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurements" ADD CONSTRAINT "procurements_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_identifications" ADD CONSTRAINT "material_identifications_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_templates" ADD CONSTRAINT "route_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_templates" ADD CONSTRAINT "route_templates_component_type_id_fkey" FOREIGN KEY ("component_type_id") REFERENCES "component_type_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_templates" ADD CONSTRAINT "route_templates_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "product_families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_template_versions" ADD CONSTRAINT "route_template_versions_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "route_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_steps" ADD CONSTRAINT "route_steps_route_version_id_fkey" FOREIGN KEY ("route_version_id") REFERENCES "route_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_steps" ADD CONSTRAINT "route_steps_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "operation_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_component_type_id_fkey" FOREIGN KEY ("component_type_id") REFERENCES "component_type_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_route_version_id_fkey" FOREIGN KEY ("route_version_id") REFERENCES "route_template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "operation_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_tests" ADD CONSTRAINT "item_tests_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_tests" ADD CONSTRAINT "item_tests_test_type_id_fkey" FOREIGN KEY ("test_type_id") REFERENCES "test_type_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_templates" ADD CONSTRAINT "qcp_templates_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_parties" ADD CONSTRAINT "inspection_parties_qcp_template_id_fkey" FOREIGN KEY ("qcp_template_id") REFERENCES "qcp_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_items" ADD CONSTRAINT "qcp_items_qcp_template_id_fkey" FOREIGN KEY ("qcp_template_id") REFERENCES "qcp_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_item_processes" ADD CONSTRAINT "qcp_item_processes_qcp_item_id_fkey" FOREIGN KEY ("qcp_item_id") REFERENCES "qcp_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_item_processes" ADD CONSTRAINT "qcp_item_processes_job_process_id_fkey" FOREIGN KEY ("job_process_id") REFERENCES "job_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_item_party_codes" ADD CONSTRAINT "qcp_item_party_codes_qcp_item_id_fkey" FOREIGN KEY ("qcp_item_id") REFERENCES "qcp_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_item_party_codes" ADD CONSTRAINT "qcp_item_party_codes_inspection_party_id_fkey" FOREIGN KEY ("inspection_party_id") REFERENCES "inspection_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_item_party_codes" ADD CONSTRAINT "qcp_item_party_codes_qcp_code_id_fkey" FOREIGN KEY ("qcp_code_id") REFERENCES "qcp_code_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_executions" ADD CONSTRAINT "qcp_executions_qcp_item_id_fkey" FOREIGN KEY ("qcp_item_id") REFERENCES "qcp_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qcp_executions" ADD CONSTRAINT "qcp_executions_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_drawings" ADD CONSTRAINT "assembly_drawings_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_drawings" ADD CONSTRAINT "assembly_drawings_drawing_type_id_fkey" FOREIGN KEY ("drawing_type_id") REFERENCES "drawing_type_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delay_reasons" ADD CONSTRAINT "delay_reasons_process_plan_id_fkey" FOREIGN KEY ("process_plan_id") REFERENCES "process_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delay_reasons" ADD CONSTRAINT "delay_reasons_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "delay_category_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_visibility_policies" ADD CONSTRAINT "client_visibility_policies_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_snapshots" ADD CONSTRAINT "progress_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_snapshots" ADD CONSTRAINT "progress_snapshots_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_snapshots" ADD CONSTRAINT "progress_snapshots_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_snapshots" ADD CONSTRAINT "progress_snapshots_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
