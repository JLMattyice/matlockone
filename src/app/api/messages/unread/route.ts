import { NextResponse } from "next/server";

import { getContext } from "@/lib/auth";
import { unreadMessageCount } from "@/lib/conversations";
import { can } from "@/lib/permissions";

/**
 * How many team messages are waiting, for the badge in the sidebar.
 *
 * Polled rather than pushed. Neither deployment can hold a connection open —
 * a serverless function exists only while it answers, and the desktop build's
 * server is somebody's office PC — and a small team does not need a message
 * to arrive faster than a glance at the sidebar would find it.
 */
export async function GET() {
  const ctx = await getContext();
  if (!ctx || !can(ctx.user, "messages:use")) {
    return NextResponse.json({ unread: 0 }, { status: 401 });
  }

  const unread = await unreadMessageCount(ctx.org.id, ctx.user.id);
  return NextResponse.json({ unread }, { headers: { "Cache-Control": "no-store" } });
}
