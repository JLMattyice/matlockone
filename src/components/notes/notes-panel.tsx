import { format } from "date-fns";
import { Pin, StickyNote, Trash2 } from "lucide-react";

import { NoteComposer } from "./note-composer";
import { deleteNote, toggleNotePin } from "@/app/(app)/notes/actions";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/page-header";
import type { NoteEntityType } from "@/lib/note-entities";
import { cn } from "@/lib/utils";

export type NoteRow = {
  id: string;
  body: string;
  visibility: string;
  pinned: boolean;
  createdAt: Date;
  author: { name: string } | null;
};

export function NotesPanel({
  notes,
  entityType,
  entityId,
  canWrite,
  placeholder,
  emptyDescription,
}: {
  notes: NoteRow[];
  entityType: NoteEntityType;
  entityId: string;
  canWrite: boolean;
  placeholder?: string;
  emptyDescription?: string;
}) {
  return (
    <div className="divide-y divide-line">
      {canWrite ? (
        <div className="p-5">
          <NoteComposer
            entityType={entityType}
            entityId={entityId}
            placeholder={placeholder}
          />
        </div>
      ) : null}

      {notes.length === 0 ? (
        <EmptyState
          icon={<StickyNote className="h-5 w-5" strokeWidth={1.75} />}
          title="No notes yet"
          description={emptyDescription}
        />
      ) : (
        <ul className="divide-y divide-line">
          {notes.map((note) => (
            <li
              key={note.id}
              className={cn("group px-5 py-4", note.pinned && "bg-warning/5")}
            >
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">
                  {note.author?.name ?? "Removed user"}
                </span>
                <span className="text-xs text-ink-subtle">
                  {format(note.createdAt, "MMM d, yyyy 'at' h:mm a")}
                </span>

                {note.pinned ? (
                  <Badge tone="warning" dot>
                    Pinned
                  </Badge>
                ) : null}
                {note.visibility === "SHARED" ? (
                  <Badge tone="info">Client-visible</Badge>
                ) : null}

                {canWrite ? (
                  <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <form action={toggleNotePin}>
                      <input type="hidden" name="id" value={note.id} />
                      <input type="hidden" name="entityType" value={entityType} />
                      <input type="hidden" name="entityId" value={entityId} />
                      <button
                        type="submit"
                        aria-label={note.pinned ? "Unpin note" : "Pin note"}
                        title={note.pinned ? "Unpin note" : "Pin note"}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
                      >
                        <Pin
                          className={cn("h-3.5 w-3.5", note.pinned && "fill-current")}
                          strokeWidth={1.75}
                        />
                      </button>
                    </form>

                    <form action={deleteNote}>
                      <input type="hidden" name="id" value={note.id} />
                      <input type="hidden" name="entityType" value={entityType} />
                      <input type="hidden" name="entityId" value={entityId} />
                      <button
                        type="submit"
                        aria-label="Delete note"
                        title="Delete note"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </button>
                    </form>
                  </div>
                ) : null}
              </div>

              <p className="text-sm whitespace-pre-wrap text-ink-muted">
                {note.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
