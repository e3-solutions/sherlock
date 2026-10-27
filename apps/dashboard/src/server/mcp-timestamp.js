import * as z from "zod/v4";

// Agents write timestamps the way people do: without milliseconds, with
// +00:00 instead of Z, or as a bare date. Tool inputs accept those spellings
// and normalize them to the canonical Date#toISOString() form before any
// handler sees them. Tool outputs stay strictly canonical.

export const TIMESTAMP_INPUT_EXAMPLE = "2026-10-26T00:00:00Z";

export const TIMESTAMP_INPUT_HELP = "ISO-8601 with Z or a +HH:MM/-HH:MM offset "
  + "(e.g. 2026-10-26T00:00:00Z, 2026-10-26T00:00:00.000Z, 2026-10-26T05:30:00+05:30; "
  + "seconds and fractional seconds are optional, offsets are converted to UTC, "
  + "precision beyond milliseconds is truncated), or a date 2026-10-26 meaning 00:00:00Z that day";

const TIMESTAMP_INPUT_ERROR = "Expected an ISO-8601 timestamp with Z or a +HH:MM offset, "
  + `or a YYYY-MM-DD date (UTC midnight), e.g. ${TIMESTAMP_INPUT_EXAMPLE}`;

const INPUT_PATTERN = new RegExp(
  "^(\\d{4})-(\\d{2})-(\\d{2})"
  + "(?:[Tt ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,9}))?)?"
  + "(?:([Zz])|([+-])(\\d{2}):?(\\d{2})))?$",
);

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Parse a lenient ISO-8601 UTC timestamp and return its canonical
 * toISOString() form, or null when the value is not an exact instant.
 * Date-times without Z or an explicit offset are rejected because they would
 * otherwise be read in the server's local time zone.
 */
export function normalizeTimestampInput(value) {
  if (typeof value !== "string") return null;
  const match = INPUT_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction, zulu, sign, oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;

  const dateOnly = h === undefined;
  const hour = dateOnly ? 0 : Number(h);
  const minute = dateOnly ? 0 : Number(mi);
  const second = s === undefined ? 0 : Number(s);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millisecond = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));

  let offsetMinutes = 0;
  if (!dateOnly && !zulu) {
    const offsetHour = Number(oh);
    const offsetMinute = Number(om);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (sign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  const instant = date.getTime() - offsetMinutes * 60_000;
  if (!Number.isFinite(instant)) return null;
  const normalized = new Date(instant);
  return Number.isFinite(normalized.getTime()) ? normalized.toISOString() : null;
}

/** Zod input schema: lenient ISO-8601 in, canonical toISOString() out. */
export const TIMESTAMP_INPUT = z.string().max(64).transform((value, ctx) => {
  const normalized = normalizeTimestampInput(value);
  if (normalized === null) {
    ctx.issues.push({ code: "custom", message: TIMESTAMP_INPUT_ERROR, input: value });
    return z.NEVER;
  }
  return normalized;
});
