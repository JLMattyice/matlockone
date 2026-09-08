import Link from "next/link";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-2">
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-100">
          <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-ink">
              WS
            </span>
            <span className="text-lg font-semibold tracking-tight text-ink">
              Matlock One
            </span>
          </Link>
          {children}
        </div>
      </div>
      <footer className="pb-8 text-center text-xs text-ink-subtle">
        Field service management for small teams
      </footer>
    </div>
  );
}
