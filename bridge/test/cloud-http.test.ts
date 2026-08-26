import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudError,
  MAX_RESPONSE_BYTES,
  baseHeaders,
  categorize,
  request,
} from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/http";
import type { CloudHosts } from "@trmnl-bambulab/core/telemetry/providers/bambu-cloud/hosts";

const HOSTS: CloudHosts = {
  api: "https://cloud.example.test",
  mqtt: "mqtt.example.test",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("categorize", () => {
  it("separates an expired token from a Cloudflare challenge", () => {
    expect(categorize(401, '{"code":4,"error":"Please login."}')).toBe("unauthorized-or-expired");
    expect(categorize(403, "<html>Attention Required! | Cloudflare</html>")).toBe(
      "blocked-by-cloudflare",
    );
    expect(categorize(403, "")).toBe("unauthorized-or-expired");
  });

  it("maps the remaining status classes", () => {
    expect(categorize(429, "")).toBe("rate-limited");
    expect(categorize(500, "")).toBe("server-error");
    expect(categorize(503, "")).toBe("server-error");
    expect(categorize(400, "")).toBe("client-error");
    expect(categorize(404, "")).toBe("client-error");
  });
});

describe("CloudError", () => {
  it("names the status and category and nothing else", () => {
    const error = new CloudError(401, "unauthorized-or-expired");
    expect(error.message).toBe("bambu cloud request failed: HTTP 401 (unauthorized-or-expired)");
    expect(error.status).toBe(401);
    expect(error.category).toBe("unauthorized-or-expired");
  });

  it("omits the status when there was no response", () => {
    expect(new CloudError(0, "timeout").message).toBe("bambu cloud request failed: timeout");
  });

  it("never repeats a response body", () => {
    const body = '{"error":"account@example.com is locked"}';
    const error = new CloudError(403, categorize(403, body));
    expect(error.message).not.toContain("@");
    expect(error.message).not.toContain("locked");
  });
});

describe("baseHeaders", () => {
  it("adds an Authorization header only when a token is given", () => {
    expect(baseHeaders().Authorization).toBeUndefined();
    expect(baseHeaders("abc")).toMatchObject({ Authorization: "Bearer abc" });
  });

  it("always announces JSON", () => {
    expect(baseHeaders()).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  });
});

describe("request bounds", () => {
  it("keeps the abort deadline active while the response body is being read", async () => {
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        }),
        { status: 200 },
      );
    });

    await expect(request(HOSTS, "/slow", { timeoutMs: 1 })).rejects.toMatchObject({
      status: 0,
      category: "timeout",
      message: "bambu cloud request failed: timeout",
    });
  });

  it("refuses an oversized streamed body without exposing its contents", async () => {
    const privateBody = `private-account-marker${"x".repeat(MAX_RESPONSE_BYTES)}`;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(new TextEncoder().encode(privateBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const error = await request(HOSTS, "/oversized").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CloudError);
    expect(error).toMatchObject({ status: 200, category: "response-too-large" });
    expect(String(error)).not.toContain("private-account-marker");
  });

  it("still refuses to follow redirects", async () => {
    let redirect: RequestRedirect | undefined;
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => {
      redirect = init.redirect;
      return new Response("{}", { status: 200 });
    });

    await request(HOSTS, "/redirect");
    expect(redirect).toBe("manual");
  });
});
