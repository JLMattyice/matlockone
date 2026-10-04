/**
 * The facts the Terms, Privacy Policy and Refund Policy are written around.
 *
 * In one place so the three pages, the footer and the sign-up form cannot
 * disagree about who the agreement is with or where to write. Anything the
 * pages state about how billing behaves is read from the billing code itself
 * (GRACE_DAYS, for one), so a change there changes the policy with it — and a
 * change to these values is a change to a legal agreement, so it should be
 * deliberate and the date below moved with it.
 */

/** Who the agreements are with. */
export const LEGAL_NAME = "Matlock Software Development";

/** Where requests about privacy, refunds and these terms go. */
export const LEGAL_EMAIL = "lane.matlock@matlocksoftware.com";

/** Where customers write for help, linked from inside the app. */
export const SUPPORT_EMAIL = LEGAL_EMAIL;

export const LEGAL_CITY = "Lenoir City, Tennessee";

/** Whose courts and laws govern the Terms. Lenoir City is in Loudon County. */
export const LEGAL_STATE = "Tennessee";
export const LEGAL_COUNTY = "Loudon County, Tennessee";

/** Shown at the top of each page. Move it whenever the wording changes. */
export const LEGAL_UPDATED = "October 3, 2026";

export const LEGAL_PAGES = [
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refunds", label: "Refund Policy" },
] as const;
