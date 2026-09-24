"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";

import { startConversationAction } from "@/app/(app)/messages/actions";
import { Avatar } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Checkbox, Field, FormError, Input, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import { GROUP_TITLE_MAX_LENGTH, MESSAGE_MAX_LENGTH } from "@/lib/chat";

type Teammate = {
  id: string;
  name: string;
  avatarUrl: string | null;
  position: string | null;
};

/**
 * Pick who it is for, optionally say something.
 *
 * Every field is controlled. A form action resets uncontrolled fields when it
 * returns, so a refused submit would otherwise wipe the message somebody had
 * just typed. The picked people travel as hidden inputs rather than as the
 * checkboxes themselves, because the search box hides rows — and a hidden
 * checkbox would quietly drop that person from the conversation.
 */
export function NewConversationForm({
  people,
  preselected,
}: {
  people: Teammate[];
  preselected: string[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    startConversationAction,
    IDLE,
  );
  const [picked, setPicked] = useState<string[]>(preselected);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? people.filter(
        (person) =>
          person.name.toLowerCase().includes(needle) ||
          person.position?.toLowerCase().includes(needle),
      )
    : people;

  const pickedPeople = people.filter((person) => picked.includes(person.id));
  const isGroup = pickedPeople.length >= 2;

  function toggle(id: string) {
    setPicked((current) =>
      current.includes(id) ? current.filter((other) => other !== id) : [...current, id],
    );
  }

  const summary =
    pickedPeople.length === 0
      ? "Pick who it is for."
      : pickedPeople.length === 1
        ? `Opens your conversation with ${pickedPeople[0].name.split(/\s+/)[0]}.`
        : `A group of ${pickedPeople.length + 1}, including you.`;

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Link
          href="/messages"
          aria-label="All messages"
          className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink lg:hidden"
        >
          <ArrowLeft className="h-4.5 w-4.5" strokeWidth={1.75} />
        </Link>
        <h2 className="text-sm font-semibold text-ink">New message</h2>
      </div>

      <form action={formAction} className="flex min-h-0 flex-1 flex-col">
        {picked.map((id) => (
          <input key={id} type="hidden" name="memberIds" value={id} />
        ))}

        <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <FormError>{state.error}</FormError>

          <Field label="To" htmlFor="people-search" error={state.fieldErrors?.memberIds}>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-subtle"
                strokeWidth={1.75}
                aria-hidden
              />
              <Input
                id="people-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search the team"
                autoComplete="off"
                className="pl-9"
              />
            </div>
          </Field>

          {pickedPeople.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Picked">
              {pickedPeople.map((person) => (
                <li key={person.id}>
                  <button
                    type="button"
                    onClick={() => toggle(person.id)}
                    className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 py-0.5 pr-2.5 pl-0.5 text-xs font-medium text-brand transition-colors hover:bg-brand/15"
                    aria-label={`Remove ${person.name}`}
                  >
                    <Avatar name={person.name} imageUrl={person.avatarUrl} size="sm" className="h-5 w-5 text-[0.5rem]" />
                    {person.name}
                    <span aria-hidden>×</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {visible.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-sm text-ink-muted">
              Nobody on the team matches “{query.trim()}”.
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {visible.map((person) => (
                <li key={person.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-2">
                    <Checkbox
                      checked={picked.includes(person.id)}
                      onChange={() => toggle(person.id)}
                    />
                    <Avatar name={person.name} imageUrl={person.avatarUrl} size="sm" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink">{person.name}</span>
                      {person.position ? (
                        <span className="block truncate text-xs text-ink-subtle">
                          {person.position}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {isGroup ? (
            <Field
              label="Group name"
              htmlFor="title"
              hint="Optional. Without one, the group goes by the names of the people in it."
            >
              <Input
                id="title"
                name="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={GROUP_TITLE_MAX_LENGTH}
                placeholder="Northside crew"
              />
            </Field>
          ) : null}

          <Field label="Message" htmlFor="body" error={state.fieldErrors?.body}>
            <Textarea
              id="body"
              name="body"
              rows={3}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={MESSAGE_MAX_LENGTH}
              placeholder="Optional — you can write it in the conversation instead."
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          <p className="min-w-0 text-xs text-ink-muted">{summary}</p>
          <SubmitButton
            pendingLabel="Opening…"
            {...(pickedPeople.length === 0 ? { disabled: true } : {})}
          >
            {isGroup ? "Start group" : body.trim() ? "Send" : "Open conversation"}
          </SubmitButton>
        </div>
      </form>
    </Card>
  );
}
