import {
  changeSelection,
  chosenSummary,
  codeError,
  createSetupState,
  emailError,
  moveSelection,
  orderedSelection,
} from "./setup-state.js";

const RETRYABLE_MESSAGE = "Could not reach the service. Check your connection and try again.";

export function createSetupApp({ document, apiSession }) {
  const state = createSetupState();
  const stack = byId("stack");
  const boot = byId("boot");
  const live = byId("live");
  let currentView = "access";

  function byId(id) {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`Missing setup element: ${id}`);
    return found;
  }

  function element(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    for (const [name, value] of Object.entries(options.attributes ?? {})) {
      if (value !== null && value !== false) node.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of children) node.append(child);
    return node;
  }

  function action(text, kind, type = "button") {
    return element("button", {
      text,
      attributes: { type, "data-kind": kind || null },
    });
  }

  function announce(message) {
    if (!message) return;
    live.textContent = "";
    queueMicrotask(() => {
      live.textContent = message;
    });
  }

  function focusTarget(selector) {
    const target = document.querySelector(selector);
    if (target === null) return;
    if (/^H[1-6]$/.test(target.tagName)) target.setAttribute("tabindex", "-1");
    target.focus();
  }

  function clearFlowError(target) {
    target.querySelector('[data-flow-error="true"]')?.remove();
  }

  function present({ announcement, errorTarget = null, errorText = null, focus = null } = {}) {
    if (errorTarget !== null) {
      clearFlowError(errorTarget);
      if (errorText !== null) {
        errorTarget.prepend(
          element("div", {
            className: "msg",
            text: errorText,
            attributes: { "data-flow-error": "true" },
          }),
        );
      }
    }
    announce(announcement ?? errorText);
    if (focus !== null) focusTarget(focus);
  }

  function paint(id, layerState, { number, title, summary, body }) {
    const layer = byId(id);
    layer.dataset.state = layerState;
    if (layerState === "active") {
      const heading = element("h2", {
        text: title,
        attributes: { id: `${id}h`, tabindex: "-1" },
      });
      const head = element("div", { className: "head" }, [
        element("span", { className: "n", text: number }),
        heading,
      ]);
      layer.replaceChildren(head, body);
      return;
    }
    layer.replaceChildren(
      element("span", { className: "n", text: number }),
      element("span", {
        className: "body",
        text: summary ?? title,
        attributes: { id: `${id}h` },
      }),
      element("span", {
        className: "status",
        text: layerState === "done" ? "done" : "",
      }),
    );
  }

  function field(labelText, control, errorId) {
    const label = element("label", {
      text: labelText,
      attributes: { for: control.id },
    });
    const error = element("p", {
      className: "field-error",
      attributes: { id: errorId, hidden: true },
    });
    control.setAttribute("aria-describedby", errorId);
    control.setAttribute("aria-invalid", "false");
    return { wrap: element("div", { className: "field" }, [label, control, error]), error };
  }

  function setFieldError(control, error, message) {
    control.setAttribute("aria-invalid", message === null ? "false" : "true");
    error.textContent = message ?? "";
    error.hidden = message === null;
  }

  function emailForm() {
    const form = element("form");
    const region = element("select", {
      attributes: { id: "br", name: "region" },
    });
    region.append(
      element("option", { text: "Global (bambulab.com)", attributes: { value: "global" } }),
      element("option", { text: "China (bambulab.cn)", attributes: { value: "china" } }),
    );
    region.value = state.region;
    const email = element("input", {
      attributes: {
        id: "be",
        name: "email",
        type: "email",
        autocomplete: "email",
        required: true,
        maxlength: "254",
      },
    });
    const emailField = field("Bambu account email", email, "be-error");
    const submit = action("Email me a code", null, "submit");
    form.append(
      field("Region", region, "br-error").wrap,
      emailField.wrap,
      element("div", { className: "row" }, [submit]),
    );

    email.addEventListener("input", () =>
      setFieldError(email, emailField.error, emailError(email.value))
    );
    email.addEventListener("invalid", () => {
      const message = emailError(email.value) ?? "Enter a valid email address.";
      setFieldError(email, emailField.error, message);
      announce(message);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const validation = emailError(email.value);
      const nativeMessage = email.validity.valid ? validation : (validation ?? "Enter a valid email address.");
      setFieldError(email, emailField.error, nativeMessage);
      if (nativeMessage !== null || !form.checkValidity()) {
        present({ announcement: nativeMessage, focus: "#be" });
        return;
      }

      submit.disabled = true;
      clearFlowError(byId("l1"));
      try {
        const result = await apiSession.request("POST", "/v1/enrol/code", {
          region: region.value,
          email: email.value.trim(),
        });
        if (result.status === 401) return;
        if (result.status === 204 || result.status === 200) {
          state.email = email.value.trim();
          state.region = region.value;
          transition("code", {
            announcement: "Code sent. Enter the newest code from Bambu.",
            focus: "#bc",
          });
          return;
        }
        present({
          announcement: result.body?.error ?? "Bambu Cloud could not send a code. Try again shortly.",
          errorTarget: byId("l1"),
          errorText: result.body?.error ?? "Bambu Cloud could not send a code. Try again shortly.",
        });
      } catch {
        present({ announcement: RETRYABLE_MESSAGE, errorTarget: byId("l1"), errorText: RETRYABLE_MESSAGE });
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function codeForm() {
    const form = element("form");
    const code = element("input", {
      attributes: {
        id: "bc",
        name: "code",
        type: "text",
        inputmode: "numeric",
        autocomplete: "one-time-code",
        pattern: "[0-9]{4,10}",
        minlength: "4",
        maxlength: "10",
        required: true,
      },
    });
    const codeField = field("Code", code, "bc-error");
    const submit = action("Connect", null, "submit");
    const back = action("Use a different email", "quiet");
    back.dataset.act = "back";
    back.addEventListener("click", () => transition("email", { announcement: "Enter your Bambu account email.", focus: "#be" }));
    form.append(codeField.wrap, element("div", { className: "row" }, [submit, back]));

    code.addEventListener("input", () =>
      setFieldError(code, codeField.error, codeError(code.value))
    );
    code.addEventListener("invalid", () => {
      const message = codeError(code.value) ?? "Enter the 4 to 10 digit code Bambu emailed you.";
      setFieldError(code, codeField.error, message);
      announce(message);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const validation = codeError(code.value);
      const nativeMessage = code.validity.valid ? validation : (validation ?? "Enter the 4 to 10 digit code Bambu emailed you.");
      setFieldError(code, codeField.error, nativeMessage);
      if (nativeMessage !== null || !form.checkValidity()) {
        present({ announcement: nativeMessage, focus: "#bc" });
        return;
      }

      submit.disabled = true;
      clearFlowError(byId("l1"));
      try {
        const result = await apiSession.request("POST", "/v1/enrol/session", {
          region: state.region,
          email: state.email,
          code: code.value.trim(),
        });
        if (result.status === 401) return;
        if (result.status === 200 && Array.isArray(result.body?.printers)) {
          state.email = null;
          state.printers = result.body.printers;
          state.selectedDeviceIds = orderedSelection(
            state.printers,
            state.account?.device_ids ?? [],
          );
          transition("printers", {
            announcement: "Signed in. Choose and order up to three printers.",
            focus: "#l2h",
          });
          return;
        }
        const message = result.body?.error ?? "That code was not accepted.";
        present({ announcement: message, errorTarget: byId("l1"), errorText: message, focus: "#bc" });
      } catch {
        present({ announcement: RETRYABLE_MESSAGE, errorTarget: byId("l1"), errorText: RETRYABLE_MESSAGE, focus: "#bc" });
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function printerForm() {
    const form = element("form");
    const list = element("fieldset", { className: "printers" });
    list.append(element("legend", { text: "Printers and display order" }));

    state.printers.forEach((printer, index) => {
      const selectedIndex = state.selectedDeviceIds.indexOf(printer.deviceId);
      const selected = selectedIndex >= 0;
      const inputId = `printer-${index}`;
      const checkbox = element("input", {
        attributes: {
          id: inputId,
          type: "checkbox",
          name: "p",
          value: printer.deviceId,
          checked: selected,
        },
      });
      checkbox.checked = selected;
      const name = element("span", { className: "name", text: printer.name });
      const status = `${printer.online ? "online" : "offline"}${printer.model ? ` · ${printer.model}` : ""}`;
      const meta = element("span", {
        className: "meta",
        text: status,
        attributes: { "data-online": String(printer.online) },
      });
      const label = element("label", { attributes: { for: inputId } }, [name, element("br"), meta]);
      const rank = element("span", {
        className: "rank",
        text: selected ? (selectedIndex === 0 ? "Lead" : String(selectedIndex + 1)) : "—",
        attributes: { "aria-label": selected ? `Display position ${selectedIndex + 1}` : "Not selected" },
      });
      const up = action("Up", "quiet");
      const down = action("Down", "quiet");
      up.setAttribute("aria-label", `Move ${printer.name} up`);
      down.setAttribute("aria-label", `Move ${printer.name} down`);
      up.disabled = !selected || selectedIndex === 0;
      down.disabled = !selected || selectedIndex === state.selectedDeviceIds.length - 1;

      checkbox.addEventListener("change", () => {
        const changed = changeSelection(state.selectedDeviceIds, printer.deviceId, checkbox.checked);
        if (!changed.ok) {
          checkbox.checked = false;
          present({ announcement: changed.guidance, errorTarget: byId("l2"), errorText: changed.guidance });
          return;
        }
        state.selectedDeviceIds = changed.order;
        transition("printers", {
          announcement: checkbox.checked
            ? `${printer.name} added in position ${state.selectedDeviceIds.length}.`
            : `${printer.name} removed.`,
          focusDeviceId: printer.deviceId,
        });
      });
      up.addEventListener("click", () => {
        state.selectedDeviceIds = moveSelection(state.selectedDeviceIds, printer.deviceId, "up");
        transition("printers", { announcement: `${printer.name} moved up.`, focusDeviceId: printer.deviceId });
      });
      down.addEventListener("click", () => {
        state.selectedDeviceIds = moveSelection(state.selectedDeviceIds, printer.deviceId, "down");
        transition("printers", { announcement: `${printer.name} moved down.`, focusDeviceId: printer.deviceId });
      });

      list.append(
        element("div", { className: "printer", attributes: { "data-selected": String(selected) } }, [
          checkbox,
          label,
          rank,
          element("div", { className: "order-controls" }, [up, down]),
        ]),
      );
    });

    if (state.printers.length === 0) {
      list.append(element("p", { className: "note", text: "No printers are currently bound to this Bambu account." }));
    }
    const submit = action("Show these printers", null, "submit");
    form.append(list, element("div", { className: "row" }, [submit]));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.selectedDeviceIds.length === 0) {
        present({
          announcement: "Choose at least one printer.",
          errorTarget: byId("l2"),
          errorText: "Choose at least one printer.",
          focus: 'input[name="p"]',
        });
        return;
      }
      submit.disabled = true;
      clearFlowError(byId("l2"));
      try {
        const result = await apiSession.request("POST", "/v1/enrol/printers", {
          deviceIds: state.selectedDeviceIds,
        });
        if (result.status === 401) return;
        if (result.status === 409 && result.body?.reauth_required === true) {
          state.account = { device_ids: [...state.selectedDeviceIds], reauth_required: true };
          transition("email", { announcement: "Your saved Bambu sign-in expired. Sign in again.", focus: "#be" });
          return;
        }
        if (result.status === 204 || result.status === 200) {
          state.account = { device_ids: [...state.selectedDeviceIds], reauth_required: false };
          state.printers = null;
          transition("done", {
            announcement: `${chosenSummary(state.selectedDeviceIds.length)}. Setup complete.`,
            focus: "#l3h",
          });
          return;
        }
        const message = result.body?.error ?? "Could not save that selection.";
        present({ announcement: message, errorTarget: byId("l2"), errorText: message });
      } catch {
        present({ announcement: RETRYABLE_MESSAGE, errorTarget: byId("l2"), errorText: RETRYABLE_MESSAGE });
      } finally {
        submit.disabled = false;
      }
    });

    return form;
  }

  function donePanel() {
    const wrap = element("div");
    wrap.append(element("p", { text: "Done — your printers ride the next refresh. E-paper is patient; give it a few minutes." }));
    if (apiSession.backUrl !== null) {
      const link = element("a", {
        className: "action",
        text: "Back to TRMNL",
        attributes: { href: apiSession.backUrl },
      });
      wrap.append(element("div", { className: "row" }, [link]));
    }
    return wrap;
  }

  function managePanel() {
    const wrap = element("div");
    const count = state.account.device_ids.length;
    if (state.account.reauth_required) {
      wrap.append(element("div", {
        className: "msg",
        text: "Bambu stopped accepting the saved sign-in, so updates paused. Sign in again to choose printers.",
      }));
    }
    wrap.append(element("p", {
      text: `${count === 0 ? "No printers chosen yet." : `Showing ${count} printer${count === 1 ? "" : "s"}.`} TRMNL redraws the panel on its own schedule.`,
    }));

    const change = action("Change printers", "quiet");
    change.dataset.act = "printers";
    const remove = action("Delete everything", "danger");
    remove.dataset.act = "del";
    const confirmation = element("div", {
      attributes: {
        "data-delete-confirm": true,
        hidden: true,
        role: "group",
        "aria-label": "Confirm deletion",
      },
    });
    confirmation.append(
      element("p", {
        text: "Delete the hosted account, saved sign-in, printer selection, and screen data? This cannot be undone.",
      }),
    );
    const cancel = action("Cancel", "quiet");
    cancel.dataset.act = "cancel-delete";
    const confirm = action("Confirm deletion", "danger");
    confirm.dataset.act = "confirm-delete";
    confirmation.append(element("div", { className: "row" }, [cancel, confirm]));
    wrap.append(element("div", { className: "row" }, [change, remove]), confirmation);

    change.addEventListener("click", async () => {
      if (state.account.reauth_required) {
        transition("email", { announcement: "Sign in to Bambu again.", focus: "#be" });
        return;
      }
      change.disabled = true;
      try {
        const result = await apiSession.request("GET", "/v1/enrol/printers");
        if (result.status === 401) return;
        if (result.status === 409 && result.body?.reauth_required === true) {
          state.account.reauth_required = true;
          transition("email", { announcement: "Your saved Bambu sign-in expired. Sign in again.", focus: "#be" });
          return;
        }
        if (result.status === 200 && Array.isArray(result.body?.printers)) {
          state.printers = result.body.printers;
          state.selectedDeviceIds = orderedSelection(state.printers, state.account.device_ids);
          transition("printers", {
            announcement: "Printer list loaded. Change the selection or display order.",
            focus: "#l2h",
          });
          return;
        }
        const message = result.body?.error ?? "Could not load your printers.";
        present({ announcement: message, errorTarget: byId("l3"), errorText: message, focus: '[data-act="printers"]' });
      } catch {
        present({ announcement: RETRYABLE_MESSAGE, errorTarget: byId("l3"), errorText: RETRYABLE_MESSAGE, focus: '[data-act="printers"]' });
      } finally {
        change.disabled = false;
      }
    });

    remove.addEventListener("click", () => {
      remove.disabled = true;
      confirmation.hidden = false;
      present({ announcement: "Deletion confirmation opened.", focus: '[data-act="cancel-delete"]' });
    });
    cancel.addEventListener("click", () => {
      clearFlowError(confirmation);
      confirmation.hidden = true;
      remove.disabled = false;
      present({ announcement: "Deletion cancelled.", focus: '[data-act="del"]' });
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      clearFlowError(confirmation);
      try {
        const result = await apiSession.request("DELETE", "/v1/account");
        if (result.status === 401) return;
        if (result.status === 204 || result.status === 200) {
          state.account = null;
          state.email = null;
          state.printers = null;
          state.selectedDeviceIds = [];
          transition("email", {
            announcement: "Everything was deleted. You can connect Bambu Cloud again.",
            focus: "#be",
          });
          return;
        }
        const message = result.body?.error ?? "Could not delete the account.";
        present({ announcement: message, errorTarget: confirmation, errorText: message, focus: '[data-act="confirm-delete"]' });
      } catch {
        present({ announcement: RETRYABLE_MESSAGE, errorTarget: confirmation, errorText: RETRYABLE_MESSAGE, focus: '[data-act="confirm-delete"]' });
      } finally {
        confirm.disabled = false;
        cancel.disabled = false;
      }
    });
    return wrap;
  }

  function layerIntro(text, body) {
    const wrap = element("div");
    if (text) wrap.append(element("p", { text }));
    wrap.append(body);
    return wrap;
  }

  function render(view, options = {}) {
    stack.hidden = false;
    boot.hidden = true;
    if (view === "email") {
      state.email = null;
      state.printers = null;
      state.selectedDeviceIds = [];
      paint("l1", "active", {
        number: "01",
        title: "Sign in to Bambu",
        body: layerIntro("Bambu emails you a one-time code. Your password never reaches us.", emailForm()),
      });
      paint("l2", "pending", { number: "02", title: "Pick your printers" });
      paint("l3", "pending", { number: "03", title: "On the wall" });
      return;
    }
    if (view === "code") {
      paint("l1", "active", {
        number: "01",
        title: "Enter the code Bambu emailed you",
        body: layerIntro(`Sent to ${state.email}. Codes expire quickly, so use the newest one.`, codeForm()),
      });
      paint("l2", "pending", { number: "02", title: "Pick your printers" });
      paint("l3", "pending", { number: "03", title: "On the wall" });
      return;
    }
    if (view === "printers") {
      paint("l1", "done", { number: "01", title: "Sign in to Bambu", summary: "Signed in" });
      paint("l2", "active", {
        number: "02",
        title: "Pick and order your printers",
        body: layerIntro(
          "Choose up to three. Use Up and Down to put the lead printer first.",
          printerForm(),
        ),
      });
      paint("l3", "pending", { number: "03", title: "On the wall" });
      return;
    }
    if (view === "done") {
      paint("l1", "done", { number: "01", title: "Sign in to Bambu", summary: "Signed in" });
      paint("l2", "done", {
        number: "02",
        title: "Pick your printers",
        summary: chosenSummary(state.selectedDeviceIds.length),
      });
      paint("l3", "active", { number: "03", title: "On the wall", body: donePanel() });
      return;
    }
    if (view === "manage") {
      paint("l1", "done", { number: "01", title: "Sign in to Bambu", summary: "Signed in" });
      paint("l2", "done", {
        number: "02",
        title: "Pick your printers",
        summary: chosenSummary(state.account.device_ids.length),
      });
      paint("l3", "active", { number: "03", title: "On the wall", body: managePanel() });
    }
  }

  function transition(view, options = {}) {
    currentView = view;
    render(view, options);
    present(options);
    if (options.focusDeviceId !== undefined) {
      const selected = [...document.querySelectorAll('input[name="p"]')].find(
        (input) => input.value === options.focusDeviceId,
      );
      selected?.focus();
    }
  }

  function showAccess(message, announcement = message, retry = false) {
    currentView = "access";
    stack.hidden = true;
    boot.hidden = false;
    boot.replaceChildren(element("p", { text: message }));
    if (retry) {
      const button = action("Try again", "quiet");
      button.addEventListener("click", () => void restore());
      boot.append(button);
    }
    present({ announcement, focus: "#boot" });
  }

  function expireAccess() {
    state.account = null;
    state.email = null;
    state.printers = null;
    state.selectedDeviceIds = [];
    showAccess(
      "This link has expired — open the plugin's Configure button in TRMNL to get a fresh one.",
      "This setup link expired. Open Configure in TRMNL for a fresh link.",
    );
  }

  function loadFailed() {
    showAccess(RETRYABLE_MESSAGE, RETRYABLE_MESSAGE, true);
  }

  async function restore() {
    if (!apiSession.hasAccess) {
      showAccess("Open this page from the TRMNL plugin — install it or press its Configure button.");
      return;
    }
    boot.hidden = false;
    boot.replaceChildren(element("p", { text: "Loading your setup…" }));
    stack.hidden = true;
    announce("Loading your setup.");
    try {
      const result = await apiSession.request("GET", "/v1/account");
      if (result.status === 401) return;
      if (result.status === 200 && Array.isArray(result.body?.device_ids)) {
        state.account = result.body;
        transition("manage", { announcement: "Your setup is ready to manage.", focus: "#l3h" });
        return;
      }
      if (result.status === 404) {
        state.account = null;
        transition("email", { announcement: "Connect your Bambu account.", focus: "#be" });
        return;
      }
      const message = result.body?.error ?? RETRYABLE_MESSAGE;
      showAccess(message, message, true);
    } catch {
      showAccess(RETRYABLE_MESSAGE, RETRYABLE_MESSAGE, true);
    }
  }

  async function start() {
    if (!apiSession.captureAccess()) {
      showAccess("Open this page from the TRMNL plugin — install it or press its Configure button.");
      return;
    }
    await restore();
  }

  return {
    start,
    expireAccess,
    loadFailed,
    state,
    get currentView() {
      return currentView;
    },
  };
}
