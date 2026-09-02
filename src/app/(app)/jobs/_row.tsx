"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

// ponytail: only the job-number text was a <Link>, but tr.row:hover lights up
// the whole row — matching the onClick convention already used for clickable
// rows elsewhere (command/[dept]/_client.tsx, my-day/_client.tsx).
export function JobRow({ jobId, children }: { jobId: number; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr className="row" onClick={() => router.push(`/jobs/${jobId}`)} style={{ cursor: "pointer" }}>
      {children}
    </tr>
  );
}
