import type { Metadata } from "next";
import Link from "next/link";
import { MessageSquare } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";
import { requirePermission } from "@/lib/auth";

export const metadata: Metadata = { title: "Messages" };

/** The empty right-hand pane on a desktop. A phone shows the inbox instead. */
export default async function MessagesPage() {
  await requirePermission("messages:use");

  return (
    <Card className="flex h-full items-center justify-center">
      <EmptyState
        icon={<MessageSquare className="h-5 w-5" strokeWidth={1.75} />}
        title="Pick a conversation"
        description="Or start a new one with anybody on the team."
        action={
          <Link href="/messages/new" className={buttonClasses("outline", "md")}>
            New message
          </Link>
        }
      />
    </Card>
  );
}
