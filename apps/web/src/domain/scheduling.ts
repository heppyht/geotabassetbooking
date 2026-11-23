/*───────────────────── Domain: Scheduling ─────────────────────*/
/* Pure scheduling logic: interval overlap, buffer extension, conflict detection.
   No persistence, no Hono, no MyGeotab dependency. Reusable by frontend and API. */

export type Interval = { start: Date; end: Date };

export function overlaps(a: Interval, b: Interval): boolean {
  if (!(a.start instanceof Date) || !(a.end instanceof Date) ||
      !(b.start instanceof Date) || !(b.end instanceof Date)) throw new Error("Invalid interval");
  if (a.end <= a.start || b.end <= b.start) throw new Error("End must be after start");
  return a.start < b.end && b.start < a.end;
}

export function withBuffer(i: Interval, beforeMinutes = 0, afterMinutes = 0): Interval {
  if (beforeMinutes < 0 || afterMinutes < 0) throw new Error("Buffer cannot be negative");
  return {
    start: new Date(i.start.getTime() - beforeMinutes * 60_000),
    end: new Date(i.end.getTime() + afterMinutes * 60_000)
  };
}

export type ConflictCheck = {
  hasConflict: boolean;
  conflictingBookingId: string | null;
  conflictingStatus: string | null;
};

export function findConflict(
  candidate: Interval,
  existing: Array<{ id: string; startAt: string; endAt: string; status: string; deviceId: string }>,
  targetDeviceId: string,
  conflictStatuses: string[],
): ConflictCheck {
  const hit = existing.find(b => {
    if (b.deviceId !== targetDeviceId) return false;
    if (!conflictStatuses.includes(b.status)) return false;
    try {
      return overlaps(candidate, { start: new Date(b.startAt), end: new Date(b.endAt) });
    } catch {
      return false;
    }
  });
  if (!hit) return { hasConflict: false, conflictingBookingId: null, conflictingStatus: null };
  return {
    hasConflict: true,
    conflictingBookingId: hit.id,
    conflictingStatus: hit.status,
  };
}
