import Link from "next/link";
import { FileQuestion } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page-header";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg pt-10">
      <Card>
        <EmptyState
          icon={<FileQuestion className="h-5 w-5" strokeWidth={1.75} />}
          title="Not found"
          description="That record does not exist, or it belongs to another organization."
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
