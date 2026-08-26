import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { vi } from "vitest";

export async function setupWindow(responses) {
  const window = new Window({
    url: "https://hosted.example/#manage=management-token&back=https%3A%2F%2Ftrmnl.com%2Fplugins",
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: true,
    },
  });
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  window.document.write(html);
  window.document.close();

  const requests = [];
  const fetch = vi.fn(async (path, init = {}) => {
    requests.push({ path, init });
    const next = responses.shift();
    if (next === undefined) throw new Error(`Unexpected request: ${init.method ?? "GET"} ${path}`);
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.body === undefined ? undefined : { "Content-Type": "application/json" },
    });
  });
  window.fetch = fetch;
  return { window, document: window.document, fetch, requests };
}

export async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function control(document, selector) {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`Missing control: ${selector}`);
  return found;
}
