"use client";

import Link from "next/link";
import { useActionState } from "react";

import { createTask, deleteTask, setTaskDone } from "@/app/(app)/tasks/actions";
import { buttonClasses } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { cn } from "@/lib/utils";

/**
 * A list of things to do, with a box to add another.
 *
 * Every row is its own form posting a server action, so ticking something off
 * works before hydration and needs no client state of its own — the list is
 * whatever the server last rendered.
 */

export type TaskItem = {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  dueAt: Date | null;
  completedAt: Date | null;
  assignedTo: { id: string; name: string } | null;
  client: { id: string; displayName: string } | null;
  job: { id: string; number: string; title: string } | null;
  lead: { id: string; name: string } | null;
};

export function TaskList({
  tasks,
  people,
  canWrite,
  /** Pre-set links, so a task added from a job belongs to that job. */
  jobId,
  clientId,
  leadId,
  showContext = true,
  emptyTitle = "Nothing to do",
  emptyDescription = "Add the next thing that needs doing and it will show up here.",
}: {
  tasks: TaskItem[];
  people: { id: string; name: string }[];
  canWrite: boolean;
  jobId?: string;
  clientId?: string;
  leadId?: string;
  /** False on a job or client page, where the link is where you already are. */
  showContext?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    createTask,
    IDLE,
  );

  return (
    <div>
      {canWrite ? (
        <form
          action={formAction}
          className="flex flex-wrap items-end gap-2 border-b border-line px-5 py-4"
        >
          {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
          {clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
          {leadId ? <input type="hidden" name="leadId" value={leadId} /> : null}

          <Field
            label="What needs doing?"
            htmlFor="title"
            className="min-w-55 flex-1"
            error={state.fieldErrors?.title}
          >
            <Input
              id="title"
              name="title"
              required
              placeholder="Ring the supplier about the part"
            />
          </Field>

          <Field label="Due" htmlFor="dueAt" className="w-40">
            <Input id="dueAt" name="dueAt" type="date" />
          </Field>

          <Field label="Who" htmlFor="assignedToId" className="w-44">
            <Select id="assignedToId" name="assignedToId" defaultValue="">
              <option value="">Anyone</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <SubmitButton pendingLabel="Adding…">Add</SubmitButton>
        </form>
      ) : null}

      {tasks.length === 0 ? (
        <EmptyState
          icon={<CheckSquare />}
          title={emptyTitle}
          description={emptyDescription}
        />
      ) : (
        <ul className="divide-y divide-line">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              canWrite={canWrite}
              showContext={showContext}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskRow({
  task,
  canWrite,
  showContext,
}: {
  task: TaskItem;
  canWrite: boolean;
  showContext: boolean;
}) {
  const done = task.status === "DONE";
  const overdue = !done && task.dueAt !== null && task.dueAt < new Date();

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <form action={setTaskDone} className="pt-0.5">
        <input type="hidden" name="id" value={task.id} />
        <input type="hidden" name="done" value={done ? "false" : "true"} />
        <button
          type="submit"
          disabled={!canWrite}
          aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
          className={cn(
            "flex h-4.5 w-4.5 items-center justify-center rounded border transition-colors",
            done
              ? "border-success bg-success text-white"
              : "border-line-strong hover:border-brand",
            !canWrite && "cursor-not-allowed opacity-60",
          )}
        >
          {done ? <Tick /> : null}
        </button>
      </form>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm",
            done ? "text-ink-subtle line-through" : "text-ink",
          )}
        >
          {task.title}
        </p>

        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {task.dueAt ? (
            <span className={overdue ? "font-medium text-danger" : "text-ink-subtle"}>
              {overdue ? "Overdue · " : "Due "}
              {task.dueAt.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
          ) : null}

          {task.assignedTo ? (
            <span className="text-ink-subtle">{task.assignedTo.name}</span>
          ) : (
            <span className="text-ink-subtle">Unassigned</span>
          )}

          {showContext && task.job ? (
            <Link
              href={`/jobs/${task.job.id}`}
              className="text-brand hover:underline"
            >
              {task.job.number}
            </Link>
          ) : null}

          {showContext && !task.job && task.client ? (
            <Link
              href={`/clients/${task.client.id}`}
              className="text-brand hover:underline"
            >
              {task.client.displayName}
            </Link>
          ) : null}

          {showContext && task.lead ? (
            <Link
              href={`/leads/${task.lead.id}`}
              className="text-brand hover:underline"
            >
              {task.lead.name}
            </Link>
          ) : null}
        </p>

        {task.notes ? (
          <p className="mt-1 text-xs text-ink-muted">{task.notes}</p>
        ) : null}
      </div>

      {canWrite ? (
        <form action={deleteTask}>
          <input type="hidden" name="id" value={task.id} />
          <button
            type="submit"
            className={cn(buttonClasses("ghost", "sm"), "text-ink-subtle")}
            aria-label={`Delete ${task.title}`}
          >
            <Cross />
          </button>
        </form>
      ) : null}
    </li>
  );
}

/* Small inline marks rather than an icon import each: these three are the
   only ones this file needs, and they never change with the icon set. */

function Tick() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden>
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Cross() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckSquare() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M8 12.5l2.5 2.5L16 9"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
