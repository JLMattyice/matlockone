/**
 * What the public "Request service" form and its action agree on. Plain, so
 * the browser's form can read it too.
 */

/** The most photos one request carries. */
export const REQUEST_PHOTO_LIMIT = 5;

/** What the form shrinks a photo to before sending, so five fit in one upload. */
export const REQUEST_PHOTO_EDGE = 1600;

export const REQUEST_TIMES = [
  { value: "ANY", label: "Any time" },
  { value: "MORNING", label: "Morning" },
  { value: "AFTERNOON", label: "Afternoon" },
  { value: "EVENING", label: "Evening" },
] as const;
