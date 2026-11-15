import type { ClockRow } from "@/app/(app)/team/time-clock/entry-row";
import type { SheetStretch } from "@/lib/timesheet";
import { formatIn, toDateTimeLocal } from "@/lib/time-zone";
import { formatMinutes } from "@/lib/utils";

/**
 * A stretch on the clock as its row shows it and as its edit boxes want it,
 * on the viewer's clock. One that ends on a later day than it began says
 * which day, so "11:40 PM – 2:10 AM" cannot be read as a short evening.
 */
export function clockRow(stretch: SheetStretch, person: string, zone: string): ClockRow {
  const day = (date: Date) => formatIn(date, "yyyy-MM-dd", zone);

  return {
    id: stretch.id,
    person,
    day: formatIn(stretch.clockedInAt, "EEE, MMM d", zone),
    inLabel: formatIn(stretch.clockedInAt, "h:mm a", zone),
    outLabel: stretch.clockedOutAt
      ? formatIn(
          stretch.clockedOutAt,
          day(stretch.clockedOutAt) === day(stretch.clockedInAt) ? "h:mm a" : "EEE h:mm a",
          zone,
        )
      : null,
    hours: formatMinutes(stretch.minutes),
    inValue: toDateTimeLocal(stretch.clockedInAt, zone),
    outValue: toDateTimeLocal(stretch.clockedOutAt, zone),
    editedBy: stretch.editedBy,
    forgotten: stretch.forgotten,
  };
}
