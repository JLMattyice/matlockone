import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { DEMO_OWNER_EMAIL, demoAvailable } from "@/lib/demo";
import { prisma } from "@/lib/db";

/**
 * Whether the demo exists decides whether the homepage offers it. The failure
 * this guards against was real: production had no demo seeded, and the
 * homepage invited every visitor to try it anyway.
 */

afterEach(async () => {
  await prisma.user.deleteMany({ where: { email: DEMO_OWNER_EMAIL } });
});

async function seedDemoOwner(isActive = true) {
  const org = await prisma.organization.create({
    data: { slug: `demo-${randomUUID()}`, name: "Northside Home Services" },
  });
  await prisma.user.create({
    data: {
      organizationId: org.id,
      email: DEMO_OWNER_EMAIL,
      name: "Alex Rivera",
      passwordHash: "x",
      role: "OWNER",
      isActive,
    },
  });
}

describe("demoAvailable", () => {
  it("says no when the demo was never seeded", async () => {
    expect(await demoAvailable()).toBe(false);
  });

  it("says yes once the demo owner exists", async () => {
    await seedDemoOwner();
    expect(await demoAvailable()).toBe(true);
  });

  it("says no for a deactivated demo owner, who could not sign in anyway", async () => {
    // Offering a sign-in that would be refused is the same broken promise.
    await seedDemoOwner(false);
    expect(await demoAvailable()).toBe(false);
  });
});
