import "server-only";

import {
  GROUP_TITLE_MAX_LENGTH,
  MESSAGE_MAX_LENGTH,
  THREAD_PAGE_SIZE,
  type MessageView,
} from "./chat";
import { prisma } from "./db";

/**
 * Conversations between teammates.
 *
 * Everything here is scoped twice: to the organization, and to membership. A
 * conversation id is not a secret — it sits in the address bar — so every
 * read and write re-checks that the caller is in the thread, and a thread you
 * are not in answers exactly like one that does not exist. That includes the
 * owner: membership is the only way in.
 *
 * Not to be confused with `messaging.ts`, which is mail and texts going *out*
 * to clients. Nothing written here ever leaves the business.
 */

export type Person = {
  id: string;
  name: string;
  avatarUrl: string | null;
  position: string | null;
  isActive: boolean;
};

const PERSON_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
  position: true,
  isActive: true,
} as const;

const MESSAGE_SELECT = {
  id: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, name: true, avatarUrl: true } },
} as const;

function toView(message: {
  id: string;
  body: string;
  createdAt: Date;
  author: { id: string; name: string; avatarUrl: string | null } | null;
}): MessageView {
  return {
    id: message.id,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    author: message.author,
  };
}

/** The same pair of people gives the same key whichever of them asks. */
export function directKey(a: string, b: string) {
  return [a, b].sort().join(":");
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What a thread is called, from the point of view of whoever is looking.
 *
 * A direct thread is the other person. A group is its name, or failing one
 * the first names of everybody else in it — short enough for an inbox row.
 */
export function conversationTitle(
  conversation: { kind: string; title: string | null },
  others: { name: string }[],
) {
  if (conversation.kind === "GROUP" && conversation.title) {
    return conversation.title;
  }
  if (others.length === 0) return "Just you";
  if (conversation.kind === "DIRECT") return others[0].name;

  const firstNames = others.map((person) => person.name.split(/\s+/)[0] || person.name);
  if (firstNames.length <= 3) return joinNames(firstNames);
  return `${firstNames.slice(0, 2).join(", ")} and ${firstNames.length - 2} others`;
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

async function membership(
  organizationId: string,
  userId: string,
  conversationId: string,
) {
  return prisma.conversationMember.findFirst({
    where: { conversationId, userId, conversation: { organizationId } },
    select: { id: true, lastReadAt: true },
  });
}

// ----------------------------------------------------------------- opening ---

/**
 * The thread between two people, made the first time either of them asks.
 *
 * Returns null for anyone who could not be messaged: yourself, somebody
 * deactivated, somebody in another business. The unique index settles two
 * requests racing to create the same pair — the loser reads the winner's row.
 */
export async function openDirectConversation(input: {
  organizationId: string;
  userId: string;
  otherUserId: string;
}): Promise<string | null> {
  const { organizationId, userId, otherUserId } = input;
  if (!otherUserId || otherUserId === userId) return null;

  const other = await prisma.user.findFirst({
    where: { id: otherUserId, organizationId, isActive: true },
    select: { id: true },
  });
  if (!other) return null;

  const key = directKey(userId, other.id);
  const existing = await prisma.conversation.findFirst({
    where: { organizationId, directKey: key },
    select: { id: true },
  });
  if (existing) return existing.id;

  try {
    const created = await prisma.conversation.create({
      data: {
        organizationId,
        kind: "DIRECT",
        directKey: key,
        createdById: userId,
        members: { create: [{ userId }, { userId: other.id }] },
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const winner = await prisma.conversation.findFirst({
      where: { organizationId, directKey: key },
      select: { id: true },
    });
    return winner?.id ?? null;
  }
}

/**
 * Starts a thread with whoever was picked.
 *
 * One other person is a direct thread, whatever the form called it — a
 * "group" of two alongside the existing thread with the same person is two
 * places to look for one conversation. Ids that are not active teammates are
 * dropped rather than refused; null means nobody usable was left.
 */
export async function startConversation(input: {
  organizationId: string;
  userId: string;
  memberIds: string[];
  title?: string | null;
}): Promise<string | null> {
  const { organizationId, userId } = input;
  const wanted = [...new Set(input.memberIds)].filter((id) => id && id !== userId);
  if (wanted.length === 0) return null;

  const people = await prisma.user.findMany({
    where: { id: { in: wanted }, organizationId, isActive: true },
    select: { id: true },
  });
  if (people.length === 0) return null;

  if (people.length === 1) {
    return openDirectConversation({ organizationId, userId, otherUserId: people[0].id });
  }

  const title = input.title?.trim().slice(0, GROUP_TITLE_MAX_LENGTH) || null;

  const created = await prisma.conversation.create({
    data: {
      organizationId,
      kind: "GROUP",
      title,
      createdById: userId,
      members: {
        create: [{ userId }, ...people.map((person) => ({ userId: person.id }))],
      },
    },
    select: { id: true },
  });
  return created.id;
}

// ------------------------------------------------------------------ posting ---

/**
 * Adds a message to a thread the author is in.
 *
 * The author's own read position is left alone. Unread only ever counts other
 * people's messages, so there is nothing to clear — and moving it to "now"
 * would quietly mark as read whatever a colleague posted a moment earlier.
 */
export async function postMessage(input: {
  organizationId: string;
  conversationId: string;
  authorId: string;
  body: string;
}): Promise<MessageView | null> {
  const body = input.body.trim();
  if (!body || body.length > MESSAGE_MAX_LENGTH) return null;

  const member = await membership(input.organizationId, input.authorId, input.conversationId);
  if (!member) return null;

  // One clock for both writes, so the inbox's sort key is exactly the newest
  // message's time and "anything newer than lastReadAt" stays exact.
  const now = new Date();

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        authorId: input.authorId,
        body,
        createdAt: now,
      },
      select: MESSAGE_SELECT,
    }),
    prisma.conversation.update({
      where: { id: input.conversationId },
      data: { lastMessageAt: now },
    }),
  ]);

  return toView(message);
}

