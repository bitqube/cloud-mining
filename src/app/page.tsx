import { Suspense } from "react";
import { ButtonLink } from "@/components/ui";
import { Qube } from "@/components/qube";
import { Tilt } from "@/components/tilt";
import { currentUser } from "@/lib/auth";
import { hashrate } from "@/lib/format";
import { networkStats } from "@/lib/network";

const STEPS = [
  ["Choose a plan", "Pick a coin, a share of a full-power rig and how many days, from one day to a month."],
  ["Lock a live price", "We price it against the global hashrate market right now and hold it for 15 minutes."],
  ["Pay", "Card, USDT, or part in BTQ. Your rig time is booked the moment payment confirms."],
  ["Mine to your wallet", "During your slot the rig mines on the pool with your address. The pool pays you directly."],
];

const FEATURES = [
  {
    title: "Your keys, your coins",
    body: "Mined coins never touch us. During your slot the rig mines with your address as the worker, so payouts land in your wallet.",
    icon: "M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z M9 12l2 2 4-4",
  },
  {
    title: "Real market pricing",
    body: "Hashrate is rented from a live global marketplace. You see the actual price for the actual rigs, locked before you pay.",
    icon: "M3 17l6-6 4 4 8-8 M15 7h6v6",
  },
  {
    title: "Watched around the clock",
    body: "Every rental is monitored. Under-delivering rigs are replaced or refunded, and you get an email at each step.",
    icon: "M2 12h4l3-8 4 16 3-8h6",
  },
];

const TICKER = ["KAWPOW", "60-SECOND BLOCKS", "NON-CUSTODIAL", "PAID BY THE POOL", "15-MIN PRICE LOCK", "DARK GRAVITY WAVE", "HOURLY CONTRACTS", "LIVE RIG MONITORING"];

async function LiveStats() {
  const net = await networkStats();
  const stats: Array<[string, string]> = [
    ["Network", net.hashrateMh === null ? "—" : hashrate(net.hashrateMh)],
    ["Difficulty", net.difficulty === null ? "—" : net.difficulty.toFixed(3)],
    ["Block time", "60 s"],
    ["Payout", "Direct"],
  ];
  return <StatRow stats={stats} />;
}

function StatRow({ stats }: { stats: Array<[string, string]> }) {
  return (
    <dl className="mt-10 grid max-w-xl grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
      {stats.map(([k, v]) => (
        <div key={k}>
          <dt className="text-[11px] uppercase tracking-[0.18em] text-muted">{k}</dt>
          <dd className="num mt-1.5 text-lg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export default async function Home() {
  const user = await currentUser();
  return (
    <div className="overflow-x-clip">
      {/* Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-6 px-4 pt-10 pb-6 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-16">
        <div>
          <div className="rise flex flex-wrap gap-2 text-xs">
            <span className="glass inline-flex items-center gap-2 rounded-full px-3 py-1">
              <span className="live-dot" /> Live on BitQube mainnet
            </span>
            <span className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-accent">Non-custodial</span>
          </div>
          <h1 className="rise mt-6 text-5xl leading-[1.02] font-semibold sm:text-6xl lg:text-7xl" style={{ "--d": "80ms" } as React.CSSProperties}>
            Mine BitQube
            <br />
            <span className="text-gradient">from the cloud.</span>
          </h1>
          <p className="rise mt-6 max-w-xl text-lg leading-relaxed text-muted" style={{ "--d": "160ms" } as React.CSSProperties}>
            Rent time on full-power rigs for BitQube and other top coins. Your slot mines under your own address, so every coin it
            finds is paid straight to you. No hardware, no heat, no custody.
          </p>
          <div className="rise mt-8 flex flex-wrap gap-3" style={{ "--d": "240ms" } as React.CSSProperties}>
            <ButtonLink href="/buy" className="px-6 py-3">
              Rent hashrate
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </ButtonLink>
            {!user && (
              <ButtonLink href="/signup" variant="secondary" className="px-6 py-3">
                Create account
              </ButtonLink>
            )}
          </div>
          <Suspense fallback={<StatRow stats={[["Network", "…"], ["Difficulty", "…"], ["Block time", "60 s"], ["Payout", "Direct"]]} />}>
            <LiveStats />
          </Suspense>
        </div>

        <div className="relative mx-auto aspect-square w-full max-w-[620px]">
          <Qube className="absolute inset-0 sm:inset-[-8%]" />
          <div className="glass float absolute hidden sm:block top-[12%] left-0 rounded-2xl px-4 py-3 text-xs" style={{ "--d": "0s" } as React.CSSProperties}>
            <div className="text-muted">Rig rented</div>
            <div className="num mt-0.5 text-sm">2.1 GH/s · 24 h</div>
          </div>
          <div className="glass float absolute hidden sm:block right-0 bottom-[18%] rounded-2xl px-4 py-3 text-xs" style={{ "--d": "-2.5s" } as React.CSSProperties}>
            <div className="text-muted">Payout to</div>
            <div className="num mt-0.5 text-sm text-accent">B…your address</div>
          </div>
          <div className="glass float absolute hidden sm:block bottom-[4%] left-[12%] rounded-2xl px-4 py-3 text-xs" style={{ "--d": "-5s" } as React.CSSProperties}>
            <div className="text-muted">Block reward</div>
            <div className="num mt-0.5 text-sm">3.5 BTQ / 60 s</div>
          </div>
        </div>
      </section>

      {/* Ticker */}
      <div className="marquee border-y border-line py-4">
        <div>
          {[...TICKER, ...TICKER].map((t, i) => (
            <span key={i} className="num flex items-center gap-8 pr-8 text-xs tracking-[0.25em] text-muted">
              {t}
              <span className="h-1.5 w-1.5 rotate-45 bg-accent/70" />
            </span>
          ))}
        </div>
      </div>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
        <p className="text-xs tracking-[0.25em] text-accent uppercase">How it works</p>
        <h2 className="mt-3 max-w-2xl text-3xl font-semibold sm:text-4xl">From checkout to hashing in minutes.</h2>
        <div className="relative mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="pointer-events-none absolute top-[38px] right-[12%] left-[12%] hidden h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent lg:block" />
          {STEPS.map(([title, body], i) => (
            <Tilt key={title} className="glass edge-glow rounded-3xl p-6">
              <div className="step-index num grid h-10 w-10 place-items-center rounded-xl text-sm text-accent">0{i + 1}</div>
              <h3 className="font-display mt-5 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
            </Tilt>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-24 sm:px-6 md:grid-cols-3">
        {FEATURES.map((f) => (
          <Tilt key={f.title} className="glass edge-glow rounded-3xl p-7" max={6}>
            <div className="text-accent">
              <Icon d={f.icon} />
            </div>
            <h3 className="font-display mt-5 text-lg font-semibold">{f.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
          </Tilt>
        ))}
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="cta-band edge-glow glass flex flex-col items-start justify-between gap-6 rounded-[2rem] p-10 md:flex-row md:items-center">
          <div>
            <h2 className="text-3xl font-semibold sm:text-4xl">The mine is already running.</h2>
            <p className="mt-3 max-w-lg text-muted">Get a live price for your hashrate. It&apos;s held for 15 minutes while you decide.</p>
          </div>
          <ButtonLink href="/buy" className="px-7 py-3.5 text-base">
            Get a live price
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}
