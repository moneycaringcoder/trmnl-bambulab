const TOKEN_STORAGE_NAME = "trmnlManageToken";
const BACK_STORAGE_NAME = "trmnlBackUrl";

export function validBackUrl(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "trmnl.com" || url.hostname.endsWith(".trmnl.com"))
      ? value
      : null;
  } catch {
    return null;
  }
}

export function createApiSession({
  fetch: fetchRequest,
  location,
  history,
  storage,
  onExpired,
}) {
  let manageToken = null;
  let backUrl = null;

  function read(name) {
    try {
      return storage.getItem(name);
    } catch {
      return null;
    }
  }

  function write(name, value) {
    try {
      storage.setItem(name, value);
    } catch {
      // The current page still works when browser storage is unavailable.
    }
  }

  function remove(name) {
    try {
      storage.removeItem(name);
    } catch {
      // Nothing else needs clearing.
    }
  }

  function captureAccess() {
    const params = new URLSearchParams(location.hash.slice(1));
    const fragmentToken = params.get("manage");
    const fragmentBack = validBackUrl(params.get("back"));

    if (fragmentToken !== null && fragmentToken !== "") {
      manageToken = fragmentToken;
      write(TOKEN_STORAGE_NAME, fragmentToken);
      backUrl = fragmentBack;
      if (backUrl === null) remove(BACK_STORAGE_NAME);
      else write(BACK_STORAGE_NAME, backUrl);
    } else {
      manageToken = read(TOKEN_STORAGE_NAME);
      backUrl = fragmentBack ?? validBackUrl(read(BACK_STORAGE_NAME));
      if (fragmentBack !== null) write(BACK_STORAGE_NAME, fragmentBack);
    }

    if (location.hash !== "") {
      history.replaceState(history.state, "", `${location.pathname}${location.search}`);
    }
    return manageToken !== null;
  }

  function expire() {
    manageToken = null;
    remove(TOKEN_STORAGE_NAME);
    onExpired();
  }

  async function request(method, path, body) {
    if (manageToken === null) {
      expire();
      return { status: 401, body: null };
    }

    const init = {
      method,
      headers: { Authorization: `Bearer ${manageToken}` },
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetchRequest(path, init);
    const text = await response.text();
    let parsed = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (response.status === 401) expire();
    return { status: response.status, body: parsed };
  }

  return {
    captureAccess,
    request,
    get backUrl() {
      return backUrl;
    },
    get hasAccess() {
      return manageToken !== null;
    },
  };
}
