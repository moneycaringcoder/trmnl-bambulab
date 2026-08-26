export const MAX_PRINTERS = 3;

export function createSetupState() {
  return {
    account: null,
    email: null,
    region: "global",
    printers: null,
    selectedDeviceIds: [],
  };
}

export function emailError(value) {
  const email = String(value).trim();
  if (email === "") return "Enter the email address of your Bambu account.";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return "Enter a valid email address.";
  }
  return null;
}

export function codeError(value) {
  const code = String(value).trim();
  if (code === "") return "Enter the code Bambu emailed you.";
  if (!/^[0-9]{4,10}$/.test(code)) return "Enter the 4 to 10 digit code Bambu emailed you.";
  return null;
}

export function orderedSelection(printers, requested = []) {
  const known = new Set(printers.map((printer) => printer.deviceId));
  const selected = [];
  for (const deviceId of requested) {
    if (known.has(deviceId) && !selected.includes(deviceId) && selected.length < MAX_PRINTERS) {
      selected.push(deviceId);
    }
  }
  if (requested.length === 0) {
    for (const printer of printers) {
      if (selected.length === MAX_PRINTERS) break;
      if (!selected.includes(printer.deviceId)) selected.push(printer.deviceId);
    }
  }
  return selected;
}

export function changeSelection(order, deviceId, selected) {
  const next = order.filter((entry) => entry !== deviceId);
  if (!selected) return { ok: true, order: next };
  if (next.length >= MAX_PRINTERS) {
    return {
      ok: false,
      order: [...order],
      guidance: "Three printers is the most the display can show legibly.",
    };
  }
  next.push(deviceId);
  return { ok: true, order: next };
}

export function moveSelection(order, deviceId, direction) {
  const from = order.indexOf(deviceId);
  if (from < 0) return [...order];
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function chosenSummary(count) {
  return `${count} printer${count === 1 ? "" : "s"} chosen`;
}
