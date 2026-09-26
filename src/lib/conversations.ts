import "server-only";

import {
  GROUP_TITLE_MAX_LENGTH,
  MAX_PHOTOS_PER_MESSAGE,
  MESSAGE_MAX_LENGTH,
  THREAD_PAGE_SIZE,
  type MessageView,
} from "./chat";
import { prisma } from "./db";
import { jobVisibilityWhere, type Actor } from "./permissions";

/**
 * Conversations between teammates.
 *
 * Two rules decide who may open a thread, and every read and write here goes
 * through them rather than trusting an id — a conversation id is not a secret,
 * it sits in the address bar:
 *
 *   - A direct or group thread is open to its members and nobody else, the
 *     owner included.
 *   - A job thread is open to whoever can see the job: the office, and the
 *     crew assigned to it. It belongs to the work, not to the people who
 *     happened to be in it, so a technician taken off the job loses it with
 *     the job and one put on it gets the whole history.
 *
 * A thread somebody may not open answers exactly like one that does not exist.
 *
 * Membership also says whose inbox a thread sits in and whose unread count it
 * adds to. For job threads that is the assigned crew, whoever started it, and
 * anybody who has written in it — not every manager who can see every job,
 * whose badge would otherwise count every conversation in the business.
 *
 * Not to be confused with `messaging.ts`, which is mail and texts going *out*
 * to clients. Nothing written here ever leaves the business.
 */

/** Whoever is asking. The role matters for job threads, which follow jobs. */
export type Viewer = Actor & { id: string };

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
  photos: {
    orderBy: { id: "asc" },
    select: { attachment: { select: { id: true, originalName: true } } },
  },
} as const;

function toView(message: {
  id: string;
  body: string;
  createdAt: Date;
  author: { id: string; name: string; avatarUrl: string | null } | null;
  photos: { attachment: { id: string; originalName: string } }[];
}): MessageView {
  return {
    id: message.id,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    author: message.author,
    photos: message.photos.map((photo) => ({
      id: photo.attachment.id,
      name: photo.attachment.originalName,
    })),
  };
}

// --------------------------------------------------------------- the rules ---

/** A job thread whose job the viewer can see. */
function visibleJob(organizationId: string, viewer: Viewer) {
  return {
    jobId: { not: null },
    job: { is: { organizationId, ...jobVisibilityWhere(viewer) } },
  };
}

/**
 * The threads a viewer may open, as a `where` on Conversation. The one place
 * the two rules at the top of this file are written down.
 */
export function conversationAccessWhere(organizationId: string, viewer: Viewer) {
  return {
    organizationId,
    OR: [
      { jobId: null, members: { some: { userId: viewer.id } } },
      visibleJob(organizationId, viewer),
    ],
  };
}

/**
 * The threads in a viewer's inbox: the ones they are a member of and may
 * still open. A technician's membership of a job thread outlives their place
 * on the job, and is simply not counted while they are off it.
 */
