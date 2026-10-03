import { submitUpload } from "@/app/(app)/files/actions";
import { failed, IDLE, type ActionState } from "@/lib/action-state";
import type { AttachmentEntityType } from "@/lib/attachment-entities";

/**
 * Sends the files, and prefers not to send them through the server.
 *
 * A hosted deployment runs on serverless functions whose request bodies are
 * capped at 4.5MB, well under the 15MB this form offers — so a photo from a
 * phone cannot reach the server as a form field at all. Where the store can
 * issue a presigned URL, the bytes go straight there and the server is told
 * afterwards, with a signed ticket it can check.
 *
 * Where it cannot — local disk, which is every desktop install — the original
 * FormData is submitted unchanged. That path has no body limit to avoid,
 * because the server is on the same machine.
 *
 * Called from a form's `action`, which is what keeps `useFormStatus` pending
 * for the whole of it: the uploads are the slow part, and a button that
 * stopped saying "Uploading…" while they ran would be lying.
 */
export async function sendFiles(
  formData: FormData,
  { entityType, entityId }: { entityType: AttachmentEntityType; entityId: string },
): Promise<ActionState> {
  const files = formData
    .getAll("files")
    .filter((value): value is File => value instanceof File && value.size > 0);

  if (files.length === 0) return failed("Choose a file to upload.");

  const tickets: string[] = [];

  for (const file of files) {
    let response: Response;
    try {
      response = await fetch("/api/files/upload-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType,
          entityId,
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        }),
      });
    } catch {
      return failed("Could not reach the server.");
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return failed(body?.error ?? "That file could not be uploaded.");
    }

    const ticket = await response.json();

    // The store cannot presign. Hand the whole form to the server untouched.
    if (!ticket.direct) return submitUpload(IDLE, formData);

    try {
      const put = await fetch(ticket.upload.url, {
        method: ticket.upload.method,
        headers: ticket.upload.headers,
        body: file,
      });
      if (!put.ok) {
        return failed(`${file.name} could not be uploaded.`);
      }
    } catch {
      return failed(`${file.name} could not be uploaded.`);
    }

    tickets.push(ticket.ticket);
  }

  // The bytes are already in the store; sending them again would defeat the
  // point and run straight back into the limit this avoids.
  formData.delete("files");
  formData.set("tickets", JSON.stringify(tickets));

  return submitUpload(IDLE, formData);
}
