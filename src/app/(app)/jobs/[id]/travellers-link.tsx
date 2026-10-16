/** L2.9: one small link from the job page to the A5 traveller print view. A plain anchor: a print page wants a full load, and a client navigation to it stalls (see _tabs/dispatch-tab.tsx). */
export function TravellersLink({ jobId }: { jobId: number }) {
  return (
    <a href={`/jobs/${jobId}/travellers`} className="btn">
      Print travellers
    </a>
  );
}
