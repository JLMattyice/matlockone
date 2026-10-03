import { setRequestsEnabled } from "./actions";
import { CopyLink } from "@/app/(app)/estimates/[id]/estimate-actions";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit";
import { publicUrl } from "@/lib/messaging";

/**
 * The public "Request service" form: its address, a button to paste into the
 * business's own website, and the switch. Each request becomes a new lead.
 */
export function RequestsCard({
  slug,
  enabled,
  brandColor,
  writable,
}: {
  slug: string;
  enabled: boolean;
  brandColor: string;
  writable: boolean;
}) {
  const url = publicUrl(`/request/${slug}`);
  const button = `<a href="${url}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:${brandColor};color:#fff;font:600 15px sans-serif;text-decoration:none">Request service</a>`;

  return (
    <Card>
      <CardHeader
        title="Online requests"
        description="A form customers fill in to ask for work, with photos. Each request arrives as a new lead, and you're notified."
      />
      <CardBody className="space-y-4">
        {enabled ? (
          <>
            <div>
              <p className="mb-1.5 text-xs font-semibold tracking-wider text-ink-subtle uppercase">Your form</p>
              <CopyLink url={url} />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
                Button for your website
              </p>
              <CopyLink url={button} />
              <p className="mt-1.5 text-xs text-ink-subtle">
                Paste this into your website builder&apos;s HTML or embed block.
              </p>
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-muted">
            Turned off: the form says you aren&apos;t taking requests online and gives your phone
            and email instead.
          </p>
        )}
      </CardBody>
      {writable ? (
        <form action={setRequestsEnabled}>
          <input type="hidden" name="enabled" value={enabled ? "off" : "on"} />
          <CardFooter>
            <SubmitButton variant="outline" pendingLabel="Saving…">
              {enabled ? "Stop taking requests online" : "Take requests online"}
            </SubmitButton>
          </CardFooter>
        </form>
      ) : null}
    </Card>
  );
}
