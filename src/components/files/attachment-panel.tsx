import { format } from "date-fns";
import { Download, FileText, ImageIcon, Paperclip, Trash2 } from "lucide-react";

import { UploadForm } from "./upload-form";
import { deleteAttachment } from "@/app/(app)/files/actions";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/page-header";
import type { AttachmentEntityType } from "@/lib/attachment-entities";
import { formatBytes, isImageMime } from "@/lib/storage-limits";
import { cn } from "@/lib/utils";

export type AttachmentRow = {
  id: string;
  kind: string;
  photoStage: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  caption: string | null;
  createdAt: Date;
  uploadedBy: { name: string } | null;
};

export function AttachmentPanel({
  attachments,
  entityType,
  entityId,
  canWrite,
  allowPhotoStage = false,
}: {
  attachments: AttachmentRow[];
  entityType: AttachmentEntityType;
  entityId: string;
  canWrite: boolean;
  allowPhotoStage?: boolean;
}) {
  const photos = attachments.filter((a) => isImageMime(a.mimeType));
  const documents = attachments.filter((a) => !isImageMime(a.mimeType));

  // Before/after pairs are the point of job photos, so they lead the gallery.
  const before = photos.filter((p) => p.photoStage === "BEFORE");
  const after = photos.filter((p) => p.photoStage === "AFTER");
  const otherPhotos = photos.filter(
    (p) => p.photoStage !== "BEFORE" && p.photoStage !== "AFTER",
  );
  const showPairs = allowPhotoStage && (before.length > 0 || after.length > 0);

  return (
    <div className="divide-y divide-line">
      {canWrite ? (
        <div className="p-5">
          <UploadForm
            entityType={entityType}
            entityId={entityId}
            allowPhotoStage={allowPhotoStage}
          />
        </div>
      ) : null}

      {attachments.length === 0 ? (
        <EmptyState
          icon={<Paperclip className="h-5 w-5" strokeWidth={1.75} />}
          title="No files yet"
          description={
            allowPhotoStage
              ? "Before-and-after photos, signed paperwork, anything worth keeping with this record."
              : "Contracts, documents and photos attached here stay with this record."
          }
        />
      ) : (
        <div className="space-y-5 p-5">
          {showPairs ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <PhotoGroup
                title="Before"
                photos={before}
                entityType={entityType}
                entityId={entityId}
                canWrite={canWrite}
              />
              <PhotoGroup
                title="After"
                photos={after}
                entityType={entityType}
                entityId={entityId}
                canWrite={canWrite}
              />
            </div>
          ) : null}

          {otherPhotos.length > 0 || (!showPairs && photos.length > 0) ? (
            <PhotoGroup
              title={showPairs ? "Other photos" : "Photos"}
              photos={showPairs ? otherPhotos : photos}
              entityType={entityType}
              entityId={entityId}
              canWrite={canWrite}
            />
          ) : null}

          {documents.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
                Documents
              </p>
              <ul className="divide-y divide-line rounded-card border border-line">
                {documents.map((file) => (
                  <li
                    key={file.id}
                    className="group flex items-center gap-3 px-3 py-2.5"
                  >
                    <FileText
                      className="h-4 w-4 shrink-0 text-ink-subtle"
                      strokeWidth={1.75}
                    />

                    <a
                      href={`/api/files/${file.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1"
                    >
                      <span className="block truncate text-sm font-medium text-ink hover:text-brand">
                        {file.originalName}
                      </span>
                      <span className="block truncate text-xs text-ink-subtle">
                        {formatBytes(file.sizeBytes)} ·{" "}
                        {format(file.createdAt, "MMM d, yyyy")}
                        {file.uploadedBy ? ` · ${file.uploadedBy.name}` : ""}
                        {file.caption ? ` · ${file.caption}` : ""}
                      </span>
                    </a>

                    {file.kind === "CONTRACT" ? <Badge tone="info">Contract</Badge> : null}

                    <a
                      href={`/api/files/${file.id}?download`}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
                      aria-label={`Download ${file.originalName}`}
                    >
                      <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </a>

                    {canWrite ? (
                      <DeleteButton
                        id={file.id}
                        entityType={entityType}
                        entityId={entityId}
                        label={file.originalName}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PhotoGroup({
  title,
  photos,
  entityType,
  entityId,
  canWrite,
}: {
  title: string;
  photos: AttachmentRow[];
  entityType: AttachmentEntityType;
  entityId: string;
  canWrite: boolean;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold tracking-wider text-ink-subtle uppercase">
        {title}
      </p>

      {photos.length === 0 ? (
        <div className="flex h-28 items-center justify-center rounded-card border border-dashed border-line text-xs text-ink-subtle">
          <ImageIcon className="mr-1.5 h-4 w-4" strokeWidth={1.75} />
          None yet
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.map((photo) => (
            <li key={photo.id} className="group relative">
              <a
                href={`/api/files/${photo.id}`}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-lg border border-line"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/files/${photo.id}`}
                  alt={photo.caption ?? photo.originalName}
                  loading="lazy"
                  className="aspect-square w-full bg-surface-3 object-cover transition-transform group-hover:scale-[1.03]"
                />
              </a>

              {photo.caption ? (
                <p className="mt-1 truncate text-xs text-ink-muted">
                  {photo.caption}
                </p>
              ) : null}

              {canWrite ? (
                <div className={cn("absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100")}>
                  <DeleteButton
                    id={photo.id}
                    entityType={entityType}
                    entityId={entityId}
                    label={photo.originalName}
                    solid
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeleteButton({
  id,
  entityType,
  entityId,
  label,
  solid,
}: {
  id: string;
  entityType: AttachmentEntityType;
  entityId: string;
  label: string;
  solid?: boolean;
}) {
  return (
    <form action={deleteAttachment} className="shrink-0">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />
      <button
        type="submit"
        aria-label={`Delete ${label}`}
        title={`Delete ${label}`}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
          solid
            ? "bg-surface/90 text-ink-muted shadow-sm hover:bg-danger hover:text-white"
            : "text-ink-subtle opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-danger/10 hover:text-danger",
        )}
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </form>
  );
}
