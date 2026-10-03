import { describe, expect, test } from "vitest";

import { MODULES, SHOWCASE } from "@/components/marketing/showcase";
import {
  ESTIMATE_STATUS_META,
  INVOICE_STATUS_META,
  JOB_STATUS_META,
  LEAD_STATUS_META,
} from "@/lib/constants";
import { NAVIGATION } from "@/lib/navigation";

/**
 * The marketing page's tour of the app is built from the app's sidebar, so it
 * cannot list a screen that does not exist. These keep the other direction
 * honest: a screen added to the app gets a place on the page, and a badge on
 * the page is one the app can actually show.
 */
describe("marketing showcase", () => {
  test("shows every screen in the sidebar except Settings", () => {
    const screens = NAVIGATION.flatMap((group) => group.items)
      .map((item) => item.href)
      .filter((href) => href !== "/settings");

    expect(MODULES.map((module) => module.id)).toEqual(screens);
  });

  test("describes nothing the sidebar does not have", () => {
    const hrefs = new Set(
      NAVIGATION.flatMap((group) => group.items).map((item) => item.href),
    );
    for (const href of Object.keys(SHOWCASE)) expect(hrefs).toContain(href);
  });

  test("uses only statuses the app shows", () => {
    const real: Record<string, Set<string>> = {
      "/leads": labels(LEAD_STATUS_META),
      "/jobs": labels(JOB_STATUS_META),
      "/schedule": labels(JOB_STATUS_META),
      "/estimates": labels(ESTIMATE_STATUS_META),
      "/invoices": labels(INVOICE_STATUS_META),
    };

    for (const [href, allowed] of Object.entries(real)) {
      for (const row of SHOWCASE[href].rows) {
        expect(allowed, `${href}: "${row.status}"`).toContain(row.status);
      }
    }
  });
});

function labels(meta: Record<string, { label: string }>) {
  return new Set(Object.values(meta).map((entry) => entry.label));
}
