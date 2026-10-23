import type { Metadata, Viewport } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans, Syne } from "next/font/google";
import { NavLink } from "@/components/nav-link";
import { ThemeToggle, themeBootScript } from "@/components/theme-toggle";
import { currentUser } from "@/lib/auth";
import { hashrate } from "@/lib/format";
import { networkStats } from "@/lib/network";
import { logoutAction } from "./(auth)/actions";
import "./globals.css";

const sans = IBM_Plex_Sans({ variable: "--font-sans-face", subsets: ["latin"], weight: ["400", "500", "600"] });
const mono = IBM_Plex_Mono({ variable: "--font-mono-face", subsets: ["latin"], weight: ["400", "500"] });
const display = Syne({ variable: "--font-display-face", subsets: ["latin"], weight: ["500", "600", "700"] });

export const metadata: Metadata = {
  title: "BitQube Cloud Mining",
  description: "Rent KawPOW hashrate that mines BitQube (BTQ) straight to your wallet.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#07080b" },
    { media: "(prefers-color-scheme: light)", color: "#f3f5f9" },
  ],
};

// Streams in after the page, so a slow explorer never delays rendering.
async function NetworkChip() {
  const net = await networkStats();
  if (net.hashrateMh === null) return null;
  return (
    <span className="glass hidden items-center gap-2 rounded-full px-3 py-1.5 text-xs lg:inline-flex">
      <span className="live-dot" />
      <span className="tracking-widest text-muted">NET</span>
      <span className="num">{hashrate(net.hashrateMh)}</span>
    </span>
  );
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className={`${sans.variable} ${mono.variable} ${display.variable} flex min-h-screen flex-col antialiased`}>
        <div className="backdrop">
          <div className="floor" />
          <div className="scan" />
        </div>

        <header className="sticky top-0 z-40 border-b border-line bg-bg/60 backdrop-blur-xl">
          <nav className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
            <Link href="/" className="group flex shrink-0 items-center gap-2.5">
              <Image src="/logo.png" alt="" width={30} height={30} className="transition duration-500 group-hover:rotate-[20deg] group-hover:scale-110" />
              <span className="font-display text-[15px] font-semibold tracking-tight whitespace-nowrap">
                BitQube <span className="text-muted max-[380px]:hidden">Cloud</span>
              </span>
            </Link>

            {user && (
              <div className="glass ml-2 hidden items-center gap-1 rounded-full p-1 md:flex">
                <NavLink href="/buy">Buy hashrate</NavLink>
                <NavLink href="/orders">My orders</NavLink>
                {user.role === "ADMIN" && <NavLink href="/admin">Admin</NavLink>}
              </div>
            )}

            <div className="ml-auto flex items-center gap-1.5 text-sm whitespace-nowrap sm:gap-2">
              <Suspense fallback={null}>
                <NetworkChip />
              </Suspense>
              <ThemeToggle />
              {user ? (
                <form action={logoutAction}>
                  <button className="rounded-full px-2 py-1.5 text-muted transition hover:text-text sm:px-3">Log out</button>
                </form>
              ) : (
                <>
                  <Link href="/login" className="rounded-full px-2 py-1.5 text-muted transition hover:text-text sm:px-3">
                    Log in
                  </Link>
                  <Link href="/signup" className="btn-primary rounded-full px-3.5 py-1.5 font-semibold transition sm:px-4">
                    Sign up
                  </Link>
                </>
              )}
            </div>
          </nav>
          {user && (
            <div className="flex justify-center gap-1 border-t border-line px-2 py-1.5 md:hidden">
              <NavLink href="/buy">Buy</NavLink>
              <NavLink href="/orders">Orders</NavLink>
              {user.role === "ADMIN" && <NavLink href="/admin">Admin</NavLink>}
            </div>
          )}
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-xs text-muted sm:flex-row sm:px-6">
            <span className="flex items-center gap-2">
              <Image src="/logo.png" alt="" width={16} height={16} /> BitQube Cloud Mining
            </span>
            <span>Mined BTQ is paid by pool.bitqube.org directly to your address. We never hold your mined coins.</span>
            <a href="https://pool.bitqube.org" className="transition hover:text-accent" target="_blank" rel="noreferrer">
              pool.bitqube.org ↗
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