// ------------------------------------------------------------------ reading ---

export type ConversationDetail = {
  id: string;
  kind: string;
  title: string;
  /** Everybody but the viewer. */
  others: Person[];
};

export async function getConversation(
  organizationId: string,
  userId: string,
  conversationId: string,
): Promise<ConversationDetail | null> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId, members: { some: { userId } } },
    select: {
      id: true,
      kind: true,
      title: true,
      members: {
        orderBy: { joinedAt: "asc" },
        select: { user: { select: PERSON_SELECT } },
      },
    },
  });
  if (!conversation) return null;

  const others = conversation.members
    .map((member) => member.user)
    .filter((person) => person.id !== userId);

  return {
    id: conversation.id,
    kind: conversation.kind,
    title: conversationTitle(conversation, others),
    others,
  };
}

/**
 * Messages in a thread, oldest first.
 *
 * Three shapes: the latest page (opening a thread), everything from `after`
 * onwards (the poll), or the page before `beforeId` (scrolling back). `after`
 * is inclusive on purpose — two messages can share a millisecond, and the
 * caller already drops ids it has, so the cost of overlap is one repeated row
 * and the cost of a gap is a message nobody sees.
 */
export async function threadMessages(input: {
  organizationId: string;
  userId: string;
  conversationId: string;
  after?: Date | null;
  beforeId?: string | null;
}): Promise<{ messages: MessageView[]; hasEarlier: boolean } | null> {
  const member = await membership(input.organizationId, input.userId, input.conversationId);
  if (!member) return null;

  if (input.after) {
    const rows = await prisma.message.findMany({
      where: { conversationId: input.conversationId, createdAt: { gte: input.after } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
      select: MESSAGE_SELECT,
    });
    return { messages: rows.map(toView), hasEarlier: false };
  }

  const rows = await prisma.message.findMany({
    where: { conversationId: input.conversationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: THREAD_PAGE_SIZE + 1,
    ...(input.beforeId ? { cursor: { id: input.beforeId }, skip: 1 } : {}),
    select: MESSAGE_SELECT,
  });

  const hasEarlier = rows.length > THREAD_PAGE_SIZE;
  return {
    messages: rows.slice(0, THREAD_PAGE_SIZE).reverse().map(toView),
    hasEarlier,
  };
}

/**
 * Moves somebody's read position forward to `upTo`, never back, and never past
 * now. Returns whether anything moved, so a caller can tell the inbox and the
 * unread badge to catch up only when there is something to catch up on.
 */
export async function markConversationRead(input: {
  organizationId: string;
  userId: string;
  conversationId: string;
  upTo: Date;
}): Promise<boolean> {
  const now = new Date();
  const upTo = input.upTo > now ? now : input.upTo;

  const result = await prisma.conversationMember.updateMany({
    where: {
      conversationId: input.conversationId,
      userId: input.userId,
      conversation: { organizationId: input.organizationId },
      OR: [{ lastReadAt: null }, { lastReadAt: { lt: upTo } }],
    },
    data: { lastReadAt: upTo },
  });
  return result.count > 0;
}

// ------------------------------------------------------------------- unread ---

/**
 * The threads that could hold something unread, and from when.
 *
 * `lastMessageAt` rules most of them out without touching Message at all, so
 * the count that follows only looks inside threads that have moved.
 */
async function unreadScope(organizationId: string, userId: string) {
  const memberships = await prisma.conversationMember.findMany({
    where: { userId, conversation: { organizationId } },
    select: {
      conversationId: true,
      lastReadAt: true,
      conversation: { select: { lastMessageAt: true } },
    },
  });

  const moved = memberships.filter(
    (member) => !member.lastReadAt || member.conversation.lastMessageAt > member.lastReadAt,
  );
  if (moved.length === 0) return null;

  return {
    AND: [
      {
        OR: moved.map((member) =>
          member.lastReadAt
            ? { conversationId: member.conversationId, createdAt: { gt: member.lastReadAt } }
            : { conversationId: member.conversationId },
        ),
      },
      // Your own messages are never unread to you. Written as an OR because a
      // plain "not you" would also drop messages whose author has since been
      // deleted — NULL compares as neither equal nor unequal.
      { OR: [{ authorId: null }, { authorId: { not: userId } }] },
    ],
  };
}

export async function unreadMessageCount(organizationId: string, userId: string) {
  const where = await unreadScope(organizationId, userId);
  if (!where) return 0;
  return prisma.message.count({ where });
}

export async function unreadByConversation(
  organizationId: string,
  userId: string,
): Promise<Map<string, number>> {
  const where = await unreadScope(organizationId, userId);
  if (!where) return new Map();

  const groups = await prisma.message.groupBy({
    by: ["conversationId"],
    where,
    _count: { _all: true },
  });
  return new Map(groups.map((group) => [group.conversationId, group._count._all]));
}

// -------------------------------------------------------------------- inbox ---

export type InboxRow = {
  id: string;
  kind: string;
  title: string;
  others: Person[];
  lastMessage: {
    body: string;
    createdAt: string;
    authorName: string | null;
    mine: boolean;
  } | null;
  lastMessageAt: string;
  unread: number;
};

/**
 * Everything the viewer is in, most recently active first.
 *
 * A thread nobody has written in yet shows only to whoever opened it. Pressing
 * "Message" on a colleague's page and thinking better of it should not leave
 * an empty conversation sitting in their inbox.
 */
export async function listConversations(
  organizationId: string,
  userId: string,
  take = 100,
): Promise<InboxRow[]> {
  const [conversations, unread] = await Promise.all([
    prisma.conversation.findMany({
      where: {
        organizationId,
        members: { some: { userId } },
        OR: [{ messages: { some: {} } }, { createdById: userId }],
      },
      orderBy: { lastMessageAt: "desc" },
      take,
      select: {
        id: true,
        kind: true,
        title: true,
        lastMessageAt: true,
        members: {
          orderBy: { joinedAt: "asc" },
          select: { user: { select: PERSON_SELECT } },
        },
        messages: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            body: true,
            createdAt: true,
            authorId: true,
            author: { select: { name: true } },
          },
        },
      },
    }),
    unreadByConversation(organizationId, userId),
  ]);

  return conversations.map((conversation) => {
    const others = conversation.members
      .map((member) => member.user)
      .filter((person) => person.id !== userId);
    const last = conversation.messages[0];

    return {
      id: conversation.id,
      kind: conversation.kind,
      title: conversationTitle(conversation, others),
      others,
      lastMessage: last
        ? {
            body: last.body,
            createdAt: last.createdAt.toISOString(),
            authorName: last.author?.name ?? null,
            mine: last.authorId === userId,
          }
        : null,
      lastMessageAt: conversation.lastMessageAt.toISOString(),
      unread: unread.get(conversation.id) ?? 0,
    };
  });
}
