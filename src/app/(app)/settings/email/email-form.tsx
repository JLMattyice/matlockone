"use client";

import { useActionState, useState } from "react";

import {
  disconnectEmailAccount,
  saveEmailAccount,
  sendTestEmail,
} from "./actions";
import { Badge } from "@/components/ui/badge";
import { PasswordInput } from "@/components/ui/password-input";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  EMAIL_PROVIDER_META,
  impliedSecure,
  presetForHost,
  reconcileSecure,
  SMTP_PRESETS,
  type EmailProviderId,
  type SmtpPresetId,
} from "@/lib/email/catalog";

export type EmailAccountValues = {
  connected: boolean;
  provider: EmailProviderId;
  fromName: string;
  fromEmail: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  secretHint: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  testRecipient: string;
  canEncrypt: boolean;
  readOnly: boolean;
};

export function EmailForm({ values }: { values: EmailAccountValues }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    saveEmailAccount,
    IDLE,
  );

  const [provider, setProvider] = useState<EmailProviderId>(values.provider);
  const [host, setHost] = useState(values.host);
  const [port, setPort] = useState(String(values.port));
  // Opens corrected when the stored pair cannot work, so somebody who saved a
  // contradiction once is not asked to spot it themselves — the screen simply
  // shows the settings that do work, ready to save.
  const [secure, setSecure] = useState(() =>
    reconcileSecure(values.port, values.secure),
  );
  // Reopening a saved account on "Other" hid the very guidance that account
  // needed, so the saved host chooses the preset.
  const [presetId, setPresetId] = useState(() => presetForHost(values.host));

  const disabled = values.readOnly || !values.canEncrypt;
  const err = (key: string) => state.fieldErrors?.[key];
  const meta = EMAIL_PROVIDER_META[provider];

  // Only meaningful for the provider currently in the form: an SMTP password
  // is not a Resend key, so switching providers requires a new credential.
  const hasStoredSecret = values.connected && values.provider === provider;

  const preset =
    SMTP_PRESETS.find((p) => p.id === presetId) ?? SMTP_PRESETS.at(-1)!;

  /**
   * Typing a port moves the encryption setting with it.
   *
   * They are two halves of one decision, and the settings screen used to let
   * them disagree — which is how a working Hostinger account was saved as port
   * 587 with implicit TLS on, and failed with an OpenSSL error.
   */
  function onPortChange(next: string) {
    setPort(next);

    const parsed = Number(next);
    if (Number.isInteger(parsed) && parsed > 0) setSecure(impliedSecure(parsed));
  }

  function applyPreset(id: string) {
    setPresetId(id as SmtpPresetId);

    const chosen = SMTP_PRESETS.find((p) => p.id === id);
    // "Other" keeps whatever is typed; the rest fill the server details in.
    if (!chosen || chosen.id === "custom") return;
    setHost(chosen.host);
    setPort(String(chosen.port));
    setSecure(chosen.secure);
  }

  return (
    <div className="space-y-6">
      <StatusBanner values={values} />

      <form action={formAction} className="space-y-6">
        <Card>
          <CardHeader
            title="Sending account"
            description="Estimates, invoices and reminders go out from here. The account stays yours — Matlock One only borrows it to send."
          />

          <CardBody className="space-y-5">
            <Field label="How do you want to send?" htmlFor="provider">
              <Select
                id="provider"
                name="provider"
                value={provider}
              onChange={(event) =>
                  setProvider(event.target.value as EmailProviderId)
                }
                disabled={disabled}
              >
                <option value="SMTP">{EMAIL_PROVIDER_META.SMTP.label}</option>
                <option value="RESEND">{EMAIL_PROVIDER_META.RESEND.label}</option>
              </Select>
            </Field>

            <p className="text-sm text-ink-muted">{meta.description}</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="From name"
                htmlFor="fromName"
                hint="What clients see in their inbox."
                error={err("fromName")}
                required
              >
                <Input
                  id="fromName"
                  name="fromName"
                  defaultValue={values.fromName}
                  placeholder="Northside Services"
                  disabled={disabled}
                />
              </Field>

              <Field
                label="From address"
                htmlFor="fromEmail"
                hint="Replies come back to this address."
                error={err("fromEmail")}
                required
              >
                <Input
                  id="fromEmail"
                  name="fromEmail"
                  type="email"
                  defaultValue={values.fromEmail}
                  placeholder="office@example.com"
                  disabled={disabled}
                />
              </Field>
            </div>

            {provider === "SMTP" ? (
              <div className="space-y-4 border-t border-line pt-5">
                <Field
                  label="Email provider"
                  htmlFor="preset"
                  hint="Pick yours to fill in the server details, or choose Other."
                >
                  <Select
                    id="preset"
                    value={presetId}
                    onChange={(event) => applyPreset(event.target.value)}
                    disabled={disabled}
                  >
                    {SMTP_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </Select>
                </Field>

                <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
                  <Field
                    label="Outgoing server"
                    htmlFor="host"
                    error={err("host")}
                    required
                  >
                    <Input
                      id="host"
                      name="host"
                      value={host}
                      onChange={(event) => setHost(event.target.value)}
                      placeholder="smtp.gmail.com"
                      disabled={disabled}
                      className="font-mono"
                    />
                  </Field>

                  <Field label="Port" htmlFor="port" error={err("port")}>
                    <Input
                      id="port"
                      name="port"
                      type="number"
                      min={1}
                      max={65535}
                      value={port}
                      onChange={(event) => onPortChange(event.target.value)}
                      disabled={disabled}
                      className="tabular"
                    />
                  </Field>
                </div>

                <label className="flex items-start gap-2.5 text-sm text-ink">
                  <Checkbox
                    name="secure"
                    checked={secure}
                    onChange={(event) => setSecure(event.target.checked)}
                    disabled={disabled}
                    className="mt-0.5"
                  />
                  <span>
                    Use SSL/TLS from the start
                    <span className="block text-xs text-ink-subtle">
                      Normally on for port 465 and off for 587, which upgrades to
                      an encrypted connection after connecting.
                    </span>
                  </span>
                </label>

                <Field
                  label="Username"
                  htmlFor="username"
                  hint="Usually your full email address."
                  error={err("username")}
                  required
                >
                  <Input
                    id="username"
                    name="username"
                    autoComplete="off"
                    defaultValue={values.username}
                    placeholder="office@example.com"
                    disabled={disabled}
                  />
                </Field>
              </div>
            ) : null}

            <Field
              label={meta.secretLabel}
              htmlFor="secret"
            hint={
                hasStoredSecret
                ? `Saved and encrypted (ends ${values.secretHint}). Leave blank to keep it.`
                : meta.secretHint
              }
              error={err("secret")}
            >
              <PasswordInput
                id="secret"
                name="secret"
                autoComplete="new-password"
                placeholder={hasStoredSecret ? "••••••••••••" : ""}
                disabled={disabled}
              />
            </Field>

            {provider === "SMTP" && !hasStoredSecret ? (
              <p className="rounded-lg border border-line bg-surface-muted px-3.5 py-2.5 text-xs text-ink-muted">
                <span className="font-medium text-ink">
                  {preset.label}
                </span>
                <span className="mt-0.5 block">{preset.credential}</span>
              </p>
            ) : null}
          </CardBody>

          {disabled ? null : (
            <CardFooter>
              <ActionStatus state={state} className="mr-auto" />
              <SubmitButton>
                {values.connected ? "Save changes" : "Connect"}
              </SubmitButton>
            </CardFooter>
          )}
        </Card>
      </form>

      {values.connected ? (
        <TestCard recipient={values.testRecipient} readOnly={values.readOnly} />
      ) : null}
    </div>
  );
}

