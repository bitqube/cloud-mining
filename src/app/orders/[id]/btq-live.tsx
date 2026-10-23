"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cx } from "@/components/ui";

// Client bits of the BTQ payment card: re-fetch the page while waiting for the payment,
// a countdown to the end of the payment window, and copy buttons.

export function AutoRefresh({ everyMs = 15_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}

export function Countdown({ until }: { until: string }) {
  const end = new Date(until).getTime();
  const [left, setLeft] = useState<number | null>(null); // null until mounted, so server and client render the same
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [end]);
  if (left === null) return <span className="num">--:--</span>;
  if (left === 0) return <span className="text-bad">closed</span>;
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = String(left % 60).padStart(2, "0");
  return <span className={cx("num", left < 300 && "text-warn")}>{h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`}</span>;
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // Clipboard blocked (e.g. plain http); the value is on screen to copy by hand.
        }
      }}
      className="shrink-0 rounded-full border border-line px-3 py-1 text-xs whitespace-nowrap text-muted hover:border-accent hover:text-accent"
    >
      {done ? "Copied" : label}
    </button>
  );
}
