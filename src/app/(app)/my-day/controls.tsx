"use client";

import Link from "next/link";
import { useActionState, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Camera, CheckCircle2, Navigation, NotebookPen, Phone, Play, Square } from "lucide-react";

import { clockInNow, clockOutNow, completeVisit, startVisit, stopVisitTimer } from "./actions";
import { sendFiles } from "@/components/files/send-files";
import { Input } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { downscaleImage } from "@/lib/downscale-image";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- clock ---

export function ClockButtons({
  clockedIn,
  fromEarlier,
  defaultOutAt,
  maxOutAt,
}: {
  clockedIn: boolean;
  /** Still clocked in from an earlier day: ask when they actually stopped. */
  fromEarlier: boolean;
  defaultOutAt: string;
  maxOutAt: string;
}) {
  const [inState, clockIn] = useActionState<ActionState>(clockInNow, IDLE);
  const [outState, clockOut] = useActionState<ActionState, FormData>(clockOutNow, IDLE);

  if (!clockedIn) {
    return (
      <form action={clockIn} className="space-y-2">
        <SubmitButton size="lg" className="h-12 w-full text-base" pendingLabel="Clocking in…">
          <Play className="h-4 w-4" strokeWidth={2.25} />
          Clock in
        </SubmitButton>
        <ActionStatus state={inState} className="text-xs" />
      </form>
    );
  }

  return (
    <form action={clockOut} className="space-y-2">
      {fromEarlier ? (
        <div className="space-y-1.5">
          <label htmlFor="clock-out-at" className="block text-sm font-medium text-ink">
            When did you stop?
          </label>
          <Input id="clock-out-at" name="at" type="datetime-local" defaultValue={defaultOutAt} max={maxOutAt} required />
          {outState.fieldErrors?.at ? <p className="text-xs text-danger">{outState.fieldErrors.at}</p> : null}
        </div>
      ) : null}
      <SubmitButton variant="outline" size="lg" className="h-12 w-full text-base" pendingLabel="Clocking out…">
        <Square className="h-4 w-4" strokeWidth={2.25} />
        Clock out
      </SubmitButton>
      <ActionStatus state={outState} className="text-xs" />
    </form>
  );
}

export function StopTimerButton() {
  const [state, stop] = useActionState<ActionState>(stopVisitTimer, IDLE);
  return (
    <form action={stop}>
      <SubmitButton variant="outline" size="sm" pendingLabel="Stopping…">
        <Square className="h-3 w-3" strokeWidth={2.5} />
        Stop timer
      </SubmitButton>
      <ActionStatus state={state} className="mt-1 text-xs" />
    </form>
  );
}

// --------------------------------------------------------------- visits ---

const BIG =
  "flex h-16 flex-col items-center justify-center gap-1 rounded-lg border text-xs font-medium transition-colors disabled:opacity-60";
const PLAIN = "border-line-strong bg-surface text-ink hover:bg-surface-3";

function BigSubmit({
  children,
  pendingLabel,
  tone = "plain",
}: {
  children: React.ReactNode;
  pendingLabel: string;
  tone?: "plain" | "primary";
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(BIG, "w-full", tone === "primary" ? "border-brand bg-brand text-brand-ink hover:brightness-110" : PLAIN)}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

/**
 * The buttons on one visit, sized for a thumb in a work glove: where it is,
 * the customer's phone, the timer, a photo, a note, and done.
 */
export function VisitButtons({
  jobId,
  status,
  running,
  directions,
  phone,
  canPhoto,
  canComplete,
}: {
  jobId: string;
  status: string;
  /** This visit's timer is the one running. */
  running: boolean;
  directions: string | null;
  phone: string | null;
  canPhoto: boolean;
  canComplete: boolean;
}) {
  const [startState, start] = useActionState<ActionState, FormData>(startVisit, IDLE);
  const [stopState, stop] = useActionState<ActionState>(stopVisitTimer, IDLE);
  const [doneState, complete] = useActionState<ActionState, FormData>(completeVisit, IDLE);
  const [confirming, setConfirming] = useState(false);
  const completed = status === "COMPLETED";
  const status_ = [doneState, startState, stopState].find((s) => s.error) ?? IDLE;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {directions ? (
          <a href={directions} target="_blank" rel="noreferrer" className={cn(BIG, PLAIN)}>
            <Navigation className="h-5 w-5" strokeWidth={1.75} />
            Navigate
          </a>
        ) : null}
        {phone ? (
          <a href={`tel:${phone}`} className={cn(BIG, PLAIN)}>
            <Phone className="h-5 w-5" strokeWidth={1.75} />
            Call
          </a>
        ) : null}

        {completed ? null : running ? (
          <form action={stop}>
            <BigSubmit pendingLabel="Stopping…">
              <Square className="h-5 w-5" strokeWidth={1.75} />
              Stop timer
            </BigSubmit>
          </form>
        ) : (
          <form action={start}>
            <input type="hidden" name="jobId" value={jobId} />
            <BigSubmit pendingLabel="Starting…" tone={status === "IN_PROGRESS" ? "plain" : "primary"}>
              <Play className="h-5 w-5" strokeWidth={1.75} />
              {status === "IN_PROGRESS" ? "Timer" : "Start"}
            </BigSubmit>
          </form>
        )}

        {canPhoto ? <PhotoButton jobId={jobId} /> : null}

        <Link href={`/jobs/${jobId}#notes`} className={cn(BIG, PLAIN)}>
          <NotebookPen className="h-5 w-5" strokeWidth={1.75} />
          Note
        </Link>

        {canComplete && !completed ? (
          <form
            action={complete}
            onSubmit={(event) => {
              // A second tap, so a pocket cannot finish a job.
              if (!confirming) {
                event.preventDefault();
                setConfirming(true);
                setTimeout(() => setConfirming(false), 4000);
              }
            }}
          >
            <input type="hidden" name="jobId" value={jobId} />
            <BigSubmit pendingLabel="Saving…" tone={status === "IN_PROGRESS" ? "primary" : "plain"}>
              <CheckCircle2 className="h-5 w-5" strokeWidth={1.75} />
              {confirming ? "Tap to confirm" : "Complete"}
            </BigSubmit>
          </form>
        ) : null}
      </div>
      <ActionStatus state={status_} className="text-xs" />
    </div>
  );
}

/** Takes a photo with the phone's camera and files it on the job. */
function PhotoButton({ jobId }: { jobId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ActionState>(IDLE);
  const [pending, startTransition] = useTransition();

  const send = (list: FileList | null) => {
    const picked = [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
    if (picked.length === 0) return;
    startTransition(async () => {
      const shrunk = await Promise.all(picked.map((file) => downscaleImage(file)));
      const data = new FormData();
      data.set("entityType", "job");
      data.set("entityId", jobId);
      data.set("kind", "PHOTO");
      for (const file of shrunk) data.append("files", file);
      setState(await sendFiles(data, { entityType: "job", entityId: jobId }));
    });
  };

  return (
    <div className="contents">
      <button type="button" disabled={pending} onClick={() => input.current?.click()} className={cn(BIG, PLAIN)}>
        <Camera className="h-5 w-5" strokeWidth={1.75} />
        {pending ? "Saving…" : state.ok ? "Saved" : "Photo"}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="sr-only"
        aria-label="Take a photo for this job"
        onChange={(event) => {
          send(event.target.files);
          event.target.value = "";
        }}
      />
      {state.error ? <p className="col-span-3 text-xs text-danger">{state.error}</p> : null}
    </div>
  );
}
