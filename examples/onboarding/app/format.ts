const dateTime = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/**
 * Renders a date the same way on the server and in the browser, so hydration never sees a
 * different locale.
 */
export const formatDate = (value: Date | string | undefined): string =>
  value === undefined ? "—" : `${dateTime.format(new Date(value))} UTC`;
