import { Qube } from "@/components/qube";

// Log in, sign up and password reset: form on the left, the live Qube on the right.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto grid min-h-[calc(100vh-130px)] max-w-6xl items-center gap-8 px-4 py-12 sm:px-6 lg:grid-cols-2">
      <div className="flex justify-center lg:justify-start">{children}</div>
      <div className="relative hidden aspect-square w-full lg:block">
        <Qube className="absolute inset-0" />
        <p className="absolute inset-x-0 bottom-4 text-center text-xs tracking-[0.2em] text-muted uppercase">
          Hashrate in · BTQ out · straight to your wallet
        </p>
      </div>
    </div>
  );
}
