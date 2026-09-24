import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Thread } from "@/components/messages/thread";
import { requirePermission } from "@/lib/auth";
import { getConversation, threadMessages } from "@/lib/conversations";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Messages" };

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, org } = await requirePermission("messages:use");
  const { id } = await params;

  // Not being in a thread looks exactly like the thread not existing.
  const [conversation, thread] = await Promise.all([
    getConversation(org.id, user, id),
    threadMessages({ organizationId: org.id, viewer: user, conversationId: id }),
  ]);
  if (!conversation || !thread) notFound();

  return (
    <Thread
      // A fresh component per thread, so nothing typed or loaded in one can
      // leak into the next.
      key={conversation.id}
      conversation={conversation}
      viewerId={user.id}
      initialMessages={thread.messages}
      initialHasEarlier={thread.hasEarlier}
      timeZone={org.timeZone}
      canSendPhotos={can(user, "files:write")}
    />
  );
}
