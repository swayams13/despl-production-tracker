-- AlterTable
ALTER TABLE "component_operations" ADD COLUMN     "performed_by_user_id" INTEGER,
ADD COLUMN     "performed_by_welder_id" INTEGER,
ADD COLUMN     "qtyGood" INTEGER,
ADD COLUMN     "qtyPlanned" INTEGER,
ADD COLUMN     "qtyRejected" INTEGER,
ADD COLUMN     "remarks" TEXT;

-- CreateTable
CREATE TABLE "component_operation_rejections" (
    "id" SERIAL NOT NULL,
    "component_operation_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "detail" TEXT,
    "rejected_by" INTEGER NOT NULL,
    "rejected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "component_operation_rejections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "component_operation_rejections_component_operation_id_idx" ON "component_operation_rejections"("component_operation_id");

-- CreateIndex
CREATE INDEX "component_operation_rejections_category_id_idx" ON "component_operation_rejections"("category_id");

-- CreateIndex
CREATE INDEX "component_operations_performed_by_welder_id_idx" ON "component_operations"("performed_by_welder_id");

-- AddForeignKey
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_performed_by_welder_id_fkey" FOREIGN KEY ("performed_by_welder_id") REFERENCES "welders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_operation_rejections" ADD CONSTRAINT "component_operation_rejections_component_operation_id_fkey" FOREIGN KEY ("component_operation_id") REFERENCES "component_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_operation_rejections" ADD CONSTRAINT "component_operation_rejections_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "delay_category_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
