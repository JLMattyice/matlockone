import { NextResponse, type NextRequest } from "next/server";

import { getContext } from "@/lib/auth";
import { markConversationRead, threadMessages } from "@/lib/conversations";
import { can } from "@/lib/permissions";

/**
 * Messages in one thread, for the open conversation to poll.
 *
 * `?after=<ISO time>` returns everything from then on; `?before=<message id>`
 * returns the page before it; neither returns the latest page.
 *
 * Fetching the new end of a thread also marks it read up to what was
 * returned. The thread only polls while its tab is visible, so being fetched
 * here is being put in front of somebody. Scrolling back through history is
 * not reading anything new and moves nothing.
 *
 * A thread the caller is not in is a 404, the same as one that never existed.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getContext();
  if (!ctx || !can(ctx.user, "messages:use")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { id } = await params;
  const search = request.nextUrl.searchParams;

  const afterRaw = search.get("after");
  const after = afterRaw ? new Date(afterRaw) : null;
  if (after && Number.isNaN(after.getTime())) {
    return NextResponse.json({ error: "Bad after" }, { status: 400 });
  }
  const beforeId = search.get("before");

  const thread = await threadMessages({
    organizationId: ctx.org.id,
    viewer: ctx.user,
    conversationId: id,
    after,
    beforeId,
  });
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let markedRead = false;
  if (!beforeId) {
    const newest = thread.messages.at(-1)?.createdAt;
    const upTo = newest ? new Date(newest) : after;
    if (upTo) {
      markedRead = await markConversationRead({
        organizationId: ctx.org.id,
        userId: ctx.user.id,
        conversationId: id,
        upTo,
      });
    }
  }

  return NextResponse.json(
    { messages: thread.messages, hasEarlier: thread.hasEarlier, markedRead },
    { headers: { "Cache-Control": "no-store" } },
  );
}
