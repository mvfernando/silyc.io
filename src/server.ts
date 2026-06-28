import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

// Startup validation: report which cloud-denoise providers are wired.
// fal.ai is opt-in via FAL_KEY; when absent, the orchestrator skips it
// instead of recording a per-call "not configured" failure.
(() => {
  const replicate = Boolean(process.env.REPLICATE_API_TOKEN);
  const fal = Boolean(process.env.FAL_KEY);
  const enabled = [replicate && "replicate", fal && "fal"].filter(Boolean);
  if (enabled.length === 0) {
    console.warn("[startup] cloud-denoise disabled: neither REPLICATE_API_TOKEN nor FAL_KEY set");
  } else {
    console.log(`[startup] cloud-denoise providers enabled: ${enabled.join(", ")}`);
    if (!fal) console.log("[startup] fal.ai disabled (FAL_KEY not set)");
  }
})();

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
