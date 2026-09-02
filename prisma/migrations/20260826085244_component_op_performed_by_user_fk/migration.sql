-- CreateIndex
CREATE INDEX "component_operations_performed_by_user_id_idx" ON "component_operations"("performed_by_user_id");

-- AddForeignKey
ALTER TABLE "component_operations" ADD CONSTRAINT "component_operations_performed_by_user_id_fkey" FOREIGN KEY ("performed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
