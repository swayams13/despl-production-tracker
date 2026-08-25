// One-off: set a Job's real orderDate/committedDeliveryDate directly (no
// client-timestamp path exists for this in the app UI yet), then the caller
// re-runs `pnpm db:bootstrap <jobNumber>` to regenerate the schedule off it.
//
// Run with: pnpm tsx scripts/set-job-dates.ts <jobNumber> <orderDate YYYY-MM-DD> <committedDeliveryDate YYYY-MM-DD>
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

async function main() {
  const [jobNumber, orderDateStr, deliveryDateStr] = process.argv.slice(2);
  if (!jobNumber || !orderDateStr || !deliveryDateStr) {
    throw new Error("usage: set-job-dates.ts <jobNumber> <orderDate> <committedDeliveryDate>");
  }

  const job = await prisma.job.findFirst({ where: { jobNumber } });
  if (!job) throw new Error(`job ${jobNumber} not found`);

  const updated = await prisma.job.update({
    where: { id: job.id },
    data: {
      orderDate: new Date(orderDateStr),
      committedDeliveryDate: new Date(deliveryDateStr),
    },
  });

  console.log(
    `${jobNumber}: orderDate=${updated.orderDate?.toISOString().slice(0, 10)} committedDeliveryDate=${updated.committedDeliveryDate?.toISOString().slice(0, 10)}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
