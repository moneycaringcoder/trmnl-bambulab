/**
 * Reconnection delay.
 *
 * Bambu has temporarily banned accounts for between 24 hours and 7 days after
 * reconnect storms, and its own notice blames repeated failed subscriptions and
 * reconnect loops rather than ordinary traffic. So the delay after a failure
 * grows, is capped, and is jittered.
 *
 * The jitter is not decoration. Every self-hosted bridge that loses its
 * connection during the same cloud incident would otherwise return at the same
 * instant, which is the behaviour the notice describes.
 *
 * Pure: the random source is a parameter, so the schedule is testable.
 */

export const FIRST_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 10 * 60_000;

/**
 * How long to wait before attempt number `failures` (1 is the first retry).
 *
 * Doubles from five seconds to a ten-minute ceiling, then stays there. Jitter
 * spreads each delay across a window from 50% to 100% of the computed value:
 * full jitter rather than a small wobble, because spreading a thundering herd
 * matters more than retrying at a predictable moment.
 */
export function retryDelayMs(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) return 0;
  const uncapped = FIRST_RETRY_MS * 2 ** (failures - 1);
  const capped = Math.min(MAX_RETRY_MS, uncapped);
  return Math.round(capped * (0.5 + random() * 0.5));
}

/**
 * Whether a failure is worth retrying at all.
 *
 * An expired token is not: retrying it cannot succeed, and a loop against a
 * rejecting endpoint is precisely what earns a ban. It has to reach the user as
 * an instruction instead.
 */
export function isRetryable(reason: string): boolean {
  return reason !== "reauth_required" && reason !== "rejected";
}
