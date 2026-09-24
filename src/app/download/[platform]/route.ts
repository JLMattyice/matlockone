import { NextResponse } from "next/server";

import {
  fallbackDownload,
  isPlatform,
  latestInstaller,
  RELEASES_PAGE,
} from "@/lib/releases";

/**
 * /download/windows and /download/mac — always the newest installer.
 *
 * The download buttons point here rather than at a file, so the address on
 * the page never goes stale: publishing a release is enough to change where it
 * leads, with no setting to edit afterwards. Resolved when somebody clicks, not
 * when the page rendered, so a page that sat open in a tab over a release
 * still hands out the new one.
 *
 * Never an error page. Somebody who pressed Download should get a download,
 * or failing that the list of releases to choose from — not a stack trace
 * because github.com was slow to answer.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params;

  if (!isPlatform(platform)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const lookup = await latestInstaller(platform);

  // 302 rather than 308: this address is meant to lead somewhere different
  // after the next release, and a browser that cached a permanent redirect
  // would keep downloading the old installer.
  if (lookup.status === "found") {
    return NextResponse.redirect(lookup.installer.url, 302);
  }

  return NextResponse.redirect(fallbackDownload(platform) ?? RELEASES_PAGE, 302);
}
