"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";

import { uploadAttachment } from "@/app/(app)/files/actions";
import { Input, Select } from "@/components/ui/form";
import { ActionStatus, SubmitButton } from "@/components/ui/submit";
import { IDLE, type ActionState } from "@/lib/action-state";
import type { AttachmentEntityType } from "@/lib/attachment-entities";
import { PHOTO_STAGES } from "@/lib/constants";
import { allowedExtensionsLabel } from "@/lib/storage-limits";
import { cn } from "@/lib/utils";

export function UploadForm({
  entityType,
  entityId,
  allowPhotoStage = false,
}: {
  entityType: AttachmentEntityType;
  entityId: string;
  /** Before/after tagging only makes sense on a job. */
  allowPhotoStage?: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    uploadAttachment,
    IDLE,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [fileCount, setFileCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      setFileCount(0);
    }
  }, [state]);

  function acceptDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);

    if (!inputRef.current || event.dataTransfer.files.length === 0) return;
    // Assigning the DataTransfer's FileList is what makes a dropped file part
    // of the form submission, rather than a separate upload path.
    inputRef.current.files = event.dataTransfer.files;
    setFileCount(event.dataTransfer.files.length);
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={acceptDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-card border border-dashed px-4 py-6 text-center transition-colors",
          dragging
            ? "border-brand bg-brand/5"
            : "border-line-strong hover:border-brand hover:bg-surface-2",
        )}
      >
        <Upload className="h-5 w-5 text-ink-subtle" strokeWidth={1.75} />
        <span className="text-sm font-medium text-ink">
          {fileCount > 0
            ? `${fileCount} file${fileCount === 1 ? "" : "s"} ready`
            : "Drop files here, or click to choose"}
        </span>
        <span className="text-xs text-ink-subtle">
          {allowedExtensionsLabel()} · up to 15 MB each
        </span>

        <input
          ref={inputRef}
          type="file"
          name="files"
          multiple
          className="sr-only"
          onChange={(e) => setFileCount(e.target.files?.length ?? 0)}
        />
      </label>

      <div className="grid gap-2 sm:grid-cols-[9rem_9rem_minmax(0,1fr)]">
        <Select name="kind" defaultValue="DOCUMENT" aria-label="File type">
          <option value="DOCUMENT">Document</option>
          <option value="PHOTO">Photo</option>
          <option value="CONTRACT">Contract</option>
        </Select>

        {allowPhotoStage ? (
          <Select name="photoStage" defaultValue="" aria-label="Photo stage">
            <option value="">No stage</option>
            {PHOTO_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {stage.charAt(0) + stage.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        ) : (
          <span className="hidden sm:block" />
        )}

        <Input name="caption" placeholder="Caption (optional)" aria-label="Caption" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ActionStatus state={state} className="text-xs" />
        <SubmitButton
          size="sm"
          variant="outline"
          className="ml-auto"
          pendingLabel="Uploading…"
          disabled={fileCount === 0}
        >
          Upload
        </SubmitButton>
      </div>
    </form>
  );
}
