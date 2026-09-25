import { ActivityTimeline } from "./timeline";
import { Card, CardHeader } from "@/components/ui/card";
import { jobTimeline } from "@/lib/activity";
import type { Actor } from "@/lib/permissions";

/**
 * A job's own timeline, at the foot of the job page.
 *
 * Shown to everyone who can open the job, not only to the people who can see
 * the whole business. What a technician gets here is the job itself — its
 * status changes, notes, photos and finished tasks, all of which the page
 * above already shows them. The estimate and invoices behind it are added by
 * jobTimeline() only for somebody who may read those, and money lines are
 * filtered inside the query whichever way it is called.
 *
 * Its own component so the page gains two lines rather than a block: the job
 * page is busy, and more than one piece of work touches it.
 */
export async function JobActivity({
  organizationId,
  jobId,
  viewer,
  jobLabel,
}: {
  organizationId: string;
  jobId: string;
  viewer: Actor;
  /** The business's own word for a job, as on the rest of the page. */
  jobLabel: string;
}) {
  const events = await jobTimeline(organizationId, jobId, viewer);

  return (
    <Card className="overflow-hidden">
      <CardHeader title="Activity" />
      <ActivityTimeline
        events={events}
        emptyTitle="Nothing has happened yet"
        emptyDescription={`Changes, notes, photos and finished tasks on this ${jobLabel.toLowerCase()} will appear here.`}
      />
    </Card>
  );
}
