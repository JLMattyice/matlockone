/**
 * Demo data for Matlock One.
 *
 * Deterministic: the PRNG is seeded, so `npm run db:reset` always produces the
 * same workspace. That matters for a demo you show more than once — the numbers
 * on the dashboard do not move between walkthroughs.
 *
 * Dates are generated relative to *today*, so the schedule always looks live.
 *
 * Runs against whichever database DATABASE_URL points at. That matters more
 * than it looks: the demo workspace is the hosted deployment's shop window, not
 * just a development convenience. A seed that could only fill a SQLite file
 * left the hosted database empty, which is what put every route on a redirect
 * to signup while the landing page advertised credentials for an account that
 * did not exist.
 */

// First, and it must stay first: it loads .env before src/lib/db.ts, which
// reads DATABASE_URL at import time.
import "../scripts/load-env";

import { randomBytes } from "node:crypto";

import { addMonths, format, subMonths } from "date-fns";

import { vocabularyColumns } from "../src/lib/business-types";
import { createPrismaClient } from "../src/lib/db";
import { providerFor } from "../src/lib/db-provider";
import { signedSnapshot, snapshotHash } from "../src/lib/estimate-signature";
import { computeTotals, depositCentsFor, formatMoney } from "../src/lib/money";
import { hashPassword } from "../src/lib/password";
import { DEFAULT_BRAND_COLOR } from "../src/lib/utils";

// Adapter selection lives in src/lib/db.ts. Going through it means the seed
// reaches Postgres or SQLite by the same rule the application uses, rather than
// a second copy of that rule that can drift from it — which is exactly what the
// hardcoded SQLite adapter here used to be.
const prisma = createPrismaClient();

// --------------------------------------------------------------- helpers ---

/** mulberry32 — small, fast, seeded. Keeps demo data stable across reseeds. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(20260826);

const pick = <T,>(items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)];

const int = (min: number, max: number) =>
  Math.floor(rng() * (max - min + 1)) + min;

const chance = (probability: number) => rng() < probability;

const DAY = 24 * 60 * 60 * 1000;

function dayAt(offsetDays: number, hour: number, minute = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY);
}

/** Money cannot arrive tomorrow. Keeps generated history behind "now". */
function noLaterThanNow(date: Date) {
  const now = Date.now();
  return date.getTime() > now ? new Date(now - int(1, 6) * 60 * 60 * 1000) : date;
}

// ------------------------------------------------------------ fixed data ---

const SERVICES = [
  { name: "HVAC system tune-up", low: 14_900, high: 24_900, minutes: 90 },
  { name: "AC unit replacement", low: 380_000, high: 720_000, minutes: 480 },
  { name: "Furnace repair", low: 22_500, high: 68_000, minutes: 150 },
  { name: "Ductwork cleaning", low: 45_000, high: 95_000, minutes: 240 },
  { name: "Water heater install", low: 120_000, high: 210_000, minutes: 300 },
  { name: "Drain clearing", low: 18_500, high: 42_000, minutes: 90 },
  { name: "Panel upgrade", low: 180_000, high: 340_000, minutes: 420 },
  { name: "Lighting installation", low: 32_000, high: 88_000, minutes: 180 },
  { name: "Thermostat replacement", low: 24_500, high: 46_000, minutes: 60 },
  { name: "Seasonal maintenance visit", low: 12_900, high: 19_900, minutes: 75 },
  { name: "Emergency leak repair", low: 28_000, high: 95_000, minutes: 120 },
  { name: "Gutter replacement", low: 95_000, high: 240_000, minutes: 360 },
];

const MATERIALS = [
  { name: "Refrigerant R-410A", unit: "lb", cost: 4_200 },
  { name: 'Air filter, 20x25x1', unit: "ea", cost: 1_850 },
  { name: "Copper pipe, 3/4in", unit: "ft", cost: 940 },
  { name: "PVC fittings kit", unit: "kit", cost: 3_400 },
  { name: "Thermostat, programmable", unit: "ea", cost: 12_800 },
  { name: "Circuit breaker, 20A", unit: "ea", cost: 2_250 },
  { name: "Duct sealant", unit: "tube", cost: 1_600 },
  { name: "Condensate pump", unit: "ea", cost: 8_900 },
];

// Kept disjoint from the staff names above: a demo where a customer shares a
// technician's name reads as a bug during a walkthrough.
const PEOPLE = [
  ["Andre", "Bellamy"], ["Nina", "Castellanos"], ["Wes", "Fairbanks"],
  ["Iris", "Kowalczyk"], ["Rashid", "Alameddine"], ["Joy", "Tanaka"],
  ["Curtis", "Ballard"], ["Simone", "Achebe"], ["Hal", "Petrossian"],
  ["Delia", "Moreau"], ["Oscar", "Nakamura"], ["Bev", "Hollingsworth"],
  ["Tariq", "Nasser"], ["Lena", "Vasquez"], ["Desmond", "Achterberg"],
  ["Fiona", "Mbeki"], ["Gil", "Rasmussen"], ["Yara", "Haddad"],
  ["Peter", "Onwuka"], ["Rosa", "Villanueva"], ["Kenji", "Watanabe"],
  ["Mabel", "Thorne"],
];

const BUSINESSES = [
  "Harbor Point Property Group", "Cedar & Vine Restaurant", "Lakeshore Dental",
  "Fulton Street Lofts", "Ridgeline Storage", "The Brass Kettle Cafe",
  "Meridian Physical Therapy", "Ashcroft Veterinary Clinic",
];

const STREETS = [
  "Alder Ridge Rd", "Kestrel Ln", "Beaumont Ave", "Old Mill Ct", "Sycamore Bend",
  "Waverly Pl", "Ironwood Dr", "Hollis St", "Cranbrook Way", "Pemberton Row",
  "Sandpiper Cir", "Thistledown Ln", "Marlowe Ave", "Quarry Hill Rd",
  "Ferncliff Dr", "Belvedere St", "Juniper Hollow", "Wexford Ct",
];

const CITIES = [
  ["Millbrook", "NC", "27502"], ["Fairhaven", "NC", "27511"],
  ["Oakmont", "NC", "27519"], ["Rosedale", "NC", "27523"],
  ["Kingsbury", "NC", "27560"],
];

const LEAD_SOURCES = ["REFERRAL", "WEBSITE", "GOOGLE", "SOCIAL", "REPEAT", "WALK_IN"];

const CLIENT_NOTES = [
  "Gate code is 4417. Dog is friendly but leave the side gate closed.",
  "Prefers morning appointments. Works from home after 1pm.",
  "Unit is in the crawlspace — bring the short ladder.",
  "Billing goes to the property manager, not the tenant.",
  "Repeat customer since 2019. Always tips the crew.",
  "Call ahead 30 minutes; parking is tight on this street.",
  "Has a service agreement — two visits per year included.",
];

const JOB_NOTES = [
  "Customer reported intermittent short cycling before we arrived.",
  "Found a clogged condensate line. Cleared and flushed.",
  "Recommended a full system replacement within 18 months.",
  "Second visit — parts were on backorder from the first call.",
  "Left the replaced components with the customer as requested.",
  "Access panel screws were stripped; replaced them.",
];

// ------------------------------------------------------------------ seed ---

