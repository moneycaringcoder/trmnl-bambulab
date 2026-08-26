import { describe, expect, it } from "vitest";
import { boot } from "../public/boot.js";
import { control, settle, setupWindow } from "./setup-dom-harness.js";

const printers = [
  { deviceId: "a", name: "Alpha", online: true, model: "A1" },
  { deviceId: "b", name: "Beta", online: true, model: "P1" },
  { deviceId: "c", name: "Gamma", online: false, model: null },
  { deviceId: "d", name: "Delta", online: true, model: null },
];

describe("the real setup boot module", () => {
  it("restores, validates, announces, retries, orders, reuses auth, and guards deletion", async () => {
    const responses = [
      { status: 200, body: { device_ids: ["b", "a"], reauth_required: false } },
      new Error("temporary network failure"),
      { status: 200, body: { printers } },
      { status: 502, body: { error: "Bambu Cloud did not answer. Try again." } },
      { status: 204 },
      { status: 200, body: { device_ids: ["a", "b", "c"], reauth_required: false } },
      { status: 409, body: { error: "Saved sign-in expired.", reauth_required: true } },
      { status: 204 },
      { status: 200, body: { device_ids: ["a", "b", "c"], reauth_required: false } },
      { status: 204 },
      { status: 401, body: { error: "Sign in again." } },
    ];
    const harness = await setupWindow(responses);
    const { document, requests, window } = harness;
    const app = boot(window);
    await settle();

    expect(app.currentView).toBe("manage");
    expect(document.activeElement).toBe(control(document, "#l3h"));
    expect(control(document, "#live").textContent).toMatch(/ready to manage/);
    expect(window.location.hash).toBe("");

    control(document, '[data-act="printers"]').click();
    await settle();
    expect(app.currentView).toBe("manage");
    expect(control(document, "#live").textContent).toMatch(/Could not reach/);

    control(document, '[data-act="printers"]').click();
    await settle();
    expect(app.currentView).toBe("printers");
    expect(document.activeElement).toBe(control(document, "#l2h"));
    expect(requests.filter((request) => request.path === "/v1/enrol/code")).toHaveLength(0);

    control(document, '[aria-label="Move Alpha up"]').click();
    await settle();
    expect(document.activeElement).toBe(control(document, 'input[value="a"]'));
    const gamma = control(document, 'input[value="c"]');
    gamma.click();
    await settle();
    const delta = control(document, 'input[value="d"]');
    delta.click();
    await settle();
    expect(delta.checked).toBe(false);
    expect(control(document, "#live").textContent).toMatch(/Three printers/);

    control(document, '#l2 button[type="submit"]').click();
    await settle();
    expect(app.currentView).toBe("printers");
    expect(control(document, "#live").textContent).toMatch(/did not answer/);

    control(document, '#l2 button[type="submit"]').click();
    await settle();
    expect(app.currentView).toBe("done");
    expect(document.activeElement).toBe(control(document, "#l3h"));
    expect(control(document, "#live").textContent).toMatch(/Setup complete/);
    expect(control(document, "a.action").href).toBe("https://trmnl.com/plugins");
    const saved = requests.findLast((request) => request.path === "/v1/enrol/printers");
    expect(JSON.parse(saved.init.body).deviceIds).toEqual(["a", "b", "c"]);

    await app.start();
    await settle();
    expect(app.currentView).toBe("manage");
    control(document, '[data-act="printers"]').click();
    await settle();
    expect(app.currentView).toBe("email");
    expect(document.activeElement).toBe(control(document, "#be"));
    expect(control(document, "#live").textContent).toMatch(/expired/);

    const requestCount = requests.length;
    control(document, '#l1 button[type="submit"]').click();
    await settle();
    const email = control(document, "#be");
    expect(requests).toHaveLength(requestCount);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe("be-error");
    expect(control(document, "#be-error").textContent).toMatch(/email address/);

    email.value = "person@example.com";
    email.dispatchEvent(new window.Event("input", { bubbles: true }));
    control(document, '#l1 button[type="submit"]').click();
    await settle();
    expect(app.currentView).toBe("code");
    const beforeInvalidCode = requests.length;
    const code = control(document, "#bc");
    code.value = "12x";
    control(document, '#l1 button[type="submit"]').click();
    await settle();
    expect(requests).toHaveLength(beforeInvalidCode);
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(code.getAttribute("aria-describedby")).toBe("bc-error");

    await app.start();
    await settle();
    const deleteButton = control(document, '[data-act="del"]');
    const deleteCalls = () => requests.filter((request) => request.init.method === "DELETE").length;
    deleteButton.click();
    await settle();
    expect(deleteCalls()).toBe(0);
    expect(document.activeElement).toBe(control(document, '[data-act="cancel-delete"]'));
    control(document, '[data-act="confirm-delete"]').click();
    await settle();
    expect(deleteCalls()).toBe(1);
    expect(app.currentView).toBe("email");
    expect(document.activeElement).toBe(control(document, "#be"));
    expect(control(document, "#live").textContent).toMatch(/Everything was deleted/);

    await app.start();
    await settle();
    expect(app.currentView).toBe("access");
    expect(control(document, "#live").textContent).toMatch(/expired/);
    expect(window.sessionStorage.getItem("trmnlManageToken")).toBeNull();

    for (const request of requests) {
      expect(request.init.headers.Authorization).toBe("Bearer management-token");
      expect(JSON.stringify(request)).not.toContain("cloud-token");
    }
    expect(responses).toHaveLength(0);
  });
});
