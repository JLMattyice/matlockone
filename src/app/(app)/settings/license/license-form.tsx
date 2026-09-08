"use client";

import { useActionState } from "react";

import { activateLicense } from "./actions";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Textarea } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";

export function LicenseForm({ licensed }: { licensed: boolean }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    activateLicense,
    IDLE,
  );

  return (
    <form action={formAction}>
      <Card>
        <CardHeader
          title={licensed ? "Replace your licence key" : "Enter your licence key"}
          description="It arrives by email when you subscribe, and starts with MO1."
        />
        <CardBody>
          <Field
            label="Licence key"
            htmlFor="licenseKey"
            error={state.fieldErrors?.licenseKey}
            hint="Paste the whole thing. Line breaks from your mail app are fine."
          >
            <Textarea
              id="licenseKey"
              name="licenseKey"
              rows={4}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              placeholder="MO1.…"
            />
          </Field>
        </CardBody>
        <CardFooter>
          <ActionStatus state={state} className="mr-auto" />
          <SubmitButton pendingLabel="Checking…">
            {licensed ? "Replace licence" : "Activate"}
          </SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}

export function RemoveLicenseButton({
  action,
}: {
  action: () => void | Promise<void>;
}) {
  return (
    <form action={action}>
      <Button type="submit" variant="outline" size="sm">
        Remove licence
      </Button>
    </form>
  );
}
