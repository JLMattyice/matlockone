"use client";

import { useActionState, useState } from "react";

import {
  disconnectPaymentProcessor,
  savePaymentProcessor,
  testPaymentProcessor,
} from "./actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  PAYMENT_PROVIDER_META,
  PAYMENT_PROVIDERS,
  type CredentialField,
  type PaymentProviderId,
} from "@/lib/payments/catalog";

export type PaymentSettingsValues = {
  connected: boolean;
  provider: PaymentProviderId;
  config: Record<string, string>;
  hasStoredSecret: boolean;
  secretHint: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  canEncrypt: boolean;
  readOnly: boolean;
};

export function PaymentsForm({ values }: { values: PaymentSettingsValues }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    savePaymentProcessor,
    IDLE,
  );

  const [provider, setProvider] = useState<PaymentProviderId>(values.provider);

  const meta = PAYMENT_PROVIDER_META[provider];
  const disabled = values.readOnly;
  const err = (key: string) => state.fieldErrors?.[key];

  // Only the saved provider's stored secret is reusable — a Stripe key is not
  // a Square token, so switching providers always needs fresh credentials.
  const keepsSecret = values.hasStoredSecret && values.provider === provider;

  return (
    <div className="space-y-6">
      <StatusBanner values={values} />

      <form action={formAction} className="space-y-6">
        <Card>
          <CardHeader
            title="How clients pay you"
            description="Clients pay on your processor's own page, so card details never touch Matlock One — and someone at home can pay an invoice raised in the office."
          />

          <CardBody className="space-y-5">
            <Field label="Payment provider" htmlFor="provider">
              <Select
                id="provider"
                name="provider"
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as PaymentProviderId)
                }
                disabled={disabled}
              >
                {PAYMENT_PROVIDERS.map((id) => {
                  const option = PAYMENT_PROVIDER_META[id];
                  return (
                    <option key={id} value={id} disabled={!option.available}>
                      {option.label}
                      {option.available ? "" : " — not in this version yet"}
                    </option>
                  );
                })}
              </Select>
            </Field>

            <p className="text-sm text-ink-muted">{meta.description}</p>

            {meta.reconciles ? (
              <p className="text-sm text-ink-muted">
                Matlock One can ask {meta.label} what has been paid and record it
                against the invoice for you.
              </p>
            ) : (
              <p className="text-sm text-ink-muted">
                Matlock One cannot see what this link collects, so payments still
                get recorded by hand on the invoice.
              </p>
            )}

            {meta.available ? (
              <div className="space-y-4 border-t border-line pt-5">
                {meta.fields.map((field) => (
                  <ProviderField
                    key={`${provider}-${field.name}`}
                    field={field}
                    defaultValue={values.config[field.name] ?? ""}
                    keepsSecret={keepsSecret}
                    secretHint={values.secretHint}
                    error={err(field.name)}
                    disabled={disabled}
                  />
                ))}

                {meta.helpUrl ? (
                  <p className="text-xs text-ink-subtle">
                    These come from your {meta.label} dashboard:{" "}
                    <span className="font-mono break-all">{meta.helpUrl}</span>
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-ink-muted">
                {meta.label} is not wired up in this version yet. Pick another
                provider, or use your own payment link in the meantime.
              </p>
            )}
          </CardBody>

          {disabled || !meta.available ? null : (
            <CardFooter>
              <ActionStatus state={state} className="mr-auto" />
              <SubmitButton>
                {values.connected ? "Save changes" : "Connect"}
              </SubmitButton>
            </CardFooter>
          )}
        </Card>
      </form>

      {values.connected ? <TestCard readOnly={values.readOnly} /> : null}
    </div>
  );
}

function ProviderField({
  field,
  defaultValue,
  keepsSecret,
  secretHint,
  error,
  disabled,
}: {
  field: CredentialField;
  defaultValue: string;
  keepsSecret: boolean;
  secretHint: string | null;
  error?: string;
  disabled?: boolean;
}) {
  const storedNote =
    field.secret && keepsSecret
      ? `Saved and encrypted${secretHint ? ` (ends ${secretHint})` : ""}. Leave blank to keep it.`
      : field.hint;

  if (field.options) {
    return (
      <Field label={field.label} htmlFor={field.name} error={error} hint={field.hint}>
        <Select
          id={field.name}
          name={field.name}
          defaultValue={defaultValue || field.options[0]?.value}
          disabled={disabled}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  return (
    <Field
      label={field.label}
      htmlFor={field.name}
      hint={storedNote}
      error={error}
      required={!field.optional}
    >
      <Input
        id={field.name}
        name={field.name}
        type={field.secret ? "password" : "text"}
        autoComplete={field.secret ? "new-password" : "off"}
        // A stored secret is never sent back to the browser.
        defaultValue={field.secret ? "" : defaultValue}
        placeholder={
          field.secret && keepsSecret ? "••••••••••••" : (field.placeholder ?? "")
        }
        disabled={disabled}
      />
    </Field>
  );
}

function TestCard({ readOnly }: { readOnly: boolean }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    testPaymentProcessor,
    IDLE,
  );

  return (
    <Card>
      <CardHeader
        title="Check the connection"
        description="Confirm this works before an invoice depends on it."
      />

      <form action={formAction}>
        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          {readOnly ? null : (
            <SubmitButton variant="secondary" pendingLabel="Checking…">
              Test connection
            </SubmitButton>
          )}
        </CardFooter>
      </form>

      {readOnly ? null : (
        <CardFooter>
          <p className="mr-auto text-sm text-ink-muted">
            Stop offering online payment and delete any stored credentials.
            Links already sent keep working.
          </p>
          <form action={disconnectPaymentProcessor}>
            <Button type="submit" variant="ghost" size="sm">
              Disconnect
            </Button>
          </form>
        </CardFooter>
      )}
    </Card>
  );
}

function StatusBanner({ values }: { values: PaymentSettingsValues }) {
  const meta = PAYMENT_PROVIDER_META[values.provider];

  if (!values.canEncrypt) {
    return (
      <Note tone="danger">
        This installation has no encryption key, so processor credentials cannot
        be stored safely. Set <code className="font-mono">ENCRYPTION_KEY</code>{" "}
        and restart before connecting an account.
      </Note>
    );
  }

  if (!values.connected) {
    return (
      <Note tone="muted">
        No processor is connected. Invoices go out without a Pay now button, and
        payments are recorded by hand.
      </Note>
    );
  }

  if (values.lastTestOk === false) {
    return (
      <Note tone="danger">
        <span className="font-medium">The last check failed.</span>{" "}
        {values.lastError}
      </Note>
    );
  }

  if (values.lastTestOk) {
    return (
      <Note tone="success">
        <Badge tone="success">Connected</Badge> {meta.label}, checked{" "}
        {new Date(values.lastTestedAt!).toLocaleString()}.
      </Note>
    );
  }

  return (
    <Note tone="muted">
      Saved, but not checked yet. Test the connection to confirm it works.
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
