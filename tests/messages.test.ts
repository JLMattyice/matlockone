import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  dayHeading,
  dayKey,
  inboxStamp,
  MESSAGE_MAX_LENGTH,
  mergeMessages,
  splitLinks,
  timeOfDay,
  type MessageView,
} from "@/lib/chat";
import {
  conversationTitle,
  directKey,
  getConversation,
  listConversations,
  markConversationRead,
  openDirectConversation,
  postMessage,
  startConversation,
  threadMessages,
  unreadByConversation,
  unreadMessageCount,
} from "@/lib/conversations";
import { ROLES } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";

/**
 * Team messaging.
 *
 * What carries the feature: a thread is readable by the people in it and by
 * nobody else, the owner included; there is one direct thread per pair however
 * it is reached; and "unread" means somebody else's message you have not been
 * shown, which is what the badge in the sidebar counts.
 */

let organizationId: string;
let otherOrganizationId: string;
let owner: string;
let office: string;
let tech: string;
let apprentice: string;

async function seedOrg(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `messages-${randomUUID()}`, name },
  });
  return org.id;
}

async function addUser(orgId: string, role: string, name: string, isActive = true) {
  const user = await prisma.user.create({
    data: {
      organizationId: orgId,
      email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
      name,
      passwordHash: "x",
      role,
      isActive,
    },
  });
  return user.id;
}

async function say(conversationId: string, authorId: string, body: string) {
  const message = await postMessage({ organizationId, conversationId, authorId, body });
  if (!message) throw new Error(`Could not post "${body}"`);
  return message;
}

beforeEach(async () => {
  organizationId = await seedOrg("Messages Test Co");
  otherOrganizationId = await seedOrg("Someone Else Ltd");

  owner = await addUser(organizationId, "OWNER", "Alex Rivera");
  office = await addUser(organizationId, "ADMIN", "Dana Okonkwo");
  tech = await addUser(organizationId, "EMPLOYEE", "Priya Raghavan");
  apprentice = await addUser(organizationId, "EMPLOYEE", "Grace Lindqvist");
});

describe("who may use it", () => {
  it("is open to every role, the crew included", () => {
    for (const role of ROLES) {
      expect(can({ role }, "messages:use")).toBe(true);
    }
  });
});

describe("direct threads", () => {
  it("gives the same pair the same key whichever of them asks", () => {
    expect(directKey("a", "b")).toBe(directKey("b", "a"));
    expect(directKey("a", "b")).not.toBe(directKey("a", "c"));
  });

  it("reopens the thread you already have instead of starting another", async () => {
    const first = await openDirectConversation({ organizationId, userId: owner, otherUserId: tech });
    const second = await openDirectConversation({ organizationId, userId: tech, otherUserId: owner });

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(await prisma.conversation.count({ where: { organizationId } })).toBe(1);
  });

  it("settles two requests racing to create the same pair on one thread", async () => {
    const [a, b] = await Promise.all([
      openDirectConversation({ organizationId, userId: owner, otherUserId: tech }),
      openDirectConversation({ organizationId, userId: tech, otherUserId: owner }),
    ]);

    expect(a).toBe(b);
    expect(await prisma.conversation.count({ where: { organizationId } })).toBe(1);
  });

  it("will not open a thread with yourself, a deactivated teammate, or another business", async () => {
    const gone = await addUser(organizationId, "EMPLOYEE", "Tom Delacroix", false);
    const stranger = await addUser(otherOrganizationId, "OWNER", "Somebody Else");

    for (const otherUserId of [owner, gone, stranger, "no-such-user"]) {
      expect(
        await openDirectConversation({ organizationId, userId: owner, otherUserId }),
      ).toBeNull();
    }
    expect(await prisma.conversation.count({ where: { organizationId } })).toBe(0);
  });
});

describe("starting a conversation", () => {
  it("treats one other person as the direct thread with them", async () => {
    const existing = await openDirectConversation({ organizationId, userId: owner, otherUserId: tech });
    const started = await startConversation({
      organizationId,
      userId: owner,
      memberIds: [tech],
      title: "About the Hendricks job",
    });

    expect(started).toBe(existing);
  });

  it("makes a group of everybody picked, plus whoever started it", async () => {
    const id = await startConversation({
      organizationId,
      userId: owner,
      memberIds: [tech, apprentice, tech],
      title: "  Northside crew  ",
    });

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: id! },
      include: { members: true },
    });
    expect(conversation.kind).toBe("GROUP");
    expect(conversation.title).toBe("Northside crew");
    expect(conversation.members.map((m) => m.userId).sort()).toEqual(
      [owner, tech, apprentice].sort(),
    );
  });

  it("drops people who are not active teammates, and refuses when nobody is left", async () => {
    const stranger = await addUser(otherOrganizationId, "OWNER", "Somebody Else");

    const id = await startConversation({
      organizationId,
      userId: owner,
      memberIds: [tech, office, stranger],
    });
    const members = await prisma.conversationMember.findMany({ where: { conversationId: id! } });
    expect(members.map((m) => m.userId)).not.toContain(stranger);

    expect(
      await startConversation({ organizationId, userId: owner, memberIds: [stranger, owner] }),
    ).toBeNull();
  });
});

describe("privacy", () => {
  it("answers a thread you are not in exactly like one that does not exist — owner included", async () => {
    const id = (await openDirectConversation({
      organizationId,
      userId: office,
      otherUserId: tech,
    }))!;
    await say(id, tech, "Can you move my 3 o'clock?");

    expect(await getConversation(organizationId, owner, id)).toBeNull();
    expect(await threadMessages({ organizationId, userId: owner, conversationId: id })).toBeNull();
    expect(
      await postMessage({ organizationId, conversationId: id, authorId: owner, body: "Hi" }),
    ).toBeNull();
    expect(await listConversations(organizationId, owner)).toEqual([]);
  });

  it("does not reach a thread through another business's id", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;

    expect(
      await threadMessages({ organizationId: otherOrganizationId, userId: owner, conversationId: id }),
    ).toBeNull();
  });
});

describe("posting", () => {
  it("adds the message and moves the thread to the top of the inbox", async () => {
    const quiet = (await openDirectConversation({ organizationId, userId: owner, otherUserId: office }))!;
    const busy = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;
    await say(quiet, office, "Earlier");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await say(busy, tech, "Later");

    const inbox = await listConversations(organizationId, owner);
    expect(inbox.map((row) => row.id)).toEqual([busy, quiet]);
    expect(inbox[0].lastMessage).toMatchObject({ body: "Later", authorName: "Priya Raghavan", mine: false });
    expect(inbox[0].title).toBe("Priya Raghavan");
  });

  it("keeps a thread nobody has written in out of everybody's inbox but its opener's", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;

    expect((await listConversations(organizationId, owner)).map((row) => row.id)).toEqual([id]);
    expect(await listConversations(organizationId, tech)).toEqual([]);

    await say(id, owner, "Are you free at 3?");
    expect((await listConversations(organizationId, tech)).map((row) => row.id)).toEqual([id]);
  });

  it("refuses an empty message and an overlong one", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;

    for (const body of ["", "   \n  ", "x".repeat(MESSAGE_MAX_LENGTH + 1)]) {
      expect(await postMessage({ organizationId, conversationId: id, authorId: owner, body })).toBeNull();
    }
    expect(await prisma.message.count({ where: { conversationId: id } })).toBe(0);
  });

  it("keeps a departed author's messages in the thread", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;
    await say(id, tech, "The part is in the van.");

    await prisma.user.delete({ where: { id: tech } });

    const thread = await threadMessages({ organizationId, userId: owner, conversationId: id });
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0].author).toBeNull();
  });
});

describe("reading a thread", () => {
  it("opens on the latest page and scrolls back one page at a time", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;
    const base = Date.now() - 60 * 60 * 1000;
    await prisma.message.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        organizationId,
        conversationId: id,
        authorId: i % 2 ? owner : tech,
        body: `Message ${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    });

    const latest = (await threadMessages({ organizationId, userId: owner, conversationId: id }))!;
    expect(latest.messages).toHaveLength(50);
    expect(latest.messages[0].body).toBe("Message 10");
    expect(latest.messages.at(-1)?.body).toBe("Message 59");
    expect(latest.hasEarlier).toBe(true);

    const earlier = (await threadMessages({
      organizationId,
      userId: owner,
      conversationId: id,
      beforeId: latest.messages[0].id,
    }))!;
    expect(earlier.messages.map((m) => m.body)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Message ${i}`),
    );
    expect(earlier.hasEarlier).toBe(false);
  });

  it("polls from a point in time inclusively, so a shared millisecond cannot hide a message", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;
    const at = new Date(Date.now() - 1000);
    await prisma.message.createMany({
      data: [
        { organizationId, conversationId: id, authorId: tech, body: "Seen", createdAt: at },
        { organizationId, conversationId: id, authorId: tech, body: "Same moment", createdAt: at },
      ],
    });

    const poll = (await threadMessages({ organizationId, userId: owner, conversationId: id, after: at }))!;
    expect(poll.messages.map((m) => m.body).sort()).toEqual(["Same moment", "Seen"]);
  });
});

