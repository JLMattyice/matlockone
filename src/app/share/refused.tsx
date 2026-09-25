import { Clock } from "lucide-react";

import { retryAfterPhrase } from "@/lib/rate-limit";

/**
 * What a share link shows when its address has tried too many that do not
 * exist.
 *
 * Deliberately the same for every link, real or not, and silent about whose
 * document it might be: the point is that a guesser learns nothing from being
 * let in or kept out. The wording is for the real client who mistyped a link
 * a few too many times, and needs to know it will pass.
 */
export function ShareRefused({ retryAfterSeconds }: { retryAfterSeconds: number }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-2 px-4 py-8">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-6 text-center">
        <Clock className="mx-auto h-6 w-6 text-ink-subtle" strokeWidth={1.75} aria-hidden />
        <h1 className="mt-3 text-base font-medium text-ink">
          This link can’t be opened right now
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          Too many links that don’t exist have been tried from your network. Try
          again {retryAfterPhrase(retryAfterSeconds)}, or ask whoever sent it to
          send it again.
        </p>
      </div>
    </div>
  );
}
