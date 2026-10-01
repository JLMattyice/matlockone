"use client";

import { useActionState, useState } from "react";
import { CalendarPlus, Check, Copy } from "lucide-react";

import {
  resetCalendarFeed,
  turnOffCalendarFeed,
  turnOnCalendarFeed,
} from "./calendar-feed-actions";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

/**
 * Settings → Your profile: the private link that puts this person's schedule
 * into Google, Outlook or Apple Calendar.
 *
 * On the profile page rather than Settings → Calendar because everybody has a
 * schedule and only managers can open the business settings. Somebody who can
 * see the whole schedule gets a second link for it beside their own.
 */
export function CalendarFeedCard({
  addresses,
  canSeeAll,
  jobPlural,
  businessName,
  online,
}: {
  /** Null until the link is turned on. */
  addresses: { mine: string; all: string } | null;
  canSeeAll: boolean;
  jobPlural: string;
  businessName: string;
  /** False on a copy whose data stays on this computer: Google cannot reach it. */
  online: boolean;
}) {
  const [onState, turnOn] = useActionState<ActionState>(turnOnCalendarFeed, IDLE);
  const [resetState, reset] = useActionState<ActionState>(resetCalendarFeed, IDLE);
  const [offState, turnOff] = useActionState<ActionState>(turnOffCalendarFeed, IDLE);

  const status = [resetState, offState, onState].find((s) => s.message || s.error) ?? IDLE;

  return (
    <Card id="calendar-feed" className="scroll-mt-20">
      <CardHeader
        title="Your schedule in your calendar app"
        description="Puts what you are booked on into Google Calendar, Outlook or your iPhone, and keeps it up to date. It works one way: changes are still made here."
      />

      <CardBody className="space-y-5">
        {!online ? (
          <p className="text-sm text-ink-muted">
            Calendar links need your online Matlock One account. This copy keeps
            its data on this computer, where Google and Outlook cannot reach it.
          </p>
        ) : !addresses ? (
          <form action={turnOn} className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingLabel="Turning on…">
              <CalendarPlus className="h-4 w-4" strokeWidth={2} />
              Turn on calendar link
            </SubmitButton>
            <ActionStatus state={status} />
          </form>
        ) : (
          <>
            <FeedRow
              title={canSeeAll ? `Just my ${jobPlural.toLowerCase()}` : "Your schedule"}
              hint={
                canSeeAll
                  ? "Only what you are assigned to."
                  : "Everything you are assigned to."
              }
              url={addresses.mine}
              name={businessName}
            />
            {canSeeAll ? (
              <FeedRow
                title="The whole schedule"
                hint="Everything booked for the business, whoever is on it."
                url={addresses.all}
                name={businessName}
              />
            ) : null}

            <div className="space-y-1.5 rounded-lg bg-surface-2 px-3.5 py-3 text-xs text-ink-muted">
              <p>
                <span className="font-medium text-ink">To add it by hand:</span>{" "}
                in Google Calendar, press + beside &ldquo;Other calendars&rdquo;,
                choose &ldquo;From URL&rdquo; and paste the link. In Outlook,
                choose Add calendar, then Subscribe from web.
              </p>
              <p>
                Google checks for changes every few hours, Apple and Outlook
                about once an hour, so a new booking can take a while to appear.
              </p>
              <p>
                Anyone who has the link can see what is in it. If it was shared
                by mistake, make a new one below and the old one stops working.
              </p>
            </div>
          </>
        )}
      </CardBody>

      {online && addresses ? (
        <CardFooter className="flex flex-wrap items-center gap-2">
          <form action={reset}>
            <ConfirmButton
              variant="outline"
              size="sm"
              confirmLabel="Old link stops working. Sure?"
              pendingLabel="Making a new link…"
            >
              Make a new link
            </ConfirmButton>
          </form>
          <form action={turnOff}>
            <ConfirmButton
              variant="ghost"
              size="sm"
              confirmLabel="Turn off the link?"
              pendingLabel="Turning off…"
            >
              Turn off
            </ConfirmButton>
          </form>
          <ActionStatus state={status} className="ml-1" />
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** One feed: its address to copy, and a button for each calendar app. */
function FeedRow({
  title,
  hint,
  url,
  name,
}: {
  title: string;
  hint: string;
  url: string;
  name: string;
}) {
  const [copied, setCopied] = useState(false);
  const webcal = url.replace(/^https?:\/\//, "webcal://");

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the field beside it selects on focus.
    }
  }

  const apps = [
    {
      label: "Google Calendar",
      href: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
    },
    {
      label: "Outlook",
      href: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
    },
    { label: "Apple Calendar", href: webcal },
  ];

  return (
    <section className="space-y-2">
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="text-xs text-ink-subtle">{hint}</p>
      </div>

      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={`${title} calendar link`}
          className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 font-mono text-xs text-ink-muted"
        />
        <button type="button" onClick={copy} className={buttonClasses("outline", "sm")}>
          {copied ? (
            <Check className="h-3.5 w-3.5" strokeWidth={2} />
          ) : (
            <Copy className="h-3.5 w-3.5" strokeWidth={2} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {apps.map((app) => (
          <a
            key={app.label}
            href={app.href}
            target="_blank"
            rel="noreferrer"
            className={buttonClasses("ghost", "sm")}
          >
            Add to {app.label}
          </a>
        ))}
      </div>
    </section>
  );
}
