import { describe, expect, it } from "vitest";
import { validBackUrl } from "../public/api-session.js";
import {
  changeSelection,
  codeError,
  emailError,
  moveSelection,
  orderedSelection,
} from "../public/setup-state.js";

const printers = ["a", "b", "c", "d"].map((deviceId) => ({ deviceId }));

describe("setup validation", () => {
  it("rejects incomplete email and code values before an API call is possible", () => {
    expect(emailError("")).toMatch(/Enter/);
    expect(emailError("not-an-email")).toMatch(/valid/);
    expect(emailError("person@example.com")).toBeNull();
    expect(codeError("123")).toMatch(/4 to 10/);
    expect(codeError("1234a")).toMatch(/4 to 10/);
    expect(codeError("123456")).toBeNull();
  });

  it("accepts only HTTPS return locations owned by TRMNL", () => {
    expect(validBackUrl("https://trmnl.com/plugins")).toBe("https://trmnl.com/plugins");
    expect(validBackUrl("https://app.trmnl.com/configure")).toContain(".trmnl.com");
    expect(validBackUrl("https://trmnl.com.evil.example/phish")).toBeNull();
    expect(validBackUrl("http://trmnl.com/downgrade")).toBeNull();
  });
});

describe("visible printer order", () => {
  it("restores known saved order and caps fresh defaults at three", () => {
    expect(orderedSelection(printers, ["c", "missing", "a", "c"])).toEqual(["c", "a"]);
    expect(orderedSelection(printers)).toEqual(["a", "b", "c"]);
  });

  it("retains at most three and preserves explicit movement", () => {
    const full = ["a", "b", "c"];
    expect(changeSelection(full, "d", true)).toEqual({
      ok: false,
      order: full,
      guidance: "Three printers is the most the display can show legibly.",
    });
    expect(moveSelection(full, "c", "up")).toEqual(["a", "c", "b"]);
    expect(moveSelection(["a", "c", "b"], "c", "up")).toEqual(["c", "a", "b"]);
  });

  it("puts a newly selected printer at the visible end", () => {
    expect(changeSelection(["b"], "d", true)).toEqual({ ok: true, order: ["b", "d"] });
    expect(changeSelection(["b", "d"], "b", false)).toEqual({ ok: true, order: ["d"] });
  });
});
