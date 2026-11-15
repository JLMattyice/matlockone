"use client";

import { useActionState } from "react";
import { Play, Square } from "lucide-react";

import { stopVisitTimer, workOnJob } from "../../my-day/actions";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

/**
 * The timer, on the job itself. Whoever has a job open can put their time on
 * it from here, so no job is out of the clock's reach — the list on My Day is
 * the near ones, this is all of them. It clocks in somebody who was not, and
 * stops the timer they had running elsewhere.
 */
export function JobTimer({
  jobId,
  runningSince,
}: {
  jobId: string;
  /** When this person's timer started here, as the page shows times — or null. */
  runningSince: string | null;
}) {
  const [startState, start] = useActionState<ActionState, FormData>(workOnJob, IDLE);
  const [stopState, stop] = useActionState<ActionState>(stopVisitTimer, IDLE);

  if (runningSince) {
    return (
      <form action={stop} className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-sm text-ink">Your timer has been running here since {runningSince}.</p>
        <SubmitButton variant="outline" size="sm" pendingLabel="Stopping…">
          <Square className="h-3 w-3" strokeWidth={2.5} />
          Stop timer
        </SubmitButton>
        <ActionStatus state={stopState} className="w-full text-xs" />
      </form>
    );
  }

  return (
    <form action={start} className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <p className="min-w-0 flex-1 text-sm text-ink-muted">
        Working on this now? Starting the timer clocks you in if you are not.
      </p>
      <SubmitButton variant="outline" size="sm" pendingLabel="Starting…">
        <Play className="h-3 w-3" strokeWidth={2.5} />
        Start timer
      </SubmitButton>
      <ActionStatus state={startState} className="w-full text-xs" />
    </form>
  );
}