describe("unread", () => {
  it("counts other people's messages you have not been shown, never your own", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;
    await say(id, owner, "Are you on site?");
    await say(id, tech, "Ten minutes out.");
    await say(id, tech, "Traffic on 401.");

    expect(await unreadMessageCount(organizationId, owner)).toBe(2);
    expect(await unreadMessageCount(organizationId, tech)).toBe(1);
  });

  it("clears when read, and counts only what came after", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;
    const first = await say(id, tech, "One");

    expect(
      await markConversationRead({ organizationId, userId: owner, conversationId: id, upTo: new Date(first.createdAt) }),
    ).toBe(true);
    expect(await unreadMessageCount(organizationId, owner)).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await say(id, tech, "Two");
    expect(await unreadMessageCount(organizationId, owner)).toBe(1);
  });

  it("never moves a read position backwards, and says when nothing moved", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;
    const message = await say(id, tech, "One");
    const at = new Date(message.createdAt);

    await markConversationRead({ organizationId, userId: owner, conversationId: id, upTo: at });
    expect(
      await markConversationRead({
        organizationId,
        userId: owner,
        conversationId: id,
        upTo: new Date(at.getTime() - 60_000),
      }),
    ).toBe(false);
    expect(
      await markConversationRead({ organizationId, userId: owner, conversationId: id, upTo: at }),
    ).toBe(false);
    expect(await unreadMessageCount(organizationId, owner)).toBe(0);
  });

  it("will not mark the future as read", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;
    await markConversationRead({
      organizationId,
      userId: owner,
      conversationId: id,
      upTo: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await say(id, tech, "Posted after the read");
    expect(await unreadMessageCount(organizationId, owner)).toBe(1);
  });

  it("splits the count by thread for the inbox", async () => {
    const withTech = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;
    const group = (await startConversation({
      organizationId,
      userId: office,
      memberIds: [owner, tech, apprentice],
    }))!;
    await say(withTech, tech, "One");
    await say(group, office, "Two");
    await say(group, apprentice, "Three");

    const counts = await unreadByConversation(organizationId, owner);
    expect(counts.get(withTech)).toBe(1);
    expect(counts.get(group)).toBe(2);

    const inbox = await listConversations(organizationId, owner);
    expect(inbox.find((row) => row.id === group)?.unread).toBe(2);
  });

  it("counts a message whose author has since been deleted", async () => {
    const id = (await openDirectConversation({ organizationId, userId: owner, otherUserId: tech }))!;
    await say(id, tech, "Handing in my keys.");
    await prisma.user.delete({ where: { id: tech } });

    expect(await unreadMessageCount(organizationId, owner)).toBe(1);
  });

  it("does not count another business's messages", async () => {
    const theirOwner = await addUser(otherOrganizationId, "OWNER", "Somebody Else");
    const theirTech = await addUser(otherOrganizationId, "EMPLOYEE", "Their Tech");
    const theirs = (await openDirectConversation({
      organizationId: otherOrganizationId,
      userId: theirOwner,
      otherUserId: theirTech,
    }))!;
    await postMessage({
      organizationId: otherOrganizationId,
      conversationId: theirs,
      authorId: theirTech,
      body: "Theirs",
    });

    expect(await unreadMessageCount(organizationId, owner)).toBe(0);
    expect(await unreadMessageCount(otherOrganizationId, theirOwner)).toBe(1);
  });
});

