import { Info } from "lucide-react";
import { ACCOUNTS, BLOCKS, LINKS, REVENUE_SPLIT, SAT_ALLOCATION, TXS, txUrl, type Row } from "@/lib/sat/explainer";

function RowTable({ rows }: { rows: Row[] }) {
  return (
    <div className="divide-y rounded border">
      {rows.map((r) => (
        <div key={r[0] + r[1]} className="grid gap-1 px-2 py-1 sm:grid-cols-[10rem_1fr]">
          <span className="font-mono font-medium">{r[0]}</span>
          <span>{r[1]}{r[2] && <span className="block text-muted-foreground">{r[2]}</span>}</span>
        </div>
      ))}
    </div>
  );
}

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="text-leef underline underline-offset-2">{children}</a>
);

/** About / How it works: static, public explainer of the platform, bot, SAT and airdrop. */
export function AboutDesk() {
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 text-sm">
      <div className="flex items-center gap-2">
        <Info className="size-4" />
        <h2 className="font-semibold">About / How it works</h2>
      </div>
      <p className="text-muted-foreground">
        Platform <A href={LINKS.platform}>leef-trader.vercel.app</A> · Bot <A href={LINKS.bot}>t.me/LEEF_Trader_Bot</A> ·
        Community <A href={LINKS.community}>t.me/leefmaincorp</A> · <A href={LINKS.leef}>leeftoken.io</A> ·
        Full text <A href={LINKS.explainer}>docs/EXPLAINER.md</A>. Checked against WAX mainnet on 23 Oct 2026.
      </p>
      {BLOCKS.slice(0, 3).map((b) => <Block key={b.heading} b={b} />)}
      <section className="space-y-1">
        <h3 className="font-medium">SAT token</h3>
        <p>Contract sattoken1111 · 4 decimals · max supply 100,000,000 SAT (fixed) · current supply 20,000,000 SAT (10M launch LP + 10M airdrop) · issuer smartaadmin1.</p>
        <RowTable rows={SAT_ALLOCATION} />
      </section>
      <section className="space-y-1">
        <h3 className="font-medium">Revenue split (on-chain, on every payment)</h3>
        <RowTable rows={REVENUE_SPLIT} />
        <p className="text-muted-foreground">Half of all revenue goes back into liquidity. No profit share is paid to holders.</p>
      </section>
      {BLOCKS.slice(3).map((b) => <Block key={b.heading} b={b} />)}
      <section className="space-y-1">
        <h3 className="font-medium">Accounts and contracts</h3>
        <RowTable rows={ACCOUNTS} />
      </section>
      <section className="space-y-1">
        <h3 className="font-medium">On-chain proof</h3>
        <ul className="list-disc space-y-0.5 pl-5">
          {TXS.map(([label, id]) => <li key={id}><A href={txUrl(id)}>{label}</A></li>)}
        </ul>
      </section>
      <p className="text-muted-foreground">Not financial advice. SAT is a utility token for paying and using the trader; it is not a share of profits.</p>
    </div>
  );
}

function Block({ b }: { b: (typeof BLOCKS)[number] }) {
  return (
    <section className="space-y-1">
      <h3 className="font-medium">{b.heading}</h3>
      {b.intro && <p>{b.intro}</p>}
      {b.rows && <RowTable rows={b.rows} />}
      {b.bullets && <ul className="list-disc space-y-0.5 pl-5">{b.bullets.map((x) => <li key={x}>{x}</li>)}</ul>}
      {b.note && <p className="text-muted-foreground">{b.note}</p>}
    </section>
  );
}
