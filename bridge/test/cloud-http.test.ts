import { describe, expect, it } from "vitest";
import { CloudError, baseHeaders, categorize } from "../src/providers/bambu-cloud/http.ts";

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
