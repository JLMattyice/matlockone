import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import PrivacyPage from "@/app/(marketing)/privacy/page";
import RefundPolicyPage from "@/app/(marketing)/refunds/page";
import TermsPage from "@/app/(marketing)/terms/page";
import { GRACE_DAYS } from "@/lib/billing/entitlement";
import { LEGAL_EMAIL, LEGAL_NAME, LEGAL_PAGES } from "@/lib/legal";
import { middleware } from "@/middleware";

/**
 * The Terms, Privacy Policy and Refund Policy.
 *
 * Words cannot be tested for being right, but they can be tested for drifting
 * away from the code they describe. The policy states the grace period, so it
 * must state the one billing uses; it names three cookies and no tracking, so
 * a fourth cookie or an analytics package fails here until the page is
 * updated to say so. And somebody about to sign up has to be able to read
 * them without an account.
 */

const render = (page: () => React.ReactElement) =>
  renderToStaticMarkup(createElement(page))
    // React separates adjacent text and expressions with comment markers.
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;|&rsquo;/g, "’");

const PAGES = [
  { href: "/terms", page: TermsPage },
  { href: "/privacy", page: PrivacyPage },
  { href: "/refunds", page: RefundPolicyPage },
] as const;

describe("the legal pages", () => {
  it("each names who the agreement is with and where to write", () => {
    for (const { page } of PAGES) {
      const html = render(page);
      expect(html).toContain(LEGAL_NAME);
      expect(html).toContain(`mailto:${LEGAL_EMAIL}`);
      expect(html).toContain("The short version");
    }
  });

  it("each links to the other two", () => {
    for (const { href, page } of PAGES) {
      const html = render(page);
      for (const other of LEGAL_PAGES.filter((item) => item.href !== href)) {
        expect(html).toContain(`href="${other.href}"`);
      }
    }
  });

  it("states the grace period billing actually gives", () => {
    expect(render(RefundPolicyPage)).toContain(`open for ${GRACE_DAYS} days`);
    expect(render(TermsPage)).toContain(`open for ${GRACE_DAYS} days`);
  });

  it("promises no refunds for unused time, and refunds for mistakes", () => {
    const html = render(RefundPolicyPage);
    expect(html).toContain("We don’t refund unused time");
    expect(html).toContain("We refund in full");
  });

  it("can be read without an account", () => {
    for (const { href } of LEGAL_PAGES) {
      const response = middleware(new NextRequest(`https://www.matlockone.com${href}`));
      expect(response.headers.get("location"), href).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- drift ---

const SRC = path.resolve(__dirname, "../src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("what the Privacy Policy promises", () => {
  it("is still true about cookies: only the three it names", () => {
    // The policy lists a sign-in cookie, a remembered-email cookie and a
    // time-zone cookie. A new file touching cookies means a new cookie, and
    // the policy has to say what it is for before this passes again.
    const touching = sourceFiles(SRC)
      .filter((file) => /\bcookies\(\)|document\.cookie/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file).replace(/\\/g, "/"))
      .sort();

    expect(touching).toEqual([
      "components/app-shell/time-zone.tsx",
      "lib/remembered-email.ts",
      "lib/session.ts",
      "lib/viewer-time-zone.ts",
    ]);
  });

  it("is still true about tracking: no analytics or advertising packages", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

    const trackers = names.filter((name) =>
      /analytics|gtag|google-tag|posthog|segment|mixpanel|plausible|amplitude|hotjar|speed-insights|facebook|pixel/i.test(
        name,
      ),
    );
    expect(trackers).toEqual([]);
  });
});
