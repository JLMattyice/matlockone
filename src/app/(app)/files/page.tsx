import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { Download, FileText, FolderClosed, Trash2 } from "lucide-react";

import { deleteAttachment } from "./actions";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { like } from "@/lib/search";
import { formatBytes, isImageMime } from "@/lib/storage-limits";
import type { Prisma } from "@/generated/prisma/client";

export const metadata: Metadata = { title: "Files" };

const PAGE_SIZE = 40;

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kind?: string; page?: string }>;
}) {
  const { user, org } = await requirePermission("files:read");
  const params = await searchParams;
  const page = Math.max(Number(params.page) || 1, 1);
  const q = params.q?.trim();

  const where: Prisma.AttachmentWhereInput = {
    organizationId: org.id,
    ...(params.kind ? { kind: params.kind } : {}),
    ...(q
      ? {
          OR: [
            { originalName: like(q) },
            { caption: like(q) },
            { client: { displayName: like(q) } },
            { job: { title: like(q) } },
            { job: { number: like(q) } },
          ],
        }
      : {}),
  };

  const [total, rows, sizeSum] = await Promise.all([
    prisma.attachment.count({ where }),
    prisma.attachment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        uploadedBy: { select: { name: true } },
        client: { select: { id: true, displayName: true } },
        job: { select: { id: true, number: true, title: true } },
        lead: { select: { id: true, name: true } },
        estimate: { select: { id: true, number: true } },
        invoice: { select: { id: true, number: true } },
        expense: { select: { id: true, description: true } },
      },
    }),
    prisma.attachment.aggregate({
      where: { organizationId: org.id },
      _sum: { sizeBytes: true },
    }),
  ]);

  const writable = can(user, "files:write");
  const isFiltered = Boolean(q || params.kind);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Files"
        description={`${total} file${total === 1 ? "" : "s"} · ${formatBytes(sizeSum._sum.sizeBytes ?? 0)} stored`}
      />

      <ListToolbar
        searchPlaceholder="Search filename, caption, client or job…"
        filters={[
          {
            name: "kind",
            label: "types",
            options: [
              { value: "PHOTO", label: "Photos" },
              { value: "DOCUMENT", label: "Documents" },
              { value: "CONTRACT", label: "Contracts" },
            ],
          },
        ]}
      />

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={<FolderClosed className="h-5 w-5" strokeWidth={1.75} />}
            title={isFiltered ? "No matches" : "No files yet"}
            description={
              isFiltered
                ? "Try a different search or clear the filters."
                : "Files are uploaded from a client, job, estimate or invoice, and all of them show up here."
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <Th>File</Th>
                <Th className="hidden md:table-cell">Attached to</Th>
                <Th className="hidden lg:table-cell">Uploaded</Th>
                <Th align="right" className="hidden sm:table-cell">
                  Size
                </Th>
                <Th />
              </THead>

              <TBody>
                {rows.map((file) => {
                  const image = isImageMime(file.mimeType);
                  const attachedTo = describeTarget(file);

                  return (
                    <Tr key={file.id}>
                      <Td>
                        <a
                          href={`/api/files/${file.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="group flex items-center gap-3"
                        >
                          {image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`/api/files/${file.id}`}
                              alt=""
                              loading="lazy"
                              className="h-9 w-9 shrink-0 rounded-md border border-line bg-surface-3 object-cover"
                            />
                          ) : (
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-subtle">
                              <FileText className="h-4 w-4" strokeWidth={1.75} />
                            </span>
                          )}

                          <span className="min-w-0">
                            <span className="block truncate font-medium text-ink group-hover:text-brand">
                              {file.originalName}
                            </span>
                            {file.caption ? (
                              <span className="block truncate text-xs text-ink-subtle">
                                {file.caption}
                              </span>
                            ) : null}
                          </span>
                        </a>
                      </Td>

                      <Td className="hidden md:table-cell">
                        {attachedTo ? (
                          <Link
                            href={attachedTo.href}
                            className="block truncate text-ink-muted transition-colors hover:text-brand"
                          >
                            {attachedTo.label}
                          </Link>
                        ) : (
                          <span className="text-ink-subtle">—</span>
                        )}
                        <span className="mt-0.5 flex gap-1">
                          {file.kind === "CONTRACT" ? (
                            <Badge tone="info">Contract</Badge>
                          ) : null}
                          {file.photoStage ? (
                            <Badge tone="accent">
                              {file.photoStage.charAt(0) +
                                file.photoStage.slice(1).toLowerCase()}
                            </Badge>
                          ) : null}
                        </span>
                      </Td>

                      <Td className="tabular hidden whitespace-nowrap text-ink-muted lg:table-cell">
                        {format(file.createdAt, "MMM d, yyyy")}
                        <span className="block text-xs text-ink-subtle">
                          {file.uploadedBy?.name ?? "—"}
                        </span>
                      </Td>

                      <Td
                        align="right"
                        className="tabular hidden whitespace-nowrap text-ink-muted sm:table-cell"
                      >
                        {formatBytes(file.sizeBytes)}
                      </Td>

                      <Td align="right" className="w-20">
                        <span className="flex items-center justify-end gap-0.5">
                          <a
                            href={`/api/files/${file.id}?download`}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
                            aria-label={`Download ${file.originalName}`}
                          >
                            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                          </a>

                          {writable ? (
                            <form action={deleteAttachment}>
                              <input type="hidden" name="id" value={file.id} />
                              <button
                                type="submit"
                                aria-label={`Delete ${file.originalName}`}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                              >
                                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                              </button>
                            </form>
                          ) : null}
                        </span>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>

            <Pagination
              page={page}
              pageCount={Math.max(Math.ceil(total / PAGE_SIZE), 1)}
              total={total}
              pageSize={PAGE_SIZE}
              pathname="/files"
              params={{ q: params.q, kind: params.kind }}
              itemLabel="files"
            />
          </>
        )}
      </Card>
    </div>
  );
}

function describeTarget(file: {
  client: { id: string; displayName: string } | null;
  job: { id: string; number: string; title: string } | null;
  lead: { id: string; name: string } | null;
  estimate: { id: string; number: string } | null;
  invoice: { id: string; number: string } | null;
  expense: { id: string; description: string } | null;
}) {
  if (file.job) {
    return { href: `/jobs/${file.job.id}`, label: `${file.job.number} · ${file.job.title}` };
  }
  if (file.client) {
    return { href: `/clients/${file.client.id}`, label: file.client.displayName };
  }
  if (file.invoice) {
    return { href: `/invoices/${file.invoice.id}`, label: file.invoice.number };
  }
  if (file.estimate) {
    return { href: `/estimates/${file.estimate.id}`, label: file.estimate.number };
  }
  if (file.lead) {
    return { href: `/leads/${file.lead.id}`, label: file.lead.name };
  }
  if (file.expense) {
    return {
      href: `/expenses/${file.expense.id}`,
      label: file.expense.description,
    };
  }
  return null;
}
