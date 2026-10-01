import { loadFeed, parseFeedPath } from "@/lib/calendar-feed-server";
import { shareAllowed, shareMissed } from "@/lib/share-guard";

/**
 * A person's schedule as an .ics file, fetched by Google, Outlook or Apple
 * Calendar every few hours.
 *
 * Under /api, so the sign-in gate in middleware never sees it: a calendar app
 * has no session to send. The token in the path is the credential, and it
 * sits behind the same guess limit as the share links: views of a real feed
 * are never counted, every lookup that finds nothing is.
 */
export const dynamic = "force-dynamic";

const HEADERS = {
  "Content-Type": "text/calendar; charset=utf-8",
  // The feed changes whenever the schedule does, and it is one person's.
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ feed: string }> },
) {
  const verdict = await shareAllowed();
  if (!verdict.ok) {
    return new Response("Too many attempts. Try again later.", {
      status: 429,
      headers: { "Retry-After": String(verdict.retryAfterSeconds) },
    });
  }

  const parsed = parseFeedPath((await params).feed);
  if (!parsed) {
    await shareMissed();
    return notFound();
  }

  const feed = await loadFeed(parsed.token, parsed.all);

  if (feed.kind === "missing") {
    await shareMissed();
    return notFound();
  }

  if (feed.kind === "locked") {
    return new Response(
      "This calendar is paused until the Matlock One subscription is renewed.",
      { status: 403 },
    );
  }

  return new Response(feed.body, {
    headers: {
      ...HEADERS,
      "Content-Disposition": 'inline; filename="matlock-one.ics"',
    },
  });
}

function notFound() {
  // Says nothing about why: a token that never existed and one that was
  // turned off look the same from outside.
  return new Response("No such calendar.", { status: 404 });
}
