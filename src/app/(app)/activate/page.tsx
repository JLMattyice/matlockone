import { redirect } from "next/navigation";

/**
 * The licence page moved into Settings, where it sits beside Email and
 * Payments — the other things a business configures about how it operates
 * commercially.
 *
 * This alias stays because /activate is the address that goes out with a
 * licence key, and a URL printed in an email outlives any amount of internal
 * tidying.
 */
export default async function ActivateRedirect({
  searchParams,
}: {
  searchParams: Promise<{ seats?: string }>;
}) {
  const { seats } = await searchParams;
  redirect(seats ? `/settings/license?seats=${seats}` : "/settings/license");
}
