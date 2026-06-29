function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900/80 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {title}
      </div>
      {children}
    </section>
  );
}

export default function NewsWorkspacePanel() {
  return (
    <>
      <Card title="Headlines">
        <div className="text-sm text-neutral-500">News module coming later.</div>
      </Card>

      <Card title="Events">
        <div className="text-sm text-neutral-300">
          Earnings, filings, offerings, halts, and ratings will go here.
        </div>
      </Card>
    </>
  );
}