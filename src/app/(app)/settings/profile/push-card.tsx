"use client";

import { useEffect, useState, useTransition } from "react";
import { BellRing } from "lucide-react";

import { removePushSubscription, savePushSubscription, sendTestPush } from "./push-actions";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

type Status =
  | "checking"
  /** No push in this browser — an iPhone outside the home-screen app, mostly. */
  | "unsupported"
  | "iphone"
  /** The person said no when the browser asked; only they can undo that. */
  | "blocked"
  | "off"
  | "on";

/** The key from the server, in the form the browser's subscribe call wants. */
function keyBytes(base64url: string) {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function registration() {
  // Registered for every page by the app shell; this waits for it to be live.
  return navigator.serviceWorker.ready;
}

/**
 * Settings → Your profile: notifications on this phone or computer.
 *
 * Each device is turned on by itself — the browser asks permission on the
 * device, and nowhere else can. So this card describes this device only.
 */
export function PushCard({ publicKey }: { publicKey: string }) {
  const [status, setStatus] = useState<Status>("checking");
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    (async () => {
      const supported =
        "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      if (!supported) {
        // iPhones and iPads only offer push to a site added to the Home Screen.
        const apple = /iPhone|iPad|iPod/.test(navigator.userAgent);
        if (live) setStatus(apple ? "iphone" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        if (live) setStatus("blocked");
        return;
      }
      const existing = await (await registration()).pushManager.getSubscription();
      if (live) setStatus(existing ? "on" : "off");
    })().catch(() => live && setStatus("unsupported"));
    return () => {
      live = false;
    };
  }, []);

  const turnOn = () =>
    startTransition(async () => {
      setNote(null);
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "blocked" : "off");
        return;
      }
      try {
        const reg = await registration();
        const subscription =
          (await reg.pushManager.getSubscription()) ??
          (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
        const saved = await savePushSubscription(subscription.toJSON(), navigator.userAgent);
        if (!saved.ok) {
          await subscription.unsubscribe();
          setNote(saved.error ?? "That did not work. Try again in a moment.");
          return;
        }
        setStatus("on");
      } catch {
        setNote("This browser would not turn notifications on. Try again in a moment.");
      }
    });

  const turnOff = () =>
    startTransition(async () => {
      setNote(null);
      const subscription = await (await registration()).pushManager.getSubscription();
      if (subscription) {
        await removePushSubscription(subscription.endpoint);
        await subscription.unsubscribe().catch(() => false);
      }
      setStatus("off");
    });

  const test = () =>
    startTransition(async () => {
      const result = await sendTestPush();
      setNote(result.ok ? "Sent — it should arrive in a few seconds." : "Nothing went out. Turn notifications off and on again.");
    });

  return (
    <Card>
      <CardHeader
        title="Notifications on this device"
        description="A buzz on your phone when you are put on a job, your schedule moves, a teammate messages you, a customer accepts an estimate or pays, or a new request comes in."
      />
      <CardBody className="space-y-4">
        {status === "checking" ? (
          <p className="text-sm text-ink-muted">Checking this device…</p>
        ) : status === "iphone" ? (
          <p className="text-sm text-ink-muted">
            On an iPhone or iPad, add Matlock One to your Home Screen first: tap Share, then
            “Add to Home Screen”. Open it from there and turn notifications on here.
          </p>
        ) : status === "unsupported" ? (
          <p className="text-sm text-ink-muted">
            This browser cannot receive notifications. Chrome, Edge, Firefox and Safari can.
          </p>
        ) : status === "blocked" ? (
          <p className="text-sm text-ink-muted">
            Notifications are blocked for Matlock One in this browser. Allow them in the
            browser’s site settings (the icon left of the address), then come back here.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <BellRing
              className={status === "on" ? "h-5 w-5 text-brand" : "h-5 w-5 text-ink-subtle"}
              strokeWidth={1.75}
            />
            <p className="mr-auto text-sm text-ink">
              {status === "on" ? "On for this device." : "Off for this device."}
            </p>
            {status === "on" ? (
              <>
                <Button type="button" variant="outline" size="sm" onClick={test} disabled={pending}>
                  Send a test
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={turnOff} disabled={pending}>
                  Turn off
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" onClick={turnOn} disabled={pending}>
                {pending ? "Turning on…" : "Turn on"}
              </Button>
            )}
          </div>
        )}
        {note ? <p className="text-sm text-ink-muted" role="status">{note}</p> : null}
      </CardBody>
    </Card>
  );
}