/** Proves the credentials work before a real client is on the receiving end. */
function TestCard({
  recipient,
  readOnly,
}: {
  recipient: string;
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    sendTestEmail,
    IDLE,
  );

  return (
    <Card>
      <CardHeader
        title="Send a test"
        description="Confirm the connection works before an estimate depends on it."
      />

      <form action={formAction}>
        <CardBody>
          <Field label="Send to" htmlFor="to" error={state.fieldErrors?.to}>
            <Input
              id="to"
              name="to"
              type="email"
              defaultValue={recipient}
              disabled={readOnly}
            />
          </Field>
        </CardBody>

        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          {readOnly ? null : (
            <SubmitButton variant="secondary" pendingLabel="Sending…">
              Send test email
            </SubmitButton>
          )}
        </CardFooter>
      </form>

      {readOnly ? null : (
        <CardFooter>
          <p className="mr-auto text-sm text-ink-muted">
            Stop sending from this account and delete the stored credential.
          </p>
          <form action={disconnectEmailAccount}>
            <Button type="submit" variant="ghost" size="sm">
              Disconnect
            </Button>
          </form>
        </CardFooter>
      )}
    </Card>
  );
}

function StatusBanner({ values }: { values: EmailAccountValues }) {
  if (!values.canEncrypt) {
    return (
      <Note tone="danger">
        This installation has no encryption key, so credentials cannot be stored
        safely. Set <code className="font-mono">ENCRYPTION_KEY</code> and restart
        before connecting an account.
      </Note>
    );
  }

  if (!values.connected) {
    return (
      <Note tone="muted">
        No account is connected yet. Estimates and invoices you send are saved to
        the outbox but are not delivered.
      </Note>
    );
  }

  if (values.lastTestOk === false) {
    return (
      <Note tone="danger">
        <span className="font-medium">The last test failed.</span>{" "}
        {values.lastError}
      </Note>
    );
  }

  if (values.lastTestOk) {
    return (
      <Note tone="success">
        <Badge tone="success">Connected</Badge> Last tested{" "}
        {new Date(values.lastTestedAt!).toLocaleString()}.
      </Note>
    );
  }

  return (
    <Note tone="muted">
      Saved, but not tested yet. Send a test email to confirm it works.
    </Note>
  );
}

function Note({
  tone,
  children,
}: {
  tone: "muted" | "success" | "danger";
  children: React.ReactNode;
}) {
  const tones = {
    muted: "border-line bg-surface-muted text-ink-muted",
    success: "border-success/30 bg-success/5 text-ink",
    danger: "border-danger/30 bg-danger/5 text-ink",
  } as const;

  return (
    <p
      className={`flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}
    >
      {children}
    </p>
  );
}
