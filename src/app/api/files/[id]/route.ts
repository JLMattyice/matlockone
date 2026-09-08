import { NextResponse, type NextRequest } from "next/server";

import { getContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readFile } from "@/lib/storage";

/**
 * Serves an uploaded file.
 *
 * The URL carries the attachment's *database id*, never a path. The row is
 * looked up scoped to the caller's organization and the bytes are read from the
 * `storagePath` we generated at upload time, so nothing a client sends can
 * select a file — and a signed-out or cross-tenant request gets the same 404 as
 * a missing file, revealing nothing about what exists.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getContext();
  if (!ctx) return new NextResponse("Not found", { status: 404 });

  const { id } = await params;

  const attachment = await prisma.attachment.findFirst({
    where: { id, organizationId: ctx.org.id },
    select: {
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      storagePath: true,
    },
  });
  if (!attachment) return new NextResponse("Not found", { status: 404 });

  const bytes = await readFile(attachment.storagePath);
  if (!bytes) return new NextResponse("Not found", { status: 404 });

  // Images and PDFs render in place; everything else downloads. The filename is
  // quoted and stripped of quotes so it cannot break out of the header.
  const inline =
    attachment.mimeType.startsWith("image/") ||
    attachment.mimeType === "application/pdf";

  const safeName = attachment.originalName.replace(/["\\\r\n]/g, "");
  const download = request.nextUrl.searchParams.has("download");

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(attachment.sizeBytes),
      "Content-Disposition": `${
        inline && !download ? "inline" : "attachment"
      }; filename="${safeName}"`,
      // Private: these are one tenant's files, never a shared cache's.
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
