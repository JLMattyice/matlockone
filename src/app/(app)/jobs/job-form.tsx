"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { Repeat } from "lucide-react";

import { createJob, updateJob } from "./actions";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import {
  Checkbox,
  Field,
  FormError,
  Input,
  Select,
  Textarea,
} from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  JOB_PRIORITIES,
  JOB_PRIORITY_META,
  JOB_STATUS_META,
  JOB_STATUSES,
  RECURRENCE_FREQUENCIES,
  type JobKind,
  type JobPriority,
  type JobStatus,
  type RecurrenceFrequency,
} from "@/lib/constants";
import { WEEKDAY_LABELS } from "@/lib/recurrence";
import { cn } from "@/lib/utils";

/** A group a job can be handed to, with the people it would bring. */
export type GroupOption = {
  id: string;
  name: string;
  memberIds: string[];
};

export type CrewOption = {
  id: string;
  name: string;
  position: string | null;
  role: string;
};

export type ClientPickerOption = {
  id: string;
  displayName: string;
  addresses: {
    id: string;
    label: string | null;
    line1: string;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    isPrimary: boolean;
  }[];
};

export type JobFormValues = {
  id?: string;
  kind: JobKind;
  title: string;
  description: string;
  clientId: string;
  addressId: string;
  status: JobStatus;
  priority: JobPriority;
  /** "YYYY-MM-DDTHH:mm" for a datetime-local input, or "". */
  scheduledStart: string;
  durationMinutes: number;
  allDay: boolean;
  assigneeIds: string[];
  groupId: string;
};

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 480];

