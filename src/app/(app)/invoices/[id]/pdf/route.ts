import { requirePermission } from "@/lib/auth";
import { invoicePdfFor } from "@/lib/pdf/invoice-document";

/**
 * The invoice as a downloadable file.
 *
 * A route handler rather than a server action: the browser needs a real
 * response with headers it can save, and this is also the address the "Download
 * PDF" button points at.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { org } = await requirePermission("invoices:read");
  const { id } = await params;

  const document = await invoicePdfFor(org, id);
  if (!document) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(document.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      // `inline` so a click opens it in the viewer; the browser's own save
      // button is one step further, and looking is the commoner intent.
      "Content-Disposition": `inline; filename="${document.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
