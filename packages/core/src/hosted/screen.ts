import type { Screen } from "./store.ts";

const UTF8 = new TextEncoder();

export type ScreenSerialization =
  | { kind: "ready"; screen: Screen; bytes: number }
  | { kind: "too-large"; bytes: number };

/**
 * Builds the one stored-screen representation shared by cron and collector.
 *
 * Null means unsupported throughout the normalized model, but TRMNL expects
 * absent merge variables. The byte ceiling applies to the exact UTF-8 body
 * written to Postgres, so callers cannot disagree about shape or size.
 */
export function serializeScreen(
  variables: object,
  renderedAt: number,
  maxBytes: number,
): ScreenSerialization {
  if (!Number.isSafeInteger(renderedAt) || renderedAt < 0) {
    throw new Error("screen render time must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("screen payload limit must be a positive safe integer");
  }

  const body = JSON.stringify(variables, (_key, value: unknown) =>
    value === null ? undefined : value,
  );
  if (body === undefined) throw new Error("screen payload could not be serialized");
  const bytes = UTF8.encode(body).byteLength;
  if (bytes > maxBytes) return { kind: "too-large", bytes };
  return { kind: "ready", screen: { body, renderedAt }, bytes };
}
