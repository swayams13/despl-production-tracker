-- CreateTable
CREATE TABLE "welders" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "employee_code" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "department_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "welders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weld_joints" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "unit_id" INTEGER,
    "joint_no" TEXT NOT NULL,
    "joint_type" TEXT NOT NULL,
    "weld_size" TEXT,
    "logged_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weld_joints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weld_joint_welders" (
    "weld_joint_id" INTEGER NOT NULL,
    "welder_id" INTEGER NOT NULL,

    CONSTRAINT "weld_joint_welders_pkey" PRIMARY KEY ("weld_joint_id","welder_id")
);

-- CreateTable
CREATE TABLE "weld_logs" (
    "id" SERIAL NOT NULL,
    "welder_id" INTEGER NOT NULL,
    "job_id" INTEGER NOT NULL,
    "log_date" DATE NOT NULL,
    "hours" DECIMAL(5,2),
    "output_qty" INTEGER,
    "note" TEXT,
    "logged_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weld_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ndt_results" (
    "id" SERIAL NOT NULL,
    "weld_joint_id" INTEGER NOT NULL,
    "test_type_id" INTEGER NOT NULL,
    "result" "TestResult" NOT NULL DEFAULT 'PENDING',
    "recorded_by" INTEGER,
    "recorded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ndt_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "welders_tenant_id_idx" ON "welders"("tenant_id");

-- CreateIndex
CREATE INDEX "welders_department_id_idx" ON "welders"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "welders_tenant_id_employee_code_key" ON "welders"("tenant_id", "employee_code");

-- CreateIndex
CREATE INDEX "weld_joints_job_id_idx" ON "weld_joints"("job_id");

-- CreateIndex
CREATE INDEX "weld_joints_unit_id_idx" ON "weld_joints"("unit_id");

-- CreateIndex
CREATE INDEX "weld_joint_welders_welder_id_idx" ON "weld_joint_welders"("welder_id");

-- CreateIndex
CREATE INDEX "weld_logs_welder_id_idx" ON "weld_logs"("welder_id");

-- CreateIndex
CREATE INDEX "weld_logs_job_id_idx" ON "weld_logs"("job_id");

-- CreateIndex
CREATE INDEX "ndt_results_weld_joint_id_idx" ON "ndt_results"("weld_joint_id");

-- CreateIndex
CREATE INDEX "ndt_results_test_type_id_idx" ON "ndt_results"("test_type_id");

-- AddForeignKey
ALTER TABLE "welders" ADD CONSTRAINT "welders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welders" ADD CONSTRAINT "welders_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weld_joints" ADD CONSTRAINT "weld_joints_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weld_joints" ADD CONSTRAINT "weld_joints_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weld_joint_welders" ADD CONSTRAINT "weld_joint_welders_weld_joint_id_fkey" FOREIGN KEY ("weld_joint_id") REFERENCES "weld_joints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weld_joint_welders" ADD CONSTRAINT "weld_joint_welders_welder_id_fkey" FOREIGN KEY ("welder_id") REFERENCES "welders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weld_logs" ADD CONSTRAINT "weld_logs_welder_id_fkey" FOREIGN KEY ("welder_id") REFERENCES "welders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weld_logs" ADD CONSTRAINT "weld_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ndt_results" ADD CONSTRAINT "ndt_results_weld_joint_id_fkey" FOREIGN KEY ("weld_joint_id") REFERENCES "weld_joints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ndt_results" ADD CONSTRAINT "ndt_results_test_type_id_fkey" FOREIGN KEY ("test_type_id") REFERENCES "test_type_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant RLS on the one new tenant-root table (welders — a registry, like
-- Department/TestTypeRef). weld_joints/weld_logs/ndt_results are children
-- reachable only via job_id, matching every other job-child table (BomItem,
-- Component, ItemTest, …) — no RLS on those, per the fail-closed migration's
-- documented pattern (child tables rely on reachability + service scoping).
ALTER TABLE "welders" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "welders"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);
