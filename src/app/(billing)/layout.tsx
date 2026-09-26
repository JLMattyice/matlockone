import Link from "next/link";

import { logoutAction } from "@/app/(auth)/actions";

/**
 * The frame around the billing screen.
 *
 * Outside the application shell on purpose. The shell's layout is where an
 * unpaid business is turned away, so billing cannot live inside it — it would
 * turn itself away. This frame has no navigation to anywhere the business
 * cannot go yet: just the name, and a way to sign out.
 */
export default function BillingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-2">
      <header className="flex items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-xs font-bold text-brand-ink">
            MO
          </span>
          <span className="text-base font-semibold tracking-tight text-ink">Matlock One</span>
        </Link>
        <form action={logoutAction}>
          <button type="submit" className="text-sm text-ink-muted hover:text-ink">
            Sign out
          </button>
        </form>
      </header>

      <main className="flex flex-1 justify-center px-4 pb-12">
        <div className="w-full max-w-4xl">{children}</div>
      </main>
    </div>
  );
}
