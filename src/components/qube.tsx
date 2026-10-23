"use client";

import dynamic from "next/dynamic";

// three.js only loads in the browser, and only on pages that show the Qube.
export const Qube = dynamic(() => import("./qube-scene"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-full bg-[radial-gradient(circle,var(--glow-a),transparent_60%)]" />,
});
