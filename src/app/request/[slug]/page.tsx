import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RequestForm } from "./request-form";
import { prisma } from "@/lib/db";
import { DEFAULT_BRAND_COLOR, formatPhone, hexToRgbChannels } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Request service",
  robots: { index: false, follow: false },
};

/**
 * A business's public "Request service" page — the link it puts on its own
 * website or social pages. From a customer's portal it arrives with
 * ?for={their portal token}, and what it knows about them is filled in.
 */
export default async function RequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ for?: string }>;
}) {
  const { slug } = await params;
  const { for: portalToken } = await searchParams;

  const org = await prisma.organization.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      primaryColor: true,
      phone: true,
      email: true,
      requestsEnabled: true,
    },
  });
  if (!org) notFound();

  const brand = hexToRgbChannels(org.primaryColor) ? org.primaryColor : DEFAULT_BRAND_COLOR;

  const [services, client] = await Promise.all([
    prisma.priceBookItem.findMany({
      where: { organizationId: org.id, kind: "SERVICE", isActive: true },
      select: { name: true },
      orderBy: { name: "asc" },
      take: 40,
    }),
    portalToken
      ? prisma.client.findFirst({
          where: { portalToken, organizationId: org.id },
          select: {
            displayName: true,
            email: true,
            phone: true,
            addresses: {
              where: { isPrimary: true },
              select: { line1: true, city: true, state: true, postalCode: true },
              take: 1,
            },
          },
        })
      : null,
  ]);

  const contact = [org.phone ? formatPhone(org.phone) : null, org.email].filter(Boolean).join(" or ");

  return (
    <div
      style={{ "--brand": brand } as React.CSSProperties}
      className="min-h-screen bg-surface-2 px-4 py-8 sm:py-12"
    >
      <div className="mx-auto max-w-2xl space-y-5">
        <header className="flex items-center gap-3">
          {org.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={org.logoUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg object-contain" />
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-sm text-ink-muted">{org.name}</p>
            <h1 className="text-xl font-semibold tracking-tight text-ink">Request service</h1>
          </div>
        </header>

        {org.requestsEnabled ? (
          <RequestForm
            slug={slug}
            businessName={org.name}
            brandColor={brand}
            services={services.map((service) => service.name)}
            portalToken={client ? portalToken! : null}
            prefill={
              client
                ? {
                    name: client.displayName,
                    email: client.email ?? "",
                    phone: client.phone ?? "",
                    line1: client.addresses[0]?.line1 ?? "",
                    city: client.addresses[0]?.city ?? "",
                    state: client.addresses[0]?.state ?? "",
                    postalCode: client.addresses[0]?.postalCode ?? "",
                  }
                : null
            }
          />
        ) : (
          <div className="rounded-card border border-line bg-surface p-6 text-sm text-ink-muted">
            {org.name} isn&apos;t taking requests online right now.
            {contact ? ` Please get in touch on ${contact}.` : ""}
          </div>
        )}

        {contact ? (
          <p className="pb-6 text-center text-xs text-ink-subtle">Rather talk? {contact}.</p>
        ) : null}
      </div>
    </div>
  );
}
