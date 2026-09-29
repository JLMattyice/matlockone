"use strict";

const crypto = require("node:crypto");

/**
 * The automations that wait for a date, run by the launcher on a desktop
 * install that keeps its own data.
 *
 * Chasing an overdue invoice and checking in on a quiet customer need
 * something to notice that a day has passed. The hosted app has Vercel call
 * /api/cron/automations every morning; a desktop install has nothing that
 * wakes up by itself, so until now those two waited for somebody to press
 * Check now. The launcher calls the same route instead — a couple of minutes
 * after the server starts, so it never slows the first screen, and every few
 * hours after that while the app is open.
 *
 * Running it often costs nothing: each automation raises one task per invoice
 * or customer however many times it runs. The route wants a secret, and this
 * one is made fresh for every launch and never written down. The server binds
 * to the office network, and the route must not answer anybody else on it.
 */

const FIRST_RUN_MS = 2 * 60 * 1000;
const EVERY_MS = 3 * 60 * 60 * 1000;

/** A secret for this launch only, long enough for the route to accept. */
function newSweepSecret() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Starts the timer. Returns a function that stops it.
 *
 * Nothing here throws, and nothing here keeps the app alive: a failed run is
 * one line in the log and the next is already scheduled, and the timers are
 * unref'd so they never hold the process open at quit.
 */
function startAutomationSweeps({
  baseUrl,
  secret,
  log = () => {},
  fetchImpl = globalThis.fetch,
  timers = { setTimeout, setInterval, clearTimeout, clearInterval },
  firstRunMs = FIRST_RUN_MS,
  everyMs = EVERY_MS,
}) {
  let running = false;

  async function run() {
    // A slow run is never stacked on by the next tick.
    if (running) return;
    running = true;
    try {
      const response = await fetchImpl(`${baseUrl}/api/cron/automations`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      if (!response.ok) {
        log(`[automations] check refused: ${response.status}\n`);
        return;
      }
      const result = await response.json();
      log(
        `[automations] checked ${result.businesses ?? 0} business(es), raised ${result.created ?? 0} task(s)` +
          (result.failed && result.failed.length ? `, ${result.failed.length} failed` : "") +
          (result.drafted ? `, drafted ${result.drafted} repeating invoice(s)` : "") +
          "\n",
      );
    } catch (error) {
      log(`[automations] check did not run: ${error && error.message ? error.message : error}\n`);
    } finally {
      running = false;
    }
  }

  const first = timers.setTimeout(run, firstRunMs);
  const repeat = timers.setInterval(run, everyMs);
  first?.unref?.();
  repeat?.unref?.();

  return function stop() {
    timers.clearTimeout(first);
    timers.clearInterval(repeat);
  };
}

module.exports = { startAutomationSweeps, newSweepSecret, FIRST_RUN_MS, EVERY_MS };