export function JobForm({
  values,
  clients,
  crew,
  groups,
  jobLabel,
  canAssign,
}: {
  values: JobFormValues;
  clients: ClientPickerOption[];
  crew: CrewOption[];
  groups: GroupOption[];
  jobLabel: string;
  canAssign: boolean;
}) {
  const isEdit = Boolean(values.id);
  const [state, formAction] = useActionState<ActionState, FormData>(
    isEdit ? updateJob : createJob,
    IDLE,
  );

  const [kind, setKind] = useState<JobKind>(values.kind);
  const [clientId, setClientId] = useState(values.clientId);
  const [addressId, setAddressId] = useState(values.addressId);
  const [allDay, setAllDay] = useState(values.allDay);
  const [assignees, setAssignees] = useState<string[]>(values.assigneeIds);
  const [groupId, setGroupId] = useState(values.groupId);

  const [repeat, setRepeat] = useState(false);
  const [frequency, setFrequency] = useState<RecurrenceFrequency>("WEEKLY");
  const [weekdays, setWeekdays] = useState<number[]>([]);

  const err = (key: string) => state.fieldErrors?.[key];

  const addresses = useMemo(
    () => clients.find((c) => c.id === clientId)?.addresses ?? [],
    [clients, clientId],
  );

  // Changing client invalidates the address, so default to their primary one.
  function onClientChange(nextClientId: string) {
    setClientId(nextClientId);
    const next = clients.find((c) => c.id === nextClientId);
    setAddressId(next?.addresses.find((a) => a.isPrimary)?.id ?? "");
  }

  function toggleAssignee(id: string) {
    setAssignees((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );
  }

  /**
   * Handing the job to a group fills in its people, and leaves them editable.
   *
   * Additive rather than a replacement: somebody already picked for this job
   * is there for a reason, and silently dropping them when a group is chosen
   * would be a surprise on a screen about who is turning up.
   */
  function chooseGroup(nextGroupId: string) {
    setGroupId(nextGroupId);

    const group = groups.find((entry) => entry.id === nextGroupId);
    if (!group) return;

    setAssignees((current) => [
      ...current,
      ...group.memberIds.filter((id) => !current.includes(id)),
    ]);
  }

  function toggleWeekday(day: number) {
    setWeekdays((current) =>
      current.includes(day)
        ? current.filter((value) => value !== day)
        : [...current, day].sort((a, b) => a - b),
    );
  }

  const durations = DURATIONS.includes(values.durationMinutes)
    ? DURATIONS
    : [...DURATIONS, values.durationMinutes].sort((a, b) => a - b);

  return (
    <form action={formAction} className="space-y-6">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <input type="hidden" name="kind" value={kind} />
      {assignees.map((id) => (
        <input key={id} type="hidden" name="assigneeIds" value={id} />
      ))}
      <input type="hidden" name="groupId" value={groupId} />

      <FormError>{state.error}</FormError>

      <Card>
        <CardHeader
          title="What and where"
          description="The work itself, and the site it happens at."
        />

        <CardBody className="space-y-5">
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">Type</legend>
            <div className="flex gap-2">
              {(
                [
                  ["JOB", jobLabel, "Billable work at a site"],
                  ["APPOINTMENT", "Appointment", "A visit, estimate or check-in"],
                ] as const
              ).map(([option, label, hint]) => (
                <label
                  key={option}
                  title={hint}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition-colors",
                    kind === option
                      ? "border-brand bg-brand/8 font-medium text-brand"
                      : "border-line text-ink-muted hover:border-line-strong",
                  )}
                >
                  <input
                    type="radio"
                    checked={kind === option}
                    onChange={() => setKind(option)}
                    className="sr-only"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <Field label="Title" htmlFor="title" required error={err("title")}>
            <Input
              id="title"
              name="title"
              defaultValue={values.title}
              required
              autoFocus={!isEdit}
              placeholder="Quarterly service visit"
            />
          </Field>

          <Field
            label="Description"
            htmlFor="description"
            hint="What the team needs to know before they start."
          >
            <Textarea
              id="description"
              name="description"
              rows={3}
              defaultValue={values.description}
              placeholder="Client wants this wrapped up before their Friday opening."
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client" htmlFor="clientId">
              <Select
                id="clientId"
                name="clientId"
                value={clientId}
                onChange={(e) => onClientChange(e.target.value)}
              >
                <option value="">No client</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.displayName}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Location"
              htmlFor="addressId"
              hint={
                clientId && addresses.length === 0
                  ? "This client has no address on file."
                  : undefined
              }
            >
              <Select
                id="addressId"
                name="addressId"
                value={addressId}
                onChange={(e) => setAddressId(e.target.value)}
                disabled={!clientId || addresses.length === 0}
              >
                <option value="">No location</option>
                {addresses.map((address) => (
                  <option key={address.id} value={address.id}>
                    {[address.line1, address.city, address.state]
                      .filter(Boolean)
                      .join(", ")}
                    {address.isPrimary ? " (primary)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Schedule"
          description="Leave the date blank to park it in the unscheduled list."
        />

        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Starts"
              htmlFor="scheduledStart"
              error={err("scheduledStart")}
            >
              <Input
                id="scheduledStart"
                name="scheduledStart"
                type="datetime-local"
                defaultValue={values.scheduledStart}
              />
            </Field>

            <Field label="Duration" htmlFor="durationMinutes">
              <Select
                id="durationMinutes"
                name="durationMinutes"
                defaultValue={String(values.durationMinutes)}
                disabled={allDay}
              >
                {durations.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {formatDuration(minutes)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <label className="flex items-center gap-2.5 text-sm text-ink-muted">
            <Checkbox
              name="allDay"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
            />
            All-day — no specific arrival time
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority" htmlFor="priority">
              <Select
                id="priority"
                name="priority"
                defaultValue={values.priority}
              >
                {JOB_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {JOB_PRIORITY_META[priority].label}
                  </option>
                ))}
              </Select>
            </Field>

            {isEdit ? (
              <input type="hidden" name="status" value={values.status} />
            ) : (
              <Field
                label="Starting status"
                htmlFor="status"
                hint="Confirmed means the client has agreed the slot."
              >
                <Select id="status" name="status" defaultValue={values.status}>
                  {(["SCHEDULED", "CONFIRMED"] as const).map((status) => (
                    <option key={status} value={status}>
                      {JOB_STATUS_META[status].label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          {!isEdit ? (
            <div className="rounded-card border border-line bg-surface-2 p-4">
              <label className="flex items-center gap-2.5 text-sm font-medium text-ink">
                <Checkbox
                  name="repeat"
                  checked={repeat}
                  onChange={(e) => setRepeat(e.target.checked)}
                />
                <Repeat className="h-4 w-4 text-ink-subtle" strokeWidth={1.75} />
                Repeats
              </label>

              {repeat ? (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Every" htmlFor="interval">
                      <Input
                        id="interval"
                        name="interval"
                        type="number"
                        min={1}
                        max={52}
                        defaultValue={1}
                        className="tabular"
                      />
                    </Field>

                    <Field label="Period" htmlFor="frequency">
                      <Select
                        id="frequency"
                        name="frequency"
                        value={frequency}
                        onChange={(e) =>
                          setFrequency(e.target.value as RecurrenceFrequency)
                        }
                      >
                        {RECURRENCE_FREQUENCIES.map((option) => (
                          <option key={option} value={option}>
                            {option.charAt(0) + option.slice(1).toLowerCase()}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field
                      label="Occurrences"
                      htmlFor="occurrences"
                      hint="Up to 60"
                    >
                      <Input
                        id="occurrences"
                        name="occurrences"
                        type="number"
                        min={2}
                        max={60}
                        defaultValue={4}
                        className="tabular"
                      />
                    </Field>
                  </div>

                  {frequency === "WEEKLY" ? (
                    <fieldset>
                      <legend className="mb-2 text-sm font-medium text-ink">
                        On these days
                      </legend>
                      <div className="flex flex-wrap gap-1.5">
                        {WEEKDAY_LABELS.map((label, day) => (
                          <label
                            key={label}
                            className={cn(
                              "cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                              weekdays.includes(day)
                                ? "border-brand bg-brand/10 text-brand"
                                : "border-line text-ink-muted hover:border-line-strong",
                            )}
                          >
                            <input
                              type="checkbox"
                              name="byWeekday"
                              value={day}
                              checked={weekdays.includes(day)}
                              onChange={() => toggleWeekday(day)}
                              className="sr-only"
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-ink-subtle">
                        Leave all unchecked to repeat on the start day only.
                      </p>
                    </fieldset>
                  ) : null}

                  <p className="text-xs text-ink-subtle">
                    Each occurrence is created as its own {jobLabel.toLowerCase()},
                    so any one of them can be moved, reassigned or cancelled on
                    its own.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Assigned to"
          description={
            canAssign
              ? "The first person selected is the lead."
              : "Only a manager can change who is assigned."
          }
        />

        <CardBody className="space-y-5">
          {groups.length > 0 ? (
            <Field
              label="Group"
              htmlFor="groupId"
              hint={
                canAssign
                  ? "Who answers for this work. Choosing one adds its people below."
                  : "Only a manager can change the group."
              }
            >
              <Select
                id="groupId"
                value={groupId}
                onChange={(event) => chooseGroup(event.target.value)}
                disabled={!canAssign}
              >
                <option value="">No group</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {crew.length === 0 ? (
            <p className="text-sm text-ink-muted">No active team members.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {crew.map((member) => {
                const checked = assignees.includes(member.id);
                const leadIndex = assignees.indexOf(member.id);

                return (
                  <label
                    key={member.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                      checked
                        ? "border-brand bg-brand/6"
                        : "border-line hover:border-line-strong",
                      !canAssign && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!canAssign}
                      onChange={() => toggleAssignee(member.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {member.name}
                      </span>
                      {member.position ? (
                        <span className="block truncate text-xs text-ink-subtle">
                          {member.position}
                        </span>
                      ) : null}
                    </span>
                    {checked && leadIndex === 0 ? (
                      <span className="shrink-0 rounded-full bg-brand/12 px-2 py-0.5 text-[0.6875rem] font-medium text-brand">
                        Lead
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <Link
            href={values.id ? `/jobs/${values.id}` : "/jobs"}
            className={buttonClasses("ghost", "md")}
          >
            Cancel
          </Link>
          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Creating…"}>
            {isEdit ? "Save changes" : `Create ${jobLabel.toLowerCase()}`}
          </SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours === Math.floor(hours)
    ? `${hours} ${hours === 1 ? "hour" : "hours"}`
    : `${Math.floor(hours)}h ${minutes % 60}m`;
}
