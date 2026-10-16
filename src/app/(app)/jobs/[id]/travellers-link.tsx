import Link from "next/link";

/** L2.9: one small link from the job page to the A5 traveller print view. */
export function TravellersLink({ jobId }: { jobId: number }) {
  return (
    <Link href={`/jobs/${jobId}/travellers`} className="btn">
      Print travellers
    </Link>
  );
}
