/**
 * App lock policy (spec §8.2): optional for readers, required for contributors and moderators. The app locks itself
 * after it has been in the background for a while; locking drops every secret from memory.
 */
export const AUTO_LOCK_MS = 60_000;

export function mustLockOnResume(
  backgroundedAt: number | null,
  now: number,
  lockEnabled: boolean,
  timeoutMs = AUTO_LOCK_MS,
): boolean {
  return lockEnabled && backgroundedAt !== null && now - backgroundedAt >= timeoutMs;
}

/** Seconds until another PIN attempt is allowed (the vault backs off after repeated failures). */
export function secondsUntilRetry(retryAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/** Delay after `failures` wrong PINs: none for the first 4, then doubling from 30 s, capped at one hour. */
export function backoffMs(failures: number): number {
  if (failures < 5) return 0;
  return Math.min(3_600_000, 30_000 * 2 ** (failures - 5));
}