describe("names", () => {
  it("calls a direct thread the other person and an unnamed group its first names", () => {
    const direct = { kind: "DIRECT", title: null };
    const group = { kind: "GROUP", title: null };
    const people = ["Priya Raghavan", "Tom Delacroix", "Grace Lindqvist", "Marcus Whitfield"].map(
      (name) => ({ name }),
    );

    expect(conversationTitle(direct, people.slice(0, 1))).toBe("Priya Raghavan");
    expect(conversationTitle(group, people.slice(0, 2))).toBe("Priya and Tom");
    expect(conversationTitle(group, people.slice(0, 3))).toBe("Priya, Tom and Grace");
    expect(conversationTitle(group, people)).toBe("Priya, Tom and 2 others");
    expect(conversationTitle({ kind: "GROUP", title: "Northside crew" }, people)).toBe("Northside crew");
    expect(conversationTitle(group, [])).toBe("Just you");
  });
});

describe("times, in the business's zone", () => {
  const zone = "America/New_York";
  // 6:14pm UTC is 2:14pm in New York during daylight saving time.
  const afternoon = new Date("2026-09-23T18:14:00Z");

  it("stamps a message in the business's zone rather than the server's", () => {
    expect(timeOfDay(afternoon, zone)).toBe("2:14 PM");
    expect(timeOfDay(afternoon, "America/Los_Angeles")).toBe("11:14 AM");
  });

  it("groups by the business's calendar day, not UTC's", () => {
    // 1am UTC on the 24th is still the evening of the 23rd in New York.
    expect(dayKey(new Date("2026-09-24T01:00:00Z"), zone)).toBe("2026-09-23");
  });

  it("heads days as a person would say them", () => {
    const now = new Date("2026-09-23T20:00:00Z");
    expect(dayHeading(afternoon, zone, now)).toBe("Today");
    expect(dayHeading(new Date("2026-09-22T15:00:00Z"), zone, now)).toBe("Yesterday");
    expect(dayHeading(new Date("2026-09-21T15:00:00Z"), zone, now)).toBe("Monday, September 21");
    expect(dayHeading(new Date("2025-09-21T15:00:00Z"), zone, now)).toBe("Sunday, September 21, 2025");
  });

  it("shortens the inbox stamp the further back it goes", () => {
    const now = new Date("2026-09-23T20:00:00Z");
    expect(inboxStamp(afternoon, zone, now)).toBe("2:14 PM");
    expect(inboxStamp(new Date("2026-09-22T15:00:00Z"), zone, now)).toBe("Yesterday");
    expect(inboxStamp(new Date("2026-09-19T15:00:00Z"), zone, now)).toBe("Sat");
    expect(inboxStamp(new Date("2026-08-03T15:00:00Z"), zone, now)).toBe("Aug 3");
  });

  it("falls back rather than throwing on a zone this runtime does not know", () => {
    expect(() => timeOfDay(afternoon, "Mars/Olympus_Mons")).not.toThrow();
  });
});

describe("links", () => {
  it("links web addresses and leaves the sentence's punctuation outside", () => {
    expect(splitLinks("Parts list at https://example.com/parts. Thanks")).toEqual([
      { text: "Parts list at " },
      { text: "https://example.com/parts", href: "https://example.com/parts" },
      { text: ". Thanks" },
    ]);
  });

  it("never links anything but http and https", () => {
    const parts = splitLinks("javascript:alert(1) and data:text/html,hi");
    expect(parts.every((part) => !part.href)).toBe(true);
  });

  it("keeps a bracket that belongs to the address", () => {
    const [link] = splitLinks("https://en.wikipedia.org/wiki/Heat_pump_(disambiguation)").filter(
      (part) => part.href,
    );
    expect(link.href).toBe("https://en.wikipedia.org/wiki/Heat_pump_(disambiguation)");
    expect(splitLinks("(see https://example.com/a)")[1].href).toBe("https://example.com/a");
  });
});

describe("merging a poll into what is on screen", () => {
  const message = (id: string, createdAt: string): MessageView => ({
    id,
    body: id,
    createdAt,
    author: null,
  });

  it("drops repeats and keeps time order", () => {
    const shown = [message("a", "2026-09-23T10:00:00.000Z"), message("b", "2026-09-23T10:01:00.000Z")];
    const polled = [message("b", "2026-09-23T10:01:00.000Z"), message("c", "2026-09-23T10:02:00.000Z")];

    expect(mergeMessages(shown, polled).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(mergeMessages(polled, shown).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});
