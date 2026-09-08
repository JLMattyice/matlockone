/**
 * Demo data for Matlock One.
 *
 * Deterministic: the PRNG is seeded, so `npm run db:reset` always produces the
 * same workspace. That matters for a demo you show more than once — the numbers
 * on the dashboard do not move between walkthroughs.
 *
 * Dates are generated relative to *today*, so the schedule always looks live.
 */

import path from "node:path";
import fs from "node:fs";

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { computeTotals } from "../src/lib/money";
import { hashPassword } from "../src/lib/password";

const envFile = path.join(process.cwd(), ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! }),
});

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
      primaryColor: "#0f766e",
      accentColor: "#0f172a",
      currency: "USD",
      locale: "en-US",
      timeZone: "America/New_York",
      labelJobSingular: "Job",
      labelJobPlural: "Jobs",
      labelClientSingular: "Client",
      labelClientPlural: "Clients",
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
    "QUALIFIED", "ESTIMATE_SENT", "ESTIMATE_SENT", "WON", "WON", "LOST",
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
