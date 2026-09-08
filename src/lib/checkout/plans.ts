import { LICENSE_PLANS, type LicensePlan } from "@/lib/license/token";

/**
 * What Matlock One costs, in one place.
 *
 * The marketing page renders from this and checkout charges from it, so the
 * number a visitor reads and the number they are billed cannot drift apart.
 * Prices are integer cents for the same reason every other amount in this
 * codebase is: no float ever touches money.
 */

export type Plan = {
  id: LicensePlan;
  name: string;
  monthlyCents: number;
  /** Active users included. null means unlimited. */
  seats: number | null;
  seatLabel: string;
  tagline: string;
  /** Sold harder than the others, and marked as such on the page. */
  featured: boolean;
  /** Beyond what every plan already includes. */
  extras: string[];
};

/** Annual billing discount, in basis points — 1700 = 17%. */
export const ANNUAL_DISCOUNT_BP = 1700;

export const PLANS: Record<LicensePlan, Plan> = {
  starter: {
    id: "starter",
    name: "Starter",
    monthlyCents: 2_900,
    seats: 1,
    seatLabel: "1 person",
    tagline: "You are the office and the crew.",
    featured: false,
    extras: [],
  },
  business: {
    id: "business",
    name: "Business",
    monthlyCents: 5_900,
    seats: 10,
    seatLabel: "Up to 10 people",
    tagline: "A crew in the field and someone running the books.",
    featured: true,
    extras: ["Crew scheduling and workload"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyCents: 9_900,
    seats: null,
    seatLabel: "Unlimited people",
    tagline: "More than one crew, more than one calendar.",
    featured: false,
    extras: ["Crew scheduling and workload", "Priority support"],
  },
};

/** In the order they are shown and sold. */
export const PLAN_ORDER: LicensePlan[] = [...LICENSE_PLANS];

export const planList = (): Plan[] => PLAN_ORDER.map((id) => PLANS[id]);

export function isPlan(value: unknown): value is LicensePlan {
  return (
    typeof value === "string" &&
    (LICENSE_PLANS as readonly string[]).includes(value)
  );
}

/**
 * What twelve months costs up front.
 *
 * Rounded to whole cents, and rounded *down*, so the discount is never a cent
 * smaller than the one advertised.
 */
export function annualCents(plan: Plan): number {
  const full = plan.monthlyCents * 12;
  return full - Math.ceil((full * ANNUAL_DISCOUNT_BP) / 10_000);
}

/** What a term actually costs, in cents. Twelve months takes the discount. */
export function priceCents(plan: Plan, months: number): number {
  if (months === 12) return annualCents(plan);
  return plan.monthlyCents * months;
}

/** "$29" or "$28.50" — trailing zeroes dropped only when the cents are zero. */
export function formatPrice(cents: number, currency = "USD"): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
