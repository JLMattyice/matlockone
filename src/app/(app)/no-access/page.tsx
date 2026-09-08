import type { Metadata } from "next";
import Link from "next/link";
import { ShieldOff } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";
import { requireContext } from "@/lib/auth";
import { ROLE_META } from "@/lib/constants";

export const metadata: Metadata = { title: "No access" };

export default async function NoAccessPage() {
  const { user } = await requireContext();
  const meta = ROLE_META[user.role];

  return (
    <div className="mx-auto max-w-lg pt-10">
      <Card>
        <EmptyState
          icon={<ShieldOff className="h-5 w-5" strokeWidth={1.75} />}
          title="You do not have access to that screen"
          description={`Your account is set to ${meta.label}. ${meta.description ?? ""} Ask an owner or administrator if you need this changed.`}
          action={
            <Link href="/dashboard" className={buttonClasses("primary", "md")}>
              Back to dashboard
            </Link>
          }
        />
      </Card>
    </div>
  );
}
