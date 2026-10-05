import Link from "next/link";

import { MatlockMark } from "@/components/ui/matlock-mark";

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
            <MatlockMark className="h-9 w-9 shrink-0" />
            <span className="text-lg font-semibold tracking-tight text-ink">
              Matlock One
            </span>
          </Link>
          {children}
        </div>
      </div>
      <footer className="pb-8 text-center text-xs text-ink-subtle">
        <p>Your business, all in one place</p>
        <p className="mt-1">
          <a
            href="https://www.matlocksoftware.com"
            target="_blank"
            rel="noopener"
            className="underline-offset-2 hover:text-ink hover:underline"
          >
            Created by Matlock Software
          </a>
        </p>
      </footer>
    </div>
  );
}
