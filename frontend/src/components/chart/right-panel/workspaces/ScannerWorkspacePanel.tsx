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

export default function ScannerWorkspacePanel() {
  return (
    <>
      <Card title="Scanner Results">
        <div className="text-sm text-neutral-500">No scanner results loaded.</div>
      </Card>

      <Card title="Filters">
        <div className="text-sm text-neutral-300">
          Timeframe, setup, and watchlist filters will go here.
        </div>
      </Card>
    </>
  );
}