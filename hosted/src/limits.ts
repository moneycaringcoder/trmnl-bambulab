/**
 * The rate-limiter shape Cloudflare's `ratelimits` binding satisfies.
 *
 * Its own file because two unrelated surfaces consume it — the enrolment
 * routes and the markup route — and it used to live in the screen-polling
 * module, which the marketplace conversion deleted.
 */

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