function inboxWhere(organizationId: string, viewer: Viewer) {
  return {
    organizationId,
    members: { some: { userId: viewer.id } },
    OR: [{ jobId: null }, visibleJob(organizationId, viewer)],
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
 * A job thread is the job, by its number and its title as they stand now
 * rather than as they were when somebody first wrote in it. A direct thread
 * is the other person. A group is its name, or failing one the first names of
 * everybody else in it — short enough for an inbox row.
 */
export function conversationTitle(
  conversation: {
    kind: string;
    title: string | null;
    job?: { number: string; title: string } | null;
  },
  others: { name: string }[],
) {
  if (conversation.kind === "JOB" && conversation.job) {
    return `${conversation.job.number} · ${conversation.job.title}`;
  }
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

/** The thread if the viewer may open it, with their own membership if any. */
async function openable(organizationId: string, viewer: Viewer, conversationId: string) {
  return prisma.conversation.findFirst({
    where: { id: conversationId, ...conversationAccessWhere(organizationId, viewer) },
    select: {
      id: true,
      kind: true,
      jobId: true,
      members: { where: { userId: viewer.id }, select: { id: true, lastReadAt: true } },
    },
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

/**
 * The conversation about a job, started the first time anyone asks for it.
 *
 * Only somebody who can see the job may start or find it. A new thread's
 * members are the crew on the job and whoever started it, so it arrives in
 * the inbox of the people who will be asked about it. Opening one that
 * already exists changes nobody's membership — reading is not joining.
 */
export async function openJobThread(input: {
  organizationId: string;
  viewer: Viewer;
  jobId: string;
}): Promise<string | null> {
  const { organizationId, viewer, jobId } = input;
  if (!jobId) return null;

  const job = await prisma.job.findFirst({
    where: { id: jobId, organizationId, ...jobVisibilityWhere(viewer) },
    select: { id: true, assignments: { select: { userId: true } } },
  });
  if (!job) return null;

  const existing = await prisma.conversation.findFirst({
    where: { organizationId, jobId: job.id },
    select: { id: true },
  });
  if (existing) return existing.id;

  const memberIds = [...new Set([viewer.id, ...job.assignments.map((a) => a.userId)])];

  try {
    const created = await prisma.conversation.create({
      data: {
        organizationId,
        kind: "JOB",
        jobId: job.id,
        createdById: viewer.id,
        members: { create: memberIds.map((userId) => ({ userId })) },
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const winner = await prisma.conversation.findFirst({
      where: { organizationId, jobId: job.id },
      select: { id: true },
    });
    return winner?.id ?? null;
  }
}

/**
 * Puts people newly assigned to a job into its thread, if it has one.
 *
 * They start with everything already said marked as read: the history is
 * there to scroll back through, but somebody put on a job this morning should
 * not open the app to a badge of forty messages from last week.
 */
export async function joinJobThread(input: {
  organizationId: string;
  jobId: string;
  userIds: string[];
}) {
  const userIds = [...new Set(input.userIds)].filter(Boolean);
  if (userIds.length === 0) return 0;

  const thread = await prisma.conversation.findFirst({
    where: { organizationId: input.organizationId, jobId: input.jobId },
    select: { id: true },
  });
  if (!thread) return 0;

  const now = new Date();
  for (const userId of userIds) {
    await prisma.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: thread.id, userId } },
      create: { conversationId: thread.id, userId, lastReadAt: now },
      update: {},
    });
  }
  return userIds.length;
}

// ------------------------------------------------------------------ posting ---

/**
 * Adds a message to a thread the author may open.
 *
 * Writing in a job thread you were not a member of makes you one, so the
 * reply to your question finds you. The author's read position is otherwise
 * left alone: unread only ever counts other people's messages, and moving it
 * to "now" would quietly mark as read whatever a colleague posted a moment
 * earlier.
 *
 * Photos are job photos already recorded by the caller, and only ones that
 * belong here are accepted: on this thread's job, uploaded by this author,
 * and not already sent. Anything else in the list is dropped rather than
 * trusted — the ids arrive from the browser. A message may be only photos,
 * but not nothing at all.
 */
export async function postMessage(input: {
  organizationId: string;
  conversationId: string;
  author: Viewer;
  body: string;
  photoIds?: string[];
}): Promise<MessageView | null> {
  const body = input.body.trim();
  if (body.length > MESSAGE_MAX_LENGTH) return null;

  const thread = await openable(input.organizationId, input.author, input.conversationId);
  if (!thread) return null;

  const wanted = [...new Set(input.photoIds ?? [])].slice(0, MAX_PHOTOS_PER_MESSAGE);
  const photos =
    wanted.length > 0 && thread.jobId
      ? await prisma.attachment.findMany({
          where: {
            id: { in: wanted },
            organizationId: input.organizationId,
            jobId: thread.jobId,
            kind: "PHOTO",
            uploadedById: input.author.id,
            messageLink: { is: null },
          },
          select: { id: true },
        })
      : [];

  if (!body && photos.length === 0) return null;

  // One clock for both writes, so the inbox's sort key is exactly the newest
  // message's time and "anything newer than lastReadAt" stays exact.
  const now = new Date();

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        organizationId: input.organizationId,
        conversationId: thread.id,
        authorId: input.author.id,
        body,
        createdAt: now,
        photos: { create: photos.map((photo) => ({ attachmentId: photo.id })) },
      },
      select: MESSAGE_SELECT,
    }),
    prisma.conversation.update({
      where: { id: thread.id },
      data: { lastMessageAt: now },
    }),
    ...(thread.kind === "JOB" && thread.members.length === 0
      ? [
          prisma.conversationMember.upsert({
            where: {
              conversationId_userId: { conversationId: thread.id, userId: input.author.id },
            },
            create: { conversationId: thread.id, userId: input.author.id, lastReadAt: now },
            update: {},
          }),
        ]
      : []),
  ]);

  return toView(message);
}

// ------------------------------------------------------------------ reading ---

export type ConversationDetail = {
  id: string;
  kind: string;
  title: string;
  /** Everybody in it but the viewer. */
  others: Person[];
  /** The job a job thread is about, as it stands now. */
  job: {
    id: string;
    number: string;
    title: string;
    clientName: string | null;
  } | null;
};

