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

export default function TradeWorkspacePanel() {
  return (
    <>
      <Card title="Account Summary">
        <div className="text-sm text-neutral-300">Alpaca account data will go here.</div>
      </Card>

      <Card title="Order Ticket">
        <div className="text-sm text-neutral-300">
          Entry, stop, target, and order controls will go here.
        </div>
      </Card>

      <Card title="Active Orders">
        <div className="text-sm text-neutral-500">No active orders.</div>
      </Card>
    </>
  );
}