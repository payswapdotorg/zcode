/**
 * ISO 8601 duration — the format YouTube's contentDetails.duration uses —
 * parsed to whole seconds. "PT0S" (live streams) and anything malformed
 * return null so the ranking layer can treat it as "no duration".
 */
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseISODuration(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const match = DURATION.exec(iso);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total =
    (days ? Number(days) * 86400 : 0) +
    (hours ? Number(hours) * 3600 : 0) +
    (minutes ? Number(minutes) * 60 : 0) +
    (seconds ? Number(seconds) : 0);
  return total > 0 ? total : null;
}
