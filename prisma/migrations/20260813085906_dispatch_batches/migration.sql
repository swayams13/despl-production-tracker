-- CreateTable
CREATE TABLE "dispatch_batches" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "planned_date" TIMESTAMP(3) NOT NULL,
    "qty" INTEGER,
    "remarks" TEXT,

    CONSTRAINT "dispatch_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispatch_batches_job_id_idx" ON "dispatch_batches"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_batches_job_id_seq_key" ON "dispatch_batches"("job_id", "seq");

-- AddForeignKey
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
