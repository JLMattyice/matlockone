import "server-only";

import { dataStaysOnThisMachine } from "./config";
import { clientAddress, hit, peek, SHARE_MISSES_PER_IP } from "./rate-limit";

/**
 * The limit in front of every public share link: the estimate and invoice
 * pages, the actions on them, and the pay redirect.
 *
 * A share link is the whole credential. Its token is a cuid, whose random part
 * is short, so the thing worth stopping is somebody trying tokens until one
 * opens. Views of a real link are never counted — a client can open their
 * invoice as often as they like — but every lookup that finds nothing is, per
 * address, and an address past the limit is refused all links until its
 * window closes. See SHARE_MISSES_PER_IP.
 *
 * Off on a desktop install. There, every device on the office network shares
 * one "unknown" address, so one mistyped link too many would lock the whole
 * office out, and the links only resolve on that network anyway.
 *
 * Both halves fail open. If the limit itself cannot be read or written, a
 * client trying to pay an invoice is let through: the limit is a speed bump
 * on guessing, not the lock on the door.
 */

async function missKey() {
  return `share:miss:${await clientAddress()}`;
}

export type ShareVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Whether this address may look up a share link at all right now. */
export async function shareAllowed(): Promise<ShareVerdict> {
  if (dataStaysOnThisMachine()) return { ok: true };

  try {
    const verdict = await peek(await missKey(), SHARE_MISSES_PER_IP);
    return verdict.ok ? { ok: true } : { ok: false, retryAfterSeconds: verdict.retryAfterSeconds };
  } catch {
    return { ok: true };
  }
}

/** Counts one lookup that found no such link. */
export async function shareMissed(): Promise<void> {
  if (dataStaysOnThisMachine()) return;

  try {
    await hit(await missKey(), SHARE_MISSES_PER_IP);
  } catch {
    // Failing open, as above.
  }
}
