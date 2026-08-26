import { createApiSession } from "./api-session.js";
import { createSetupApp } from "./setup-render.js";

export function boot(windowObject = window) {
  let app;
  let storage;
  try {
    storage = windowObject.sessionStorage;
  } catch {
    storage = {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    };
  }
  const apiSession = createApiSession({
    fetch: windowObject.fetch.bind(windowObject),
    location: windowObject.location,
    history: windowObject.history,
    storage,
    onExpired() {
      app?.expireAccess();
    },
  });
  app = createSetupApp({ document: windowObject.document, apiSession });
  void app.start().catch(() => app.loadFailed());
  return app;
}

if (typeof window !== "undefined" && typeof document !== "undefined") boot(window);
