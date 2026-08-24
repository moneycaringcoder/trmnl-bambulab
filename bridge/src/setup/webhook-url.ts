/**
 * TRMNL webhook URL validation.
 *
 * The webhook URL is a credential: its final path segment is the plugin-setting
 * UUID, and anyone holding it can write to the plugin. Validation is therefore
 * strict about the transport and the shape, and every rejection says what to do
 * next.
 *
 * Pure module.
 */

export const TRMNL_WEBHOOK_PATH_PREFIX = "/api/custom_plugins/";
const TRMNL_HOSTS = ["usetrmnl.com", "www.usetrmnl.com"];
const EXPECTED_SHAPE = "https://usetrmnl.com/api/custom_plugins/<uuid>";

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX32 = /^[0-9a-fA-F]{32}$/;

const WHERE =
  "Open your TRMNL Private Plugin, choose the Webhook strategy, and copy the Webhook URL it shows.";

export interface WebhookUrlOk {
  ok: true;
  /** Normalized absolute URL, without a trailing slash. */
  url: string;
  warnings: string[];
}

export interface WebhookUrlBad {
  ok: false;
  message: string;
  guidance: string;
}

export type WebhookUrlResult = WebhookUrlOk | WebhookUrlBad;

export function validateWebhookUrl(raw: string): WebhookUrlResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, message: "No webhook URL was given.", guidance: WHERE };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: "That is not a URL.",
      guidance: `Paste the whole URL, including \`https://\`. ${WHERE}`,
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      message: `The webhook URL uses \`${parsed.protocol}\` instead of \`https:\`.`,
      guidance:
        "The URL is a credential and must not travel in clear text. Use the `https://` form TRMNL gives you.",
    };
  }

  if (parsed.search !== "" || parsed.hash !== "") {
    return {
      ok: false,
      message: "The webhook URL carries a query string or a fragment.",
      guidance: `Paste only the URL itself, with nothing after the UUID. Expected shape: ${EXPECTED_SHAPE}`,
    };
  }

  if (!parsed.pathname.startsWith(TRMNL_WEBHOOK_PATH_PREFIX)) {
    return {
      ok: false,
      message: `The path is \`${parsed.pathname}\`, which is not a TRMNL webhook path.`,
      guidance: `A webhook URL looks like ${EXPECTED_SHAPE}. ${WHERE}`,
    };
  }

  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  const last = segments[segments.length - 1] ?? "";
  if (!UUID.test(last) && !HEX32.test(last)) {
    return {
      ok: false,
      message: "The last path segment is not a plugin-setting UUID.",
      guidance: `A webhook URL ends in a UUID, like ${EXPECTED_SHAPE}. Copy it again without editing it.`,
    };
  }

  const warnings: string[] = [];
  if (!TRMNL_HOSTS.includes(parsed.hostname)) {
    warnings.push(
      `The host is \`${parsed.hostname}\` rather than usetrmnl.com. That is expected for a self-hosted TRMNL instance, and wrong otherwise.`,
    );
  }

  return { ok: true, url: `${parsed.origin}/${segments.join("/")}`, warnings };
}
