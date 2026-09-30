import { ConversationList } from "@/components/messages/conversation-list";
import { MessagesShell } from "@/components/messages/messages-shell";
import { requirePermission } from "@/lib/auth";
import { listConversations } from "@/lib/conversations";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

/**
 * The inbox stays mounted while threads change beside it. It is re-rendered
 * by a refresh — after a send, after a read, or when the sidebar's poll sees
 * something new — rather than on every navigation between threads.
 */
export default async function MessagesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, org } = await requirePermission("messages:use");
  const [rows, zone] = await Promise.all([
    listConversations(org.id, user),
    viewerTimeZone(),
  ]);

  return (
    <MessagesShell list={<ConversationList rows={rows} timeZone={zone} />}>
      {children}
    </MessagesShell>
  );
}