async function main() {
  console.log("Seeding Matlock One demo data…");

  // The organization cascade clears every child table, so a reseed is clean
  // without hand-ordering 20 deletes.
  await prisma.organization.deleteMany({ where: { slug: "northside-home-services" } });

  const org = await prisma.organization.create({
    data: {
      slug: "northside-home-services",
      // Read-only when this is the public demo on the hosted database, so
      // visitors can look and not change it: see requireContext(). Writable
      // when seeded into a local SQLite file, because that copy is the
      // developer's own workspace for trying changes out.
      isDemo: providerFor(process.env.DATABASE_URL) === "postgresql",
      name: "Northside Home Services",
      legalName: "Northside Home Services LLC",
      email: "office@northsidehome.test",
      phone: "9195550142",
      website: "https://northsidehome.test",
      addressLine1: "1420 Beaumont Ave",
      addressLine2: "Suite 210",
      city: "Millbrook",
      state: "NC",
      postalCode: "27502",
      country: "US",
      primaryColor: DEFAULT_BRAND_COLOR,
      accentColor: "#0f172a",
      currency: "USD",
      locale: "en-US",
      timeZone: "America/New_York",
      // A plumbing and heating company, so the contractor vocabulary — which
      // is also what the demo screens on the marketing site are captured from.
      businessType: "CONTRACTOR",
      ...vocabularyColumns("CONTRACTOR"),
      defaultTaxRateBp: 725,
      invoicePrefix: "INV-",
      estimatePrefix: "EST-",
      jobPrefix: "JOB-",
      invoiceNextNumber: 1001,
      estimateNextNumber: 1001,
      jobNextNumber: 1001,
      defaultPaymentTermsDays: 30,
      defaultEstimateValidDays: 30,
      invoiceFooter:
        "Thank you for your business. Please include the invoice number with your payment.",
      estimateFooter:
        "This estimate is valid for 30 days. Pricing assumes standard access to the work area.",
    },
  });

  // Every demo account shares one password so a walkthrough can switch roles.
  const passwordHash = await hashPassword("demo1234");

  const staff = await Promise.all(
    [
      { email: "owner@demo.test", name: "Alex Rivera", role: "OWNER", position: "Owner", rate: 0 },
      { email: "admin@demo.test", name: "Dana Okonkwo", role: "ADMIN", position: "Operations Manager", rate: 4_500 },
      { email: "manager@demo.test", name: "Marcus Whitfield", role: "MANAGER", position: "Service Manager", rate: 4_200 },
      { email: "tech1@demo.test", name: "Priya Raghavan", role: "EMPLOYEE", position: "Lead Technician", rate: 3_800 },
      { email: "tech2@demo.test", name: "Tom Delacroix", role: "EMPLOYEE", position: "HVAC Technician", rate: 3_400 },
      { email: "tech3@demo.test", name: "Grace Lindqvist", role: "EMPLOYEE", position: "Apprentice", rate: 2_400 },
    ].map((person, i) =>
      prisma.user.create({
        data: {
          organizationId: org.id,
          email: person.email,
          name: person.name,
          passwordHash,
          role: person.role,
          position: person.position,
          hourlyRateCents: person.rate || null,
          phone: `919555${String(2100 + i).padStart(4, "0")}`,
          lastLoginAt: dayAt(-int(0, 3), int(7, 18)),
        },
      }),
    ),
  );

  const technicians = staff.filter((u) => u.role === "EMPLOYEE");
  const owner = staff[0];
  const manager = staff[2];

  console.log(`  ${staff.length} team members`);

  // -------------------------------------------------------------- groups ---

  const groups = await Promise.all(
    [
      {
        name: "Northside",
        description: "Everything north of the river.",
        leadId: technicians[0].id,
        members: [technicians[0].id, technicians[1].id],
      },
      {
        name: "Southside",
        description: "The southern half of the service area.",
        leadId: technicians[2].id,
        members: [technicians[2].id],
      },
      {
        name: "Front office",
        description: "Scheduling, quoting and billing.",
        leadId: staff[1].id,
        members: [staff[1].id, staff[2].id],
      },
    ].map((group) =>
      prisma.group.create({
        data: {
          organizationId: org.id,
          name: group.name,
          description: group.description,
          leadId: group.leadId,
          members: { create: group.members.map((userId) => ({ userId })) },
        },
      }),
    ),
  );

  const fieldGroups = groups.slice(0, 2);

  console.log(`  ${groups.length} groups`);

  // ------------------------------------------------------------- clients ---

  const clients: {
    id: string;
    addressId: string;
    displayName: string;
    contactName: string;
    email: string | null;
    phone: string | null;
    isBusiness: boolean;
  }[] = [];

  for (let i = 0; i < 22; i++) {
    const isBusiness = i < BUSINESSES.length && chance(0.55);
    const [firstName, lastName] = PEOPLE[i % PEOPLE.length];
    const businessName = isBusiness ? BUSINESSES[i % BUSINESSES.length] : null;
    const displayName = businessName ?? `${firstName} ${lastName}`;
    const [city, state, postalCode] = pick(CITIES);

    const client = await prisma.client.create({
      data: {
        organizationId: org.id,
        type: isBusiness ? "BUSINESS" : "PERSON",
        firstName,
        lastName,
        businessName,
        displayName,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.test`,
        phone: `919555${String(3000 + i).padStart(4, "0")}`,
        mobilePhone: chance(0.6) ? `919555${String(4000 + i).padStart(4, "0")}` : null,
        status: i > 19 ? "INACTIVE" : "ACTIVE",
        source: pick(LEAD_SOURCES),
        taxExempt: isBusiness && chance(0.2),
        createdById: pick([owner.id, manager.id]),
        createdAt: dayAt(-int(30, 900), int(8, 17)),
        addresses: {
          create: {
            organizationId: org.id,
            label: "Service address",
            line1: `${int(100, 9800)} ${pick(STREETS)}`,
            city,
            state,
            postalCode,
            isPrimary: true,
            isBilling: true,
          },
        },
      },
      include: { addresses: true },
    });

    clients.push({
      id: client.id,
      addressId: client.addresses[0].id,
      displayName: client.displayName,
      contactName: `${firstName} ${lastName}`,
      email: client.email,
      phone: client.phone,
      isBusiness,
    });

    if (chance(0.45)) {
      await prisma.note.create({
        data: {
          organizationId: org.id,
          clientId: client.id,
          body: pick(CLIENT_NOTES),
          visibility: "INTERNAL",
          pinned: chance(0.25),
          authorId: pick(staff).id,
          createdAt: dayAt(-int(5, 300), int(8, 18)),
        },
      });
    }
  }

  console.log(`  ${clients.length} clients`);

  // ---------------------------------------------------------- price book ---

  await prisma.priceBookItem.createMany({
    data: [
      ...SERVICES.map((s) => ({
        organizationId: org.id,
        kind: "SERVICE",
        name: s.name,
        unit: "job",
        unitPriceCents: Math.round((s.low + s.high) / 2),
        taxable: true,
      })),
      ...MATERIALS.map((m) => ({
        organizationId: org.id,
        kind: "MATERIAL",
        name: m.name,
        unit: m.unit,
        unitPriceCents: Math.round(m.cost * 1.4),
        taxable: true,
      })),
      {
        organizationId: org.id,
        kind: "LABOR",
        name: "Standard labor",
        unit: "hr",
        unitPriceCents: 9_500,
        taxable: false,
      },
      {
        organizationId: org.id,
        kind: "LABOR",
        name: "After-hours labor",
        unit: "hr",
        unitPriceCents: 14_250,
        taxable: false,
      },
    ],
  });

  // --------------------------------------------------------------- leads ---

  const leadStatuses = [
    "NEW", "NEW", "NEW", "CONTACTED", "CONTACTED", "QUALIFIED",
    "QUALIFIED", "ESTIMATE_SENT", "NEGOTIATION", "WON", "WON", "LOST",
  ];

  for (let i = 0; i < leadStatuses.length; i++) {
    const [firstName, lastName] = PEOPLE[(i + 5) % PEOPLE.length];
    const status = leadStatuses[i];
    const createdAt = dayAt(-int(1, 60), int(8, 19));

    // A won lead is linked to the client it converted into, so the lead and
    // that client describe the same person. Picking an unrelated client would
    // make the "converted to" link on the lead read as a bug.
    const wonClient = status === "WON" ? pick(clients) : null;

    await prisma.lead.create({
      data: {
        organizationId: org.id,
        name: wonClient
          ? wonClient.isBusiness
            ? wonClient.contactName
            : wonClient.displayName
          : `${firstName} ${lastName}`,
        businessName: wonClient
          ? wonClient.isBusiness
            ? wonClient.displayName
            : null
          : chance(0.25)
            ? pick(BUSINESSES)
            : null,
        email: wonClient?.email ?? `${firstName.toLowerCase()}${i}@example.test`,
        phone:
          wonClient?.phone ?? `919555${String(5000 + i).padStart(4, "0")}`,
        source: pick(LEAD_SOURCES),
        status,
        estimatedValueCents: int(15, 320) * 1_000,
        lostReason: status === "LOST" ? "Went with a cheaper quote." : null,
        assignedToId: pick([manager.id, staff[1].id]),
        createdById: manager.id,
        lastContactedAt: status === "NEW" ? null : dayAt(-int(0, 20), int(9, 17)),
        convertedAt: status === "WON" ? dayAt(-int(1, 15), 12) : null,
        clientId: wonClient?.id ?? null,
        createdAt,
        notes: chance(0.5)
          ? {
              create: {
                organizationId: org.id,
                body: "Left a voicemail and sent a follow-up email with availability.",
                visibility: "INTERNAL",
                authorId: manager.id,
                createdAt: addDays(createdAt, 1),
              },
            }
          : undefined,
      },
    });
  }

  console.log(`  ${leadStatuses.length} leads`);

  // ---------------------------------------------------------------- jobs ---

  let jobNumber = org.jobNextNumber;
  const completedJobs: { id: string; clientId: string; addressId: string; service: (typeof SERVICES)[number]; completedAt: Date }[] = [];

  // Spread work from 120 days back through 21 days ahead so the dashboard,
  // the calendar and the revenue chart all have something to show.
  for (let offset = -120; offset <= 21; offset++) {
    const isWeekend = [0, 6].includes(dayAt(offset, 12).getDay());
    const jobsToday = isWeekend ? (chance(0.25) ? 1 : 0) : int(0, 3);

    for (let n = 0; n < jobsToday; n++) {
      const client = pick(clients);
      const service = pick(SERVICES);
      const startHour = pick([8, 9, 10, 11, 13, 14, 15]);
      const start = dayAt(offset, startHour, pick([0, 30]));
      const end = addMinutes(start, service.minutes);
      const isAppointment = chance(0.22);

      let status: string;
      if (offset < 0) status = chance(0.9) ? "COMPLETED" : "CANCELLED";
      else if (offset === 0) status = pick(["IN_PROGRESS", "IN_PROGRESS", "CONFIRMED", "COMPLETED"]);
      else status = chance(0.55) ? "CONFIRMED" : "SCHEDULED";

      const crew = [pick(technicians)];
      if (service.minutes > 240 && chance(0.7)) {
        const second = pick(technicians);
        if (second.id !== crew[0].id) crew.push(second);
      }

      // The group answerable for it — the one the lead actually belongs to,
      // so the demo's group filters return work that makes sense.
      const group =
        fieldGroups.find((candidate) =>
          candidate.name === "Northside"
            ? [technicians[0].id, technicians[1].id].includes(crew[0].id)
            : crew[0].id === technicians[2].id,
        ) ?? null;

      const job = await prisma.job.create({
        data: {
          organizationId: org.id,
          number: `${org.jobPrefix}${jobNumber++}`,
          kind: isAppointment ? "APPOINTMENT" : "JOB",
          title: isAppointment ? `${service.name} — estimate visit` : service.name,
          description: chance(0.6)
            ? "Customer called in describing the issue; dispatched to diagnose and repair on site."
            : null,
          clientId: client.id,
          addressId: client.addressId,
          groupId: group?.id ?? null,
          status,
          priority: chance(0.12) ? pick(["HIGH", "URGENT"]) : "NORMAL",
          scheduledStart: start,
          scheduledEnd: end,
          estimatedMinutes: service.minutes,
          startedAt: ["IN_PROGRESS", "COMPLETED"].includes(status)
            ? addMinutes(start, int(-10, 25))
            : null,
          completedAt: status === "COMPLETED" ? addMinutes(end, int(-30, 60)) : null,
          cancelledAt: status === "CANCELLED" ? addDays(start, -1) : null,
          cancelReason: status === "CANCELLED" ? "Customer rescheduled." : null,
          createdById: pick([manager.id, staff[1].id]),
          createdAt: addDays(start, -int(1, 14)),
          assignments: {
            create: crew.map((tech, i) => ({
              userId: tech.id,
              isLead: i === 0,
            })),
          },
        },
      });

      if (status === "COMPLETED") {
        completedJobs.push({
          id: job.id,
          clientId: client.id,
          addressId: client.addressId,
          service,
          completedAt: job.completedAt!,
        });

        // Materials and logged hours on finished work.
        const materialCount = int(0, 3);
        for (let m = 0; m < materialCount; m++) {
          const material = pick(MATERIALS);
          const quantity = int(1, 6);
          await prisma.jobMaterial.create({
            data: {
              organizationId: org.id,
              jobId: job.id,
              name: material.name,
              quantity,
              unit: material.unit,
              unitCostCents: material.cost,
              totalCents: material.cost * quantity,
            },
          });
        }

        for (const tech of crew) {
          const minutes = Math.round(service.minutes * (0.8 + rng() * 0.5));
          await prisma.timeEntry.create({
            data: {
              organizationId: org.id,
              jobId: job.id,
              userId: tech.id,
              startedAt: start,
              endedAt: addMinutes(start, minutes),
              minutes,
              hourlyRateCents: tech.hourlyRateCents ?? 3_500,
            },
          });
        }
      }

      if (chance(0.35)) {
        await prisma.note.create({
          data: {
            organizationId: org.id,
            jobId: job.id,
            body: pick(JOB_NOTES),
            visibility: "INTERNAL",
            authorId: pick(crew).id,
            createdAt: addMinutes(start, 60),
          },
        });
      }
    }
  }

  console.log(`  ${jobNumber - org.jobNextNumber} jobs (${completedJobs.length} completed)`);

  // ----------------------------------------------------------- estimates ---

  let estimateNumber = org.estimateNextNumber;
  const acceptedEstimates: { id: string; clientId: string; addressId: string; title: string }[] = [];
  const estimateStatuses = [
    "DRAFT", "DRAFT", "SENT", "SENT", "SENT", "VIEWED", "VIEWED",
    "ACCEPTED", "ACCEPTED", "ACCEPTED", "DECLINED", "EXPIRED",
  ];

  for (const status of estimateStatuses) {
    const client = pick(clients);
    const issueDate = dayAt(-int(3, 75), int(9, 16));
    const lineItems = buildLineItems();
    const taxRateBp = chance(0.85) ? org.defaultTaxRateBp : 0;
    const discountType = chance(0.25) ? "PERCENT" : "NONE";
    const discountValue = discountType === "PERCENT" ? pick([500, 1000]) : 0;

    const totals = computeTotals({
      lineItems: lineItems.map((li) => ({
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        taxable: li.taxable,
      })),
      discountType: discountType as "NONE" | "PERCENT",
      discountValue,
      taxRateBp,
    });

    const createdEstimate = await prisma.estimate.create({
      data: {
        organizationId: org.id,
        number: `${org.estimatePrefix}${estimateNumber++}`,
        title: lineItems[0].name,
        status,
        clientId: client.id,
        addressId: client.addressId,
        issueDate,
        expiresAt: addDays(issueDate, org.defaultEstimateValidDays),
        sentAt: status === "DRAFT" ? null : addDays(issueDate, 1),
        viewedAt: ["VIEWED", "ACCEPTED", "DECLINED"].includes(status)
          ? addDays(issueDate, 2)
          : null,
        acceptedAt: status === "ACCEPTED" ? addDays(issueDate, 3) : null,
        declinedAt: status === "DECLINED" ? addDays(issueDate, 4) : null,
        declineReason: status === "DECLINED" ? "Budget did not allow it this year." : null,
        subtotalCents: totals.subtotalCents,
        discountType,
        discountValue,
        discountCents: totals.discountCents,
        taxRateBp,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        notes: chance(0.5)
          ? "Pricing includes haul-away of the old equipment and a one-year labor warranty."
          : null,
        terms: org.estimateFooter,
        createdById: pick([manager.id, staff[1].id]),
        createdAt: issueDate,
        lineItems: {
          create: lineItems.map((li, i) => ({
            kind: li.kind,
            name: li.name,
            description: li.description,
            quantity: li.quantity,
            unit: li.unit,
            unitPriceCents: li.unitPriceCents,
            taxable: li.taxable,
            totalCents: totals.lineTotalsCents[i],
            sortOrder: i,
          })),
        },
      },
    });

    if (status === "ACCEPTED") {
      acceptedEstimates.push({
        id: createdEstimate.id,
        clientId: client.id,
        addressId: client.addressId,
        title: lineItems[0].name,
      });
    }
  }

  // One accepted estimate is converted into a scheduled job, so a fresh demo
  // shows the quote-to-work chain rather than only the statuses.
  const toConvert = acceptedEstimates[0];
  if (toConvert) {
    const start = dayAt(int(3, 14), pick([8, 9, 10, 13]), 0);
    const convertedJob = await prisma.job.create({
      data: {
        organizationId: org.id,
        number: `${org.jobPrefix}${jobNumber++}`,
        kind: "JOB",
        title: toConvert.title,
        description: "Booked from the accepted estimate.",
        clientId: toConvert.clientId,
        addressId: toConvert.addressId,
        status: "CONFIRMED",
        priority: "NORMAL",
        scheduledStart: start,
        scheduledEnd: addMinutes(start, 240),
        estimatedMinutes: 240,
        createdById: manager.id,
        assignments: { create: [{ userId: pick(technicians).id, isLead: true }] },
      },
    });

    await prisma.estimate.update({
      where: { id: toConvert.id },
      data: { convertedJobId: convertedJob.id },
    });
  }

  console.log(`  ${estimateStatuses.length} estimates (1 converted to a job)`);

  // ------------------------------------------------- invoices & payments ---

  let invoiceNumber = org.invoiceNextNumber;
  let paymentCount = 0;

  // Bill roughly four out of five completed jobs, oldest first, so the aging
  // buckets look like a real receivables ledger.
  const billable = completedJobs
    .slice()
    .sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime())
    .filter(() => chance(0.8));

  for (const job of billable) {
    const issueDate = addDays(job.completedAt, int(0, 3));
    const dueDate = addDays(issueDate, org.defaultPaymentTermsDays);
    const lineItems = buildLineItems(job.service);
    const taxRateBp = org.defaultTaxRateBp;

    const totals = computeTotals({
      lineItems: lineItems.map((li) => ({
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        taxable: li.taxable,
      })),
      discountType: "NONE",
      discountValue: 0,
      taxRateBp,
    });

    const daysSinceIssue = Math.floor((Date.now() - issueDate.getTime()) / DAY);

    // Older invoices are far more likely to be settled.
    const settlement =
      daysSinceIssue > 60
        ? pick(["PAID", "PAID", "PAID", "PAID", "PARTIAL", "UNPAID"])
        : daysSinceIssue > 20
          ? pick(["PAID", "PAID", "PARTIAL", "UNPAID", "UNPAID"])
          : pick(["PAID", "UNPAID", "UNPAID", "DRAFT"]);

    let amountPaidCents = 0;
    let status: string;

    // Only the statuses a person actually sets are stored. PARTIALLY_PAID and
    // OVERDUE are derived from the balance and the due date at read time, so
    // writing them here would just go stale.
    if (settlement === "DRAFT") {
      status = "DRAFT";
    } else if (settlement === "PAID") {
      amountPaidCents = totals.totalCents;
      status = "PAID";
    } else if (settlement === "PARTIAL") {
      amountPaidCents = Math.round(totals.totalCents * pick([0.25, 0.4, 0.5, 0.6]));
      status = chance(0.5) ? "VIEWED" : "SENT";
    } else {
      status = chance(0.5) ? "VIEWED" : "SENT";
    }

    const invoice = await prisma.invoice.create({
      data: {
        organizationId: org.id,
        number: `${org.invoicePrefix}${invoiceNumber++}`,
        title: job.service.name,
        status,
        clientId: job.clientId,
        addressId: job.addressId,
        jobId: job.id,
        issueDate,
        dueDate,
        paymentTermsDays: org.defaultPaymentTermsDays,
        sentAt: status === "DRAFT" ? null : addDays(issueDate, 0),
        viewedAt:
          status === "VIEWED" || status === "PAID"
            ? addDays(issueDate, 1)
            : null,
        paidAt:
          status === "PAID"
            ? noLaterThanNow(addDays(issueDate, int(2, 28)))
            : null,
        subtotalCents: totals.subtotalCents,
        discountType: "NONE",
        discountValue: 0,
        discountCents: 0,
        taxRateBp,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        amountPaidCents,
        balanceCents: totals.totalCents - amountPaidCents,
        notes: null,
        terms: org.invoiceFooter,
        createdById: pick([manager.id, staff[1].id]),
        createdAt: issueDate,
        lineItems: {
          create: lineItems.map((li, i) => ({
            kind: li.kind,
            name: li.name,
            description: li.description,
            quantity: li.quantity,
            unit: li.unit,
            unitPriceCents: li.unitPriceCents,
            taxable: li.taxable,
            totalCents: totals.lineTotalsCents[i],
            sortOrder: i,
          })),
        },
      },
    });

    if (amountPaidCents > 0) {
      // A settled invoice is sometimes paid in two instalments.
      const instalments =
        status === "PAID" && chance(0.2)
          ? [Math.round(amountPaidCents / 2), amountPaidCents - Math.round(amountPaidCents / 2)]
          : [amountPaidCents];

      for (let i = 0; i < instalments.length; i++) {
        await prisma.payment.create({
          data: {
            organizationId: org.id,
            invoiceId: invoice.id,
            clientId: job.clientId,
            amountCents: instalments[i],
            method: pick(["CARD", "CARD", "CHECK", "BANK_TRANSFER", "CASH", "ONLINE"]),
            receivedAt: noLaterThanNow(addDays(issueDate, int(2, 25) + i * 12)),
            reference: chance(0.4) ? `REF${int(100000, 999999)}` : null,
            recordedById: pick([owner.id, manager.id, staff[1].id]),
          },
        });
        paymentCount++;
      }
    }
  }

  console.log(`  ${invoiceNumber - org.invoiceNextNumber} invoices, ${paymentCount} payments`);

  // ------------------------------------------------------------ expenses ---

  // Two kinds, because they answer different questions: job costs make a
  // margin real, and overhead is what the margin has to cover.
  const JOB_COSTS = [
    { description: "Materials from the supply house", category: "MATERIALS", vendor: "Ferguson Supply", min: 4_000, max: 62_000 },
    { description: "Equipment rental", category: "EQUIPMENT", vendor: "United Rentals", min: 8_000, max: 34_000 },
    { description: "Permit fee", category: "PERMITS", vendor: "County Building Dept", min: 5_000, max: 18_000 },
    { description: "Subcontracted labor", category: "SUBCONTRACTOR", vendor: "Ridgeway Trades", min: 25_000, max: 140_000 },
  ] as const;

  const OVERHEAD = [
    { description: "Fuel", category: "FUEL", vendor: "Shell", min: 4_500, max: 12_500 },
    { description: "Van service and tyres", category: "VEHICLE", vendor: "Kwik Fit", min: 18_000, max: 74_000 },
    { description: "Replacement hand tools", category: "TOOLS", vendor: "Home Depot", min: 3_000, max: 26_000 },
    { description: "General liability insurance", category: "INSURANCE", vendor: "Travelers", min: 42_000, max: 42_000 },
    { description: "Office supplies", category: "OFFICE", vendor: "Staples", min: 1_800, max: 9_000 },
    { description: "Software subscriptions", category: "SOFTWARE", vendor: "Matlock Software", min: 4_900, max: 4_900 },
    { description: "Local sponsored listing", category: "MARKETING", vendor: "Google Ads", min: 12_000, max: 48_000 },
    { description: "Crew lunch on site", category: "MEALS", vendor: "Corner Deli", min: 1_200, max: 6_400 },
    { description: "Shop utilities", category: "UTILITIES", vendor: "Duke Energy", min: 14_000, max: 32_000 },
  ] as const;

  let expenseCount = 0;

  async function recordExpense(
    template: (typeof JOB_COSTS)[number] | (typeof OVERHEAD)[number],
    spentAt: Date,
    link: { jobId?: string; clientId?: string } = {},
  ) {
    const amountCents = int(template.min, template.max);
    // A tax-inclusive receipt total, which is what people actually type in.
    const taxCents = chance(0.75)
      ? Math.round((amountCents * org.defaultTaxRateBp) / (10_000 + org.defaultTaxRateBp))
      : 0;

    // Field staff buy things on their own card and want it back.
    const paidByTech = chance(0.25);
    const paidBy = paidByTech ? pick(technicians) : pick([owner, manager]);

    await prisma.expense.create({
      data: {
        organizationId: org.id,
        description: template.description,
        category: template.category,
        vendor: template.vendor,
        amountCents,
        taxCents,
        method: paidByTech
          ? pick(["CARD", "CASH"])
          : pick(["CARD", "CARD", "BANK_TRANSFER", "CHECK"]),
        reference: chance(0.35) ? `#${int(10000, 99999)}` : null,
        spentAt: noLaterThanNow(spentAt),
        billable: Boolean(link.jobId) && chance(0.4),
        reimbursable: paidByTech,
        reimbursedAt: paidByTech && chance(0.6) ? noLaterThanNow(addDays(spentAt, int(3, 20))) : null,
        paidById: paidBy.id,
        createdById: pick([owner.id, manager.id]),
        ...link,
      },
    });

    expenseCount++;
  }

  for (const job of completedJobs) {
    if (!chance(0.7)) continue;
    for (const template of JOB_COSTS.filter(() => chance(0.35))) {
      await recordExpense(template, addDays(job.completedAt, -int(0, 2)), {
        jobId: job.id,
        clientId: job.clientId,
      });
    }
  }

  for (let daysAgo = 180; daysAgo >= 0; daysAgo -= int(2, 6)) {
    await recordExpense(pick(OVERHEAD), dayAt(-daysAgo, int(8, 17), int(0, 59)));
  }

  console.log(`  ${expenseCount} expenses`);

  // ------------------------------------------- notifications and outbox ---

  const upcomingJobs = await prisma.job.findMany({
    where: { organizationId: org.id, status: { in: ["SCHEDULED", "CONFIRMED"] } },
    orderBy: { scheduledStart: "asc" },
    take: 6,
    include: { client: true, assignments: true },
  });

  for (const job of upcomingJobs) {
    for (const assignment of job.assignments) {
      await prisma.notification.create({
        data: {
          organizationId: org.id,
          userId: assignment.userId,
          type: "JOB_ASSIGNED",
          title: `Assigned: ${job.title}`,
          body: `${job.client?.displayName ?? "Client"} — ${job.scheduledStart?.toLocaleString("en-US") ?? "unscheduled"}`,
          entityType: "job",
          entityId: job.id,
          actionUrl: `/jobs/${job.id}`,
          readAt: chance(0.4) ? new Date() : null,
          createdAt: addDays(job.scheduledStart ?? new Date(), -2),
        },
      });
    }
  }

  const sentInvoices = await prisma.invoice.findMany({
    where: { organizationId: org.id, status: { in: ["SENT", "VIEWED", "OVERDUE"] } },
    include: { client: true },
    take: 10,
  });

  for (const invoice of sentInvoices) {
    await prisma.outboxMessage.create({
      data: {
        organizationId: org.id,
        channel: "EMAIL",
        toAddress: invoice.client.email ?? "client@example.test",
        toName: invoice.client.displayName,
        subject: `Invoice ${invoice.number} from ${org.name}`,
        body: `Hi ${invoice.client.displayName},\n\nYour invoice ${invoice.number} for ${(invoice.totalCents / 100).toFixed(2)} is ready. Payment is due ${invoice.dueDate?.toDateString() ?? "on receipt"}.\n\nThank you,\n${org.name}`,
        status: "SENT",
        sentAt: invoice.sentAt ?? invoice.issueDate,
        provider: "stub",
        relatedType: "invoice",
        relatedId: invoice.id,
        createdById: manager.id,
        createdAt: invoice.sentAt ?? invoice.issueDate,
      },
    });
  }

  // ------------------------------------------------------------ messages ---

  // A morning's worth of the office and the crew talking, so the inbox opens
  // on something. Times are counted back from now rather than pinned to a
  // clock, so the order holds whenever the seed runs. The owner is left with
  // a little unread in the crew thread and the technician with the owner's
  // last reply, so both demo logins show a badge.
  const [admin, tech1, tech2] = [staff[1], technicians[0], technicians[1]];
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  // A job on the go today gets its own conversation: the crew on it and the
  // service manager, the way the office and a van actually talk about work.
  const liveJob = await prisma.job.findFirst({
    where: { organizationId: org.id, status: "IN_PROGRESS", assignments: { some: {} } },
    orderBy: { scheduledStart: "desc" },
    select: { id: true, assignments: { select: { userId: true }, orderBy: { assignedAt: "asc" } } },
  });
  const onSite = liveJob?.assignments[0]?.userId;

  const threads: {
    kind: "DIRECT" | "GROUP" | "JOB";
    title?: string;
    jobId?: string;
    members: string[];
    lines: [author: string, minutesAgo: number, body: string][];
    /** Per member: the minute they last read up to. Absent means all of it. */
    readTo?: Record<string, number | null>;
  }[] = [
    {
      kind: "GROUP",
      title: "Northside crew",
      members: [owner.id, manager.id, tech1.id, tech2.id],
      lines: [
        [manager.id, 190, "Morning. Tom, the 9:30 in Brookfield moved to 11 — the customer is running late."],
        [tech2.id, 186, "Got it. I'll stop at the supply house for filters first."],
        [tech1.id, 150, "Can someone bring the spare condensate pump? Mine is still at the shop."],
        [tech2.id, 147, "I have one in the van. Meet you at the Oakridge job around 1?"],
        [tech1.id, 146, "Perfect, thanks."],
        [manager.id, 35, "Reminder: timesheets in by Friday noon, please."],
        [tech1.id, 12, "Oakridge is done. Photos are on the job — the drain line had a crack, replaced 4 ft of it."],
      ],
      readTo: { [owner.id]: 146, [manager.id]: 35 },
    },
    {
      kind: "DIRECT",
      members: [owner.id, tech1.id],
      lines: [
        [tech1.id, 1500, "Finished the Hendricks furnace. The heat exchanger is cracked — I tagged it and left the unit off."],
        [owner.id, 1492, "Good call. Did you talk to them about a replacement?"],
        [tech1.id, 1488, "Mrs. Hendricks wants a quote by Friday. Can the office put one together?"],
        [owner.id, 64, "Dana has it. Thanks for flagging it on site instead of leaving it for the next visit."],
      ],
      readTo: { [tech1.id]: 1488 },
    },
    {
      kind: "DIRECT",
      members: [owner.id, admin.id],
      lines: [
        [admin.id, 2900, "The Parkview property manager called — they want all six units serviced before the first cold snap."],
        [owner.id, 2880, "Let's do it. Spread it over two days so we're not tying up the whole crew."],
        [admin.id, 2860, "Booked for next Tuesday and Wednesday. The estimate goes out today."],
      ],
    },
    ...(liveJob && onSite
      ? [
          {
            kind: "JOB" as const,
            jobId: liveJob.id,
            members: [...new Set([manager.id, ...liveJob.assignments.map((a) => a.userId)])],
            lines: [
              [manager.id, 95, "Customer says the unit trips the breaker when the compressor kicks on."] as [string, number, string],
              [onSite, 40, "On site. Capacitor is swollen — swapping it now, I have one on the van."] as [string, number, string],
              [manager.id, 37, "Great. Check the contactor while you're in there."] as [string, number, string],
              [onSite, 8, "Contactor looks fine. Running clean for 20 minutes, no trips."] as [string, number, string],
            ],
            readTo: { [manager.id]: 37 },
          },
        ]
      : []),
  ];

  for (const thread of threads) {
    const last = Math.min(...thread.lines.map(([, minutes]) => minutes));
    const conversation = await prisma.conversation.create({
      data: {
        organizationId: org.id,
        kind: thread.kind,
        title: thread.title ?? null,
        directKey:
          thread.kind === "DIRECT" ? [...thread.members].sort().join(":") : null,
        jobId: thread.jobId ?? null,
        createdById: thread.lines[0][0],
        lastMessageAt: minutesAgo(last),
        createdAt: minutesAgo(Math.max(...thread.lines.map(([, minutes]) => minutes)) + 1),
        members: {
          create: thread.members.map((userId) => {
            const readTo = thread.readTo?.[userId];
            return {
              userId,
              lastReadAt: readTo === undefined ? minutesAgo(last) : readTo === null ? null : minutesAgo(readTo),
            };
          }),
        },
      },
    });

    await prisma.message.createMany({
      data: thread.lines.map(([authorId, minutes, body]) => ({
        organizationId: org.id,
        conversationId: conversation.id,
        authorId,
        body,
        createdAt: minutesAgo(minutes),
      })),
    });
  }

  console.log(`  ${threads.length} team conversations`);

  // ===================================================== the newer features ---
  //
  // Everything below came with the release that added signatures, deposits,
  // checklists, repeating bills on the calendar, the customer portal, the
  // request form, customer emails and the day clock. It runs after the rest
  // so the workspace above — and the figures the marketing screens were taken
  // from — come out exactly as before.

  const money = (cents: number) => formatMoney(cents, org.currency, org.locale);
  const noon = (date: Date) => {
    const at = new Date(date);
    at.setHours(12, 0, 0, 0);
    return at;
  };
  const sinceNow = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const office = [owner, staff[1], manager];

  // ------------------------------------- signatures, deposits, progress ---

  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const estimateLabel = (number: string) => `${org.labelEstimateSingular} ${number}`;

  type BillingLine = {
    kind: string;
    name: string;
    description: string | null;
    quantity: number;
    unit: string;
    unitPriceCents: number;
    taxable: boolean;
  };

  /** A quote with a deposit asked for, signed online or still out for an answer. */
  async function quoteWithDeposit(input: {
    client: (typeof clients)[number];
    title: string;
    lines: BillingLine[];
    deposit: { type: "PERCENT" | "FIXED"; value: number };
    issued: Date;
    signedAt: Date | null;
  }) {
    const totals = computeTotals({
      lineItems: input.lines.map((line) => ({
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        taxable: line.taxable,
      })),
      discountType: "NONE",
      discountValue: 0,
      taxRateBp: org.defaultTaxRateBp,
    });
    const number = `${org.estimatePrefix}${estimateNumber++}`;
    const depositCents = depositCentsFor(totals.totalCents, input.deposit.type, input.deposit.value);
    const signer = input.client.isBusiness ? input.client.contactName : input.client.displayName;

    const lineRows = input.lines.map((line, i) => ({ ...line, totalCents: totals.lineTotalsCents[i], sortOrder: i }));
    const signed = input.signedAt
      ? signedSnapshot({
          number,
          title: input.title,
          issueDate: input.issued,
          expiresAt: addDays(input.issued, org.defaultEstimateValidDays),
          subtotalCents: totals.subtotalCents,
          discountCents: 0,
          taxRateBp: org.defaultTaxRateBp,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
          depositCents,
          notes: null,
          terms: org.estimateFooter,
          lineItems: lineRows,
        })
      : null;

    const estimate = await prisma.estimate.create({
      data: {
        organizationId: org.id,
        number,
        title: input.title,
        status: input.signedAt ? "ACCEPTED" : "VIEWED",
        clientId: input.client.id,
        addressId: input.client.addressId,
        issueDate: input.issued,
        expiresAt: addDays(input.issued, org.defaultEstimateValidDays),
        sentAt: addMinutes(input.issued, 30),
        viewedAt: addDays(input.issued, 1),
        acceptedAt: input.signedAt,
        subtotalCents: totals.subtotalCents,
        discountType: "NONE",
        discountValue: 0,
        discountCents: 0,
        taxRateBp: org.defaultTaxRateBp,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        depositType: input.deposit.type,
        depositValue: input.deposit.value,
        depositCents,
        terms: org.estimateFooter,
        createdById: manager.id,
        createdAt: input.issued,
        ...(signed && input.signedAt
          ? {
              signedName: signer,
              signedAt: input.signedAt,
              signedIp: "203.0.113.24",
              signedUserAgent: IPHONE,
              signedSnapshot: signed,
              signedHash: snapshotHash(signed),
            }
          : {}),
        lineItems: { create: lineRows },
      },
    });

    return { estimate, totals, depositCents, signer };
  }

  /** One stage's invoice, as the Billing card on an estimate makes it. */
  async function stageInvoice(input: {
    estimate: { id: string; number: string; clientId: string; addressId: string | null; totalCents: number };
    jobId: string | null;
    stage: "DEPOSIT" | "PROGRESS";
    amountCents: number;
    priorCents: number;
    issued: Date;
    paidAt: Date | null;
  }) {
    const label = estimateLabel(input.estimate.number);
    const share = Math.round((input.amountCents / input.estimate.totalCents) * 1000) / 10;
    const name = input.stage === "DEPOSIT" ? `Deposit — ${share}% of ${label}` : `Progress billing — ${share}% of ${label}`;
    const dueDate = new Date(input.issued);
    if (input.stage === "DEPOSIT") dueDate.setHours(23, 59, 0, 0);
    else dueDate.setTime(addDays(input.issued, org.defaultPaymentTermsDays).getTime());

    const invoice = await prisma.invoice.create({
      data: {
        organizationId: org.id,
        number: `${org.invoicePrefix}${invoiceNumber++}`,
        title: name,
        status: input.paidAt ? "PAID" : "SENT",
        clientId: input.estimate.clientId,
        addressId: input.estimate.addressId,
        jobId: input.jobId,
        estimateId: input.estimate.id,
        billingStage: input.stage,
        issueDate: input.issued,
        dueDate,
        paymentTermsDays: input.stage === "DEPOSIT" ? 0 : org.defaultPaymentTermsDays,
        sentAt: input.issued,
        viewedAt: input.paidAt ? addMinutes(input.issued, 20) : null,
        paidAt: input.paidAt,
        subtotalCents: input.amountCents,
        taxRateBp: 0,
        taxCents: 0,
        totalCents: input.amountCents,
        amountPaidCents: input.paidAt ? input.amountCents : 0,
        balanceCents: input.paidAt ? 0 : input.amountCents,
        terms: org.invoiceFooter,
        createdById: input.stage === "DEPOSIT" ? null : manager.id,
        createdAt: input.issued,
        lineItems: {
          create: [
            {
              kind: "OTHER",
              name,
              description: `${money(input.estimate.totalCents)} in all; ${money(input.priorCents)} billed before this.`,
              quantity: 1,
              unit: "ea",
              unitPriceCents: input.amountCents,
              taxable: false,
              totalCents: input.amountCents,
              sortOrder: 0,
            },
          ],
        },
      },
    });

    if (input.paidAt) {
      await prisma.payment.create({
        data: {
          organizationId: org.id,
          invoiceId: invoice.id,
          clientId: input.estimate.clientId,
          amountCents: input.amountCents,
          method: "ONLINE",
          receivedAt: input.paidAt,
          reference: "Paid online",
          recordedById: null,
        },
      });
      paymentCount++;
    }
    return invoice;
  }

  // A repipe: signed three weeks ago, deposit paid, under way, 40% billed.
  const repipeClient = clients[3 % clients.length];
  const repipe = await quoteWithDeposit({
    client: repipeClient,
    title: "Whole-house repipe",
    lines: [
      { kind: "SERVICE", name: "Whole-house repipe, PEX supply lines", description: "Kitchen, two baths, laundry and both hose bibs. Old galvanized lines capped and left in the walls.", quantity: 1, unit: "job", unitPriceCents: 620_000, taxable: false },
      { kind: "MATERIAL", name: "PEX pipe, fittings and manifold", description: null, quantity: 1, unit: "lot", unitPriceCents: 148_000, taxable: true },
      { kind: "LABOR", name: "Drywall patch and paint at access points", description: null, quantity: 6, unit: "ea", unitPriceCents: 9_500, taxable: false },
    ],
    deposit: { type: "PERCENT", value: 3_000 },
    issued: dayAt(-24, 10),
    signedAt: dayAt(-21, 19, 42),
  });
  const repipeJob = await prisma.job.create({
    data: {
      organizationId: org.id,
      number: `${org.jobPrefix}${jobNumber++}`,
      kind: "JOB",
      title: "Whole-house repipe",
      description: "Booked from the signed estimate. Three days on site; water off 9–3 each day.",
      clientId: repipeClient.id,
      addressId: repipeClient.addressId,
      status: "IN_PROGRESS",
      priority: "NORMAL",
      scheduledStart: dayAt(-1, 8),
      scheduledEnd: dayAt(-1, 16),
      estimatedMinutes: 480,
      startedAt: dayAt(-1, 8, 10),
      createdById: manager.id,
      createdAt: dayAt(-20, 9),
      assignments: {
        create: [
          { userId: technicians[0].id, isLead: true },
          { userId: technicians[2 % technicians.length].id, isLead: false },
        ],
      },
    },
  });
  await prisma.estimate.update({ where: { id: repipe.estimate.id }, data: { convertedJobId: repipeJob.id } });
  await stageInvoice({
    estimate: { ...repipe.estimate, addressId: repipe.estimate.addressId },
    jobId: repipeJob.id,
    stage: "DEPOSIT",
    amountCents: repipe.depositCents,
    priorCents: 0,
    issued: dayAt(-21, 19, 42),
    paidAt: dayAt(-21, 20, 5),
  });
  await stageInvoice({
    estimate: { ...repipe.estimate, addressId: repipe.estimate.addressId },
    jobId: repipeJob.id,
    stage: "PROGRESS",
    amountCents: Math.round(repipe.totals.totalCents * 0.4),
    priorCents: repipe.depositCents,
    issued: noLaterThanNow(dayAt(0, 8, 15)),
    paidAt: null,
  });

  // A water heater: signed this morning, the deposit invoice waiting on them.
  const heaterClient = clients[7 % clients.length];
  const heaterSigned = noLaterThanNow(dayAt(0, 7, 48));
  const heater = await quoteWithDeposit({
    client: heaterClient,
    title: "Tankless water heater install",
    lines: [
      { kind: "MATERIAL", name: "Navien NPE-240A2 tankless water heater", description: "Condensing, 199,000 BTU. 15-year heat exchanger warranty.", quantity: 1, unit: "ea", unitPriceCents: 189_500, taxable: true },
      { kind: "SERVICE", name: "Remove tank, install tankless, gas and venting", description: null, quantity: 1, unit: "job", unitPriceCents: 165_000, taxable: false },
      { kind: "MATERIAL", name: "Venting kit and isolation valves", description: null, quantity: 1, unit: "kit", unitPriceCents: 38_500, taxable: true },
    ],
    deposit: { type: "FIXED", value: 100_000 },
    issued: dayAt(-4, 15),
    signedAt: heaterSigned,
  });
  await stageInvoice({
    estimate: { ...heater.estimate, addressId: heater.estimate.addressId },
    jobId: null,
    stage: "DEPOSIT",
    amountCents: heater.depositCents,
    priorCents: 0,
    issued: heaterSigned,
    paidAt: null,
  });

  // A sewer line: out for an answer, half down on accepting.
  await quoteWithDeposit({
    client: clients[11 % clients.length],
    title: "Sewer line camera inspection and spot repair",
    lines: [
      { kind: "SERVICE", name: "Camera inspection of the main sewer line", description: "Recorded video and a marked-up locate.", quantity: 1, unit: "ea", unitPriceCents: 32_500, taxable: false },
      { kind: "SERVICE", name: "Excavate and replace damaged section", description: "Up to 6 feet of 4\" PVC, including backfill.", quantity: 1, unit: "job", unitPriceCents: 285_000, taxable: false },
      { kind: "MATERIAL", name: "4\" PVC, couplings and bedding stone", description: null, quantity: 1, unit: "lot", unitPriceCents: 22_000, taxable: true },
    ],
    deposit: { type: "PERCENT", value: 5_000 },
    issued: dayAt(-2, 11),
    signedAt: null,
  });

  await prisma.notification.create({
    data: {
      organizationId: org.id,
      userId: manager.id,
      type: "ESTIMATE_RESPONSE",
      title: `${heaterClient.displayName} accepted estimate ${heater.estimate.number}`,
      body: `Signed by ${heater.signer}. Their deposit invoice is ready for them to pay.`,
      entityType: "ESTIMATE",
      entityId: heater.estimate.id,
      actionUrl: `/estimates/${heater.estimate.id}`,
      createdAt: heaterSigned,
    },
  });

  console.log("  3 estimates with deposits (2 signed online, 1 in progress billing)");

  // ---------------------------------------------------------- checklists ---

  // Saved lists, and copies of them on the work either side of today: all
  // ticked on finished work, part-way on work under way, waiting on what is
  // booked. One finished job closed with a step still open — the app tracks
  // checklists, it never holds a job up over one.
  const WRAP_UP = [
    "Before photos taken",
    "Work done as quoted",
    "After photos taken",
    "Site cleaned up, debris hauled off",
    "Walked the customer through the work",
  ];
  const ESTIMATE_VISIT = [
    "Measure and photograph the work area",
    "Note access, parking and shut-offs",
    "Talk through options and budget",
    "Say when the estimate will arrive",
  ];
  await prisma.checklistTemplate.createMany({
    data: [
      { organizationId: org.id, name: "Job wrap-up", items: JSON.stringify(WRAP_UP), kind: "JOB" },
      { organizationId: org.id, name: "Estimate visit", items: JSON.stringify(ESTIMATE_VISIT), kind: "APPOINTMENT" },
      {
        organizationId: org.id,
        name: "HVAC service visit",
        items: JSON.stringify([
          "Replace or clean the filter",
          "Check refrigerant pressures",
          "Clean the condenser coil",
          "Test the thermostat",
          "Flush the condensate drain",
        ]),
      },
    ],
  });

  const nearbyWork = await prisma.job.findMany({
    where: {
      organizationId: org.id,
      status: { not: "CANCELLED" },
      scheduledStart: { gte: dayAt(-10, 0), lte: dayAt(14, 23, 59) },
    },
    orderBy: { scheduledStart: "asc" },
    select: {
      id: true,
      kind: true,
      status: true,
      startedAt: true,
      completedAt: true,
      assignments: { orderBy: { isLead: "desc" }, take: 1, select: { userId: true } },
    },
  });

  let checklistItems = 0;
  let leftOneOpen = false;
  for (const job of nearbyWork) {
    const labels = job.kind === "APPOINTMENT" ? ESTIMATE_VISIT : WRAP_UP;
    const keepOneOpen = job.status === "COMPLETED" && job.kind !== "APPOINTMENT" && !leftOneOpen;
    if (keepOneOpen) leftOneOpen = true;
    const ticked =
      job.status === "COMPLETED" ? labels.length - (keepOneOpen ? 1 : 0) : job.status === "IN_PROGRESS" ? 2 : 0;
    const by = job.assignments[0]?.userId ?? null;

    await prisma.jobChecklistItem.createMany({
      data: labels.map((label, i) => {
        const at =
          i >= ticked
            ? null
            : job.completedAt
              ? addMinutes(job.completedAt, -(labels.length - i) * 12)
              : job.startedAt
                ? noLaterThanNow(addMinutes(job.startedAt, (i + 1) * 20))
                : null;
        return {
          organizationId: org.id,
          jobId: job.id,
          label,
          sortOrder: i,
          doneAt: at,
          doneById: at ? by : null,
        };
      }),
    });
    checklistItems += labels.length;
  }

  console.log(`  3 saved checklists, ${checklistItems} checklist items on ${nearbyWork.length} jobs`);

  // ----------------------------------------------------- repeating bills ---

  // The bills that come round again, each with its history, so they show on
  // the calendar on their dates — paid, coming, and one waiting for the
  // amount. The electric bill changes every month, so its latest period is a
  // reminder to enter it rather than a guess.
  const today = noon(new Date());
  const firstOfNextMonth = noon(new Date(today.getFullYear(), today.getMonth() + 1, 1));

  const BILLS = [
    { description: "Shop rent", category: "OTHER", vendor: "Beaumont Properties", method: "BANK_TRANSFER", frequency: "MONTHLY", next: firstOfNextMonth, history: [240_000, 240_000, 240_000, 240_000, 240_000, 240_000] },
    { description: "Van lease", category: "VEHICLE", vendor: "Enterprise Fleet", method: "CARD", frequency: "MONTHLY", next: addDays(today, 9), history: [68_900, 68_900, 68_900, 68_900, 68_900, 68_900] },
    { description: "Business phone and internet", category: "UTILITIES", vendor: "Spectrum Business", method: "CARD", frequency: "MONTHLY", next: addDays(today, 16), history: [18_999, 18_999, 18_999, 18_999, 17_999, 17_999] },
    { description: "Uniform service", category: "OTHER", vendor: "Cintas", method: "CARD", frequency: "WEEKLY", next: addDays(today, 3), history: [3_850, 3_850, 3_850, 3_850, 3_850, 3_850, 3_850, 3_850] },
  ] as const;

  const stepBack = (date: Date, frequency: string, periods: number) =>
    frequency === "WEEKLY" ? addDays(date, -7 * periods) : noon(subMonths(date, periods));

  let billExpenses = 0;
  for (const bill of BILLS) {
    const schedule = await prisma.expenseSchedule.create({
      data: {
        organizationId: org.id,
        frequency: bill.frequency,
        interval: 1,
        anchorDate: bill.next,
        nextDate: bill.next,
        amountVaries: false,
        lastRunAt: stepBack(bill.next, bill.frequency, 1),
        createdById: owner.id,
      },
    });
    // Oldest first, so the latest in the series is the one the next copies.
    for (let i = bill.history.length; i >= 1; i--) {
      await prisma.expense.create({
        data: {
          organizationId: org.id,
          scheduleId: schedule.id,
          description: bill.description,
          category: bill.category,
          vendor: bill.vendor,
          amountCents: bill.history[bill.history.length - i],
          method: bill.method,
          spentAt: stepBack(bill.next, bill.frequency, i),
          paidById: owner.id,
          createdById: owner.id,
        },
      });
      billExpenses++;
    }
  }

  // The electric bill: its date was two days ago and the amount varies, so it
  // is waiting for somebody to enter it.
  const electricDue = addDays(today, -2);
  const electric = await prisma.expenseSchedule.create({
    data: {
      organizationId: org.id,
      frequency: "MONTHLY",
      interval: 1,
      anchorDate: electricDue,
      nextDate: noon(addMonths(electricDue, 1)),
      amountVaries: true,
      lastRunAt: electricDue,
      createdById: owner.id,
    },
  });
  const ELECTRIC = [21_840, 24_310, 27_960, 26_120, 22_450];
  for (let i = ELECTRIC.length; i >= 1; i--) {
    await prisma.expense.create({
      data: {
        organizationId: org.id,
        scheduleId: electric.id,
        description: "Shop electric",
        category: "UTILITIES",
        vendor: "Duke Energy",
        amountCents: ELECTRIC[ELECTRIC.length - i],
        method: "BANK_TRANSFER",
        spentAt: noon(subMonths(electricDue, i)),
        paidById: owner.id,
        createdById: owner.id,
      },
    });
    billExpenses++;
  }
  const electricDueBy = new Date(electricDue);
  electricDueBy.setHours(23, 59, 59, 0);
  await prisma.task.create({
    data: {
      organizationId: org.id,
      title: `Enter Shop electric for ${format(electricDue, "MMM d")}`,
      notes: `Last time: ${money(ELECTRIC[ELECTRIC.length - 1])} to Duke Energy.`,
      status: "OPEN",
      dueAt: electricDueBy,
      assignedToId: owner.id,
      expenseScheduleId: electric.id,
      createdAt: electricDue,
    },
  });
  await prisma.notification.create({
    data: {
      organizationId: org.id,
      userId: owner.id,
      type: "EXPENSE_DUE",
      title: "Time to enter Shop electric",
      body: `Due ${format(electricDue, "MMM d")}. Last time it was ${money(ELECTRIC[ELECTRIC.length - 1])}.`,
      entityType: "expense",
      actionUrl: `/expenses/new?repeat=${electric.id}&date=${format(electricDue, "yyyy-MM-dd")}`,
      createdAt: addMinutes(electricDue, -5 * 60),
    },
  });

  console.log(`  ${BILLS.length + 1} repeating bills (${billExpenses} past payments, 1 waiting to be entered)`);

  // ----------------------------------------- customer portal and requests ---

  // Every customer has their private page, as they would once any estimate or
  // invoice email had gone to them.
  for (const client of clients) {
    await prisma.client.update({
      where: { id: client.id },
      data: { portalToken: randomBytes(24).toString("base64url") },
    });
  }

  const portalClient = clients[5 % clients.length];
  const REQUESTS = [
    {
      name: "Rosa Delgado",
      email: "rosa.delgado@example.test",
      phone: "9195557712",
      client: null,
      minutesAgo: 95,
      lines: [
        "Requested on the website form.",
        "Service: Water heater repair",
        "Where: 88 Larkspur Ln, Millbrook, NC 27502",
        `Preferred: ${format(addDays(today, 1), "yyyy-MM-dd")}, morning`,
        "",
        "No hot water since this morning. 50-gallon gas heater, about 12 years old, and there's water pooling around the base.",
      ],
    },
    {
      name: portalClient.isBusiness ? portalClient.contactName : portalClient.displayName,
      email: portalClient.email,
      phone: portalClient.phone,
      client: portalClient,
      minutesAgo: 5 * 60,
      lines: [
        `Requested from ${portalClient.displayName}'s portal.`,
        "Service: Furnace tune-up",
        "Preferred: afternoon",
        "",
        "Time for the yearly tune-up before it gets cold. Any weekday after 3pm works.",
      ],
    },
    {
      name: "Ken Whitaker",
      email: "ken.whitaker@example.test",
      phone: null,
      client: null,
      minutesAgo: 27 * 60,
      lines: [
        "Requested on the website form.",
        "Service: Drain cleaning",
        "",
        "Kitchen sink drains slowly and gurgles whenever the dishwasher runs.",
      ],
    },
  ];

  for (const [i, request] of REQUESTS.entries()) {
    const createdAt = sinceNow(request.minutesAgo);
    const lead = await prisma.lead.create({
      data: {
        organizationId: org.id,
        name: request.name,
        email: request.email,
        phone: request.phone,
        source: request.client ? "REPEAT" : "WEBSITE",
        status: "NEW",
        clientId: request.client?.id ?? null,
        createdAt,
        notes: {
          create: { organizationId: org.id, body: request.lines.join("\n"), visibility: "INTERNAL", createdAt },
        },
      },
    });
    for (const person of office) {
      await prisma.notification.create({
        data: {
          organizationId: org.id,
          userId: person.id,
          type: "SERVICE_REQUEST",
          title: `New request from ${request.name}`,
          body: request.lines[request.lines.length - 1].slice(0, 160),
          entityType: "LEAD",
          entityId: lead.id,
          actionUrl: `/leads/${lead.id}`,
          // The newest is still unread.
          readAt: i === 0 ? null : addMinutes(createdAt, 40),
          createdAt,
        },
      });
    }
  }

  console.log(`  ${clients.length} customer portals, ${REQUESTS.length} service requests`);

  // --------------------------------------------------------- automations ---

  // A few switched on, with what they have done: chasing late invoices with a
  // task, and three that write to customers — reminders the day before a
  // visit, a nudge on overdue invoices, and the review request.
  await prisma.organization.update({
    where: { id: org.id },
    data: { reviewUrl: "https://northsidehome.test/review" },
  });

  const automation = async (templateId: string, days: number) =>
    prisma.workflow.create({
      data: {
        organizationId: org.id,
        templateId,
        isActive: true,
        config: JSON.stringify({ days }),
        lastRunAt: noLaterThanNow(dayAt(0, 6, 0)),
        createdById: owner.id,
      },
    });
  await automation("overdue.chase", 7);
  const reminders = await automation("appointment.reminder.email", 1);
  const overdue = await automation("invoice.overdue.email", 7);
  const reviews = await automation("review.request.email", 2);

  const signOff = (lines: string[], name: string) =>
    [
      `Hi ${name},`,
      "",
      ...lines,
      "",
      `Any questions, just reply or reach us on (919) 555-0142 or ${org.email}.`,
      "",
      "Thank you,",
      org.name,
    ].join("\n");

  async function emailed(input: {
    workflowId: string;
    entity: { type: string; id: string };
    to: { email: string | null; name: string };
    subject: string;
    lines: string[];
    related: { type: string; id: string };
    at: Date;
  }) {
    if (!input.to.email) return 0;
    await prisma.workflowRun.create({
      data: {
        workflowId: input.workflowId,
        organizationId: org.id,
        entityType: input.entity.type,
        entityId: input.entity.id,
        summary: `Emailed ${input.to.name}: ${input.subject}`.slice(0, 200),
        createdAt: input.at,
      },
    });
    await prisma.outboxMessage.create({
      data: {
        organizationId: org.id,
        channel: "EMAIL",
        toAddress: input.to.email,
        toName: input.to.name,
        subject: input.subject,
        body: signOff(input.lines, input.to.name),
        status: "SENT",
        sentAt: input.at,
        provider: "stub",
        relatedType: input.related.type,
        relatedId: input.related.id,
        createdAt: input.at,
      },
    });
    return 1;
  }

  let customerEmails = 0;
  const thisMorning = noLaterThanNow(dayAt(0, 6, 0));

  const tomorrowsVisits = await prisma.job.findMany({
    where: {
      organizationId: org.id,
      status: { in: ["SCHEDULED", "CONFIRMED"] },
      scheduledStart: { gte: dayAt(1, 0), lt: dayAt(2, 0) },
      clientId: { not: null },
    },
    include: { client: true, address: true },
  });
  for (const job of tomorrowsVisits) {
    const when = format(job.scheduledStart!, "EEEE, MMMM d");
    customerEmails += await emailed({
      workflowId: reminders.id,
      entity: { type: "JOB", id: `${job.id}@${format(job.scheduledStart!, "yyyy-MM-dd")}` },
      to: { email: job.client!.email, name: job.client!.displayName },
      subject: `Reminder: ${org.name} is booked for ${when}`,
      lines: [
        `A reminder that we're booked for ${job.title} on ${when} at ${format(job.scheduledStart!, "h:mm a")}${
          job.address ? `, at ${[job.address.line1, job.address.city].filter(Boolean).join(", ")}` : ""
        }.`,
        "Need to change it? Just let us know.",
      ],
      related: { type: "job", id: job.id },
      at: thisMorning,
    });
  }

  const lateInvoices = await prisma.invoice.findMany({
    where: {
      organizationId: org.id,
      status: { in: ["SENT", "VIEWED"] },
      balanceCents: { gt: 0 },
      dueDate: { gte: dayAt(-21, 0), lt: dayAt(-7, 0) },
    },
    include: { client: true },
    orderBy: { dueDate: "asc" },
    take: 3,
  });
  for (const invoice of lateInvoices) {
    const due = invoice.dueDate!;
    customerEmails += await emailed({
      workflowId: overdue.id,
      entity: { type: "INVOICE", id: invoice.id },
      to: { email: invoice.client.email, name: invoice.client.displayName },
      subject: `Invoice ${invoice.number} is past due`,
      lines: [
        `Invoice ${invoice.number} for ${money(invoice.balanceCents)} was due on ${format(due, "EEEE, MMMM d")} and is still open.`,
        "You can view and pay it from the link in the original email.",
        "If you've already paid, thank you — please ignore this.",
      ],
      related: { type: "invoice", id: invoice.id },
      at: noLaterThanNow(addDays(due, 7)),
    });
  }

  const recentlyFinished = await prisma.job.findMany({
    where: {
      organizationId: org.id,
      status: "COMPLETED",
      completedAt: { gte: dayAt(-14, 0), lte: dayAt(-2, 23, 59) },
      clientId: { not: null },
    },
    include: { client: true },
    orderBy: { completedAt: "desc" },
  });
  const asked = new Set<string>();
  for (const job of recentlyFinished) {
    if (asked.has(job.clientId!) || asked.size >= 4) continue;
    asked.add(job.clientId!);
    customerEmails += await emailed({
      workflowId: reviews.id,
      entity: { type: "CLIENT", id: job.clientId! },
      to: { email: job.client!.email, name: job.client!.displayName },
      subject: `Thank you from ${org.name}`,
      lines: [
        `Thank you for choosing ${org.name}.`,
        "If you have a minute, a review would mean a lot to a small business like ours: https://northsidehome.test/review",
      ],
      related: { type: "job", id: job.id },
      at: noLaterThanNow(addDays(job.completedAt!, 2)),
    });
  }

  console.log(`  4 automations on, ${customerEmails} customer emails sent by them`);

  // ---------------------------------------------------------- time clock ---

  // Two weeks of the crew's day clock, through yesterday. Today is left to
  // whoever opens My Day: a seeded "still clocked in" would read as somebody
  // who forgot, on every day after the one the seed ran.
  let clockEntries = 0;
  for (const tech of technicians) {
    for (let offset = -14; offset <= -1; offset++) {
      const weekday = dayAt(offset, 12).getDay();
      if (weekday === 0 || weekday === 6 || chance(0.08)) continue;
      await prisma.clockEntry.create({
        data: {
          organizationId: org.id,
          userId: tech.id,
          clockedInAt: dayAt(offset, 7, int(18, 52)),
          clockedOutAt: dayAt(offset, int(15, 16), int(0, 59)),
        },
      });
      clockEntries++;
    }
  }
  // One forgotten clock-out, closed by the office the next morning.
  const forgotten = await prisma.clockEntry.findFirst({
    where: { organizationId: org.id, userId: technicians[1 % technicians.length].id },
    orderBy: { clockedInAt: "desc" },
  });
  if (forgotten) {
    const fixedOut = new Date(forgotten.clockedInAt);
    fixedOut.setHours(16, 30, 0, 0);
    await prisma.clockEntry.update({
      where: { id: forgotten.id },
      data: { clockedOutAt: fixedOut, editedById: manager.id },
    });
  }

  console.log(`  ${clockEntries} days on the clock`);

  await prisma.organization.update({
    where: { id: org.id },
    data: {
      jobNextNumber: jobNumber,
      estimateNextNumber: estimateNumber,
      invoiceNextNumber: invoiceNumber,
    },
  });

  console.log("\nDone. Sign in at http://localhost:3000/login");
  console.log("  owner@demo.test    / demo1234   (full access)");
  console.log("  manager@demo.test  / demo1234   (no settings)");
  console.log("  tech1@demo.test    / demo1234   (own jobs only)");
}

/** One service line plus a few materials and labor — the shape of a real job. */
function buildLineItems(forService?: (typeof SERVICES)[number]) {
  const service = forService ?? pick(SERVICES);

  const items = [
    {
      kind: "SERVICE",
      name: service.name,
      description: null as string | null,
      quantity: 1,
      unit: "job",
      unitPriceCents: int(service.low, service.high),
      taxable: true,
    },
  ];

  const materialCount = int(0, 3);
  for (let i = 0; i < materialCount; i++) {
    const material = pick(MATERIALS);
    items.push({
      kind: "MATERIAL",
      name: material.name,
      description: null,
      quantity: int(1, 6),
      unit: material.unit,
      unitPriceCents: Math.round(material.cost * 1.4),
      taxable: true,
    });
  }

  if (chance(0.65)) {
    items.push({
      kind: "LABOR",
      name: "Standard labor",
      description: null,
      quantity: Math.max(1, Math.round(service.minutes / 60)),
      unit: "hr",
      unitPriceCents: 9_500,
      taxable: false,
    });
  }

  return items;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
