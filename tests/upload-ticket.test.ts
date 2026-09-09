import { describe, expect, it } from "vitest";

process.env.SESSION_SECRET ??= "test-secret-0123456789abcdef";

const { signUploadTicket, verifyUploadTicket } = await import("@/lib/storage/ticket");

/**
 * Once the browser uploads straight to the store, the server never witnesses the
 * upload — it is told about it afterwards, by the client. The ticket is the only
 * reason any of that message can be believed, so these cover the ways someone
 * would try to forge one.
 */

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    key: "org_a/11111111-1111-4111-8111-111111111111.jpg",
    organizationId: "org_a",
    userId: "user_1",
    entityType: "job" as const,
    entityId: "job_1",
    mimeType: "image/jpeg",
    sizeBytes: 1234,
    originalName: "photo.jpg",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("upload tickets", () => {
  it("round-trips everything the confirm step relies on", () => {
    const original = ticket();
    const verified = verifyUploadTicket(signUploadTicket(original));

    expect(verified).toEqual(original);
  });

  it("rejects a tampered payload", () => {
    // The attack this stops: take a valid ticket, point it at another
    // organization's record, and have the server file it there.
    const token = signUploadTicket(ticket());
    const [payload, signature] = token.split(".");

    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.organizationId = "org_victim";
    const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");

    expect(verifyUploadTicket(`${forged}.${signature}`)).toBeNull();
  });

  it("rejects a tampered key", () => {
    const token = signUploadTicket(ticket());
    const [payload, signature] = token.split(".");

    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.key = "org_victim/steal.jpg";
    const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");

    expect(verifyUploadTicket(`${forged}.${signature}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signUploadTicket(ticket());
    const [payload] = token.split(".");

    expect(verifyUploadTicket(`${payload}.notasignature`)).toBeNull();
  });

  it("rejects an expired ticket", () => {
    expect(verifyUploadTicket(signUploadTicket(ticket({ expiresAt: Date.now() - 1 })))).toBeNull();
  });

  it("rejects a ticket with no expiry at all", () => {
    // A ticket that never expires is a permanent write capability.
    expect(verifyUploadTicket(signUploadTicket(ticket({ expiresAt: "later" })))).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", ".", "nodot", "a.b", "....", "x".repeat(500)]) {
      expect(verifyUploadTicket(bad)).toBeNull();
    }
  });

  it("rejects a ticket signed with a different secret", () => {
    const token = signUploadTicket(ticket());
    const original = process.env.SESSION_SECRET;

    try {
      process.env.SESSION_SECRET = "a-completely-different-secret-value";
      expect(verifyUploadTicket(token)).toBeNull();
    } finally {
      process.env.SESSION_SECRET = original;
    }
  });

  it("keeps the tenant on the ticket, so confirm can compare it", () => {
    const verified = verifyUploadTicket(signUploadTicket(ticket({ organizationId: "org_b" })));
    expect(verified?.organizationId).toBe("org_b");
  });
});