export async function getConversation(
  organizationId: string,
  viewer: Viewer,
  conversationId: string,
): Promise<ConversationDetail | null> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, ...conversationAccessWhere(organizationId, viewer) },
    select: {
      id: true,
      kind: true,
      title: true,
      job: {
        select: {
          id: true,
          number: true,
          title: true,
          client: { select: { displayName: true } },
        },
      },
      members: {
        orderBy: { joinedAt: "asc" },
        select: { user: { select: PERSON_SELECT } },
      },
    },
  });
  if (!conversation) return null;

  const others = conversation.members
    .map((member) => member.user)
    .filter((person) => person.id !== viewer.id);

  return {
    id: conversation.id,
    kind: conversation.kind,
    title: conversationTitle(conversation, others),
    others,
    job: conversation.job
      ? {
          id: conversation.job.id,
          number: conversation.job.number,
          title: conversation.job.title,
          clientName: conversation.job.client?.displayName ?? null,
        }
      : null,
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
  viewer: Viewer;
  conversationId: string;
  after?: Date | null;
  beforeId?: string | null;
}): Promise<{ messages: MessageView[]; hasEarlier: boolean } | null> {
  const thread = await openable(input.organizationId, input.viewer, input.conversationId);
  if (!thread) return null;

  if (input.after) {
    const rows = await prisma.message.findMany({
      where: { conversationId: thread.id, createdAt: { gte: input.after } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
      select: MESSAGE_SELECT,
    });
    return { messages: rows.map(toView), hasEarlier: false };
  }

  const rows = await prisma.message.findMany({
    where: { conversationId: thread.id },
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
 *
 * Somebody reading a job thread they are not a member of has no position to
 * move, and that is the point: reading one is not joining it.
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

/** What the job page shows of its conversation, if it has one. */
export async function jobThreadSummary(
  organizationId: string,
  viewer: Viewer,
  jobId: string,
) {
  const thread = await prisma.conversation.findFirst({
    where: { jobId, ...conversationAccessWhere(organizationId, viewer) },
    select: {
      id: true,
      _count: { select: { messages: true } },
      messages: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 3,
        select: MESSAGE_SELECT,
      },
    },
  });
  if (!thread) return null;

  return {
    id: thread.id,
    messageCount: thread._count.messages,
    recent: thread.messages.reverse().map(toView),
  };
}

// ------------------------------------------------------------------- unread ---

/**
 * The threads that could hold something unread, and from when.
 *
 * `lastMessageAt` rules most of them out without touching Message at all, so
 * the count that follows only looks inside threads that have moved.
 */
async function unreadScope(organizationId: string, viewer: Viewer) {
  const memberships = await prisma.conversationMember.findMany({
    where: {
      userId: viewer.id,
      conversation: {
        organizationId,
        OR: [{ jobId: null }, visibleJob(organizationId, viewer)],
      },
    },
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
      { OR: [{ authorId: null }, { authorId: { not: viewer.id } }] },
    ],
  };
}

export async function unreadMessageCount(organizationId: string, viewer: Viewer) {
  const where = await unreadScope(organizationId, viewer);
  if (!where) return 0;
  return prisma.message.count({ where });
}

export async function unreadByConversation(
  organizationId: string,
  viewer: Viewer,
): Promise<Map<string, number>> {
  const where = await unreadScope(organizationId, viewer);
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
    photoCount: number;
    createdAt: string;
    authorName: string | null;
    mine: boolean;
  } | null;
  lastMessageAt: string;
  unread: number;
};

/**
 * Everything in the viewer's inbox, most recently active first.
 *
 * A thread nobody has written in yet shows only to whoever opened it. Pressing
 * "Message" on a colleague's page and thinking better of it should not leave
 * an empty conversation sitting in their inbox.
 */
export async function listConversations(
  organizationId: string,
  viewer: Viewer,
  take = 100,
): Promise<InboxRow[]> {
  const [conversations, unread] = await Promise.all([
    prisma.conversation.findMany({
      where: {
        AND: [
          inboxWhere(organizationId, viewer),
          { OR: [{ messages: { some: {} } }, { createdById: viewer.id }] },
        ],
      },
      orderBy: { lastMessageAt: "desc" },
      take,
      select: {
        id: true,
        kind: true,
        title: true,
        lastMessageAt: true,
        job: { select: { number: true, title: true } },
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
            _count: { select: { photos: true } },
          },
        },
      },
    }),
    unreadByConversation(organizationId, viewer),
  ]);

  return conversations.map((conversation) => {
    const others = conversation.members
      .map((member) => member.user)
      .filter((person) => person.id !== viewer.id);
    const last = conversation.messages[0];

    return {
      id: conversation.id,
      kind: conversation.kind,
      title: conversationTitle(conversation, others),
      others,
      lastMessage: last
        ? {
            body: last.body,
            photoCount: last._count.photos,
            createdAt: last.createdAt.toISOString(),
            authorName: last.author?.name ?? null,
            mine: last.authorId === viewer.id,
          }
        : null,
      lastMessageAt: conversation.lastMessageAt.toISOString(),
      unread: unread.get(conversation.id) ?? 0,
    };
  });
}
