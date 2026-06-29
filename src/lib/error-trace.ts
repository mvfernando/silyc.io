// Lightweight client-side error tracing: generates a short, copyable trace
// ID for every rendered error boundary and exposes a `mailto:` reporter so
// users can send context to support without leaking PII.

export type ErrorTrace = {
  traceId: string;
  at: string; // ISO timestamp
  route: string;
  userAgent: string;
  message: string;
  stackHead: string; // first 6 stack lines
};

function rand4(): string {
  // 4 hex chars without depending on crypto.randomUUID (SSR-safe).
  const n = Math.floor(Math.random() * 0xffff);
  return n.toString(16).padStart(4, "0");
}

export function generateTraceId(): string {
  const now = Date.now().toString(36).toUpperCase();
  return `SLY-${now}-${rand4().toUpperCase()}`;
}

export function buildTrace(error: unknown): ErrorTrace {
  const err = error instanceof Error ? error : new Error(String(error));
  const stack = (err.stack ?? "").split("\n").slice(0, 6).join("\n");
  return {
    traceId: generateTraceId(),
    at: new Date().toISOString(),
    route: typeof window !== "undefined" ? window.location.pathname + window.location.search : "ssr",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "ssr",
    message: err.message || "Unknown error",
    stackHead: stack,
  };
}

export function buildReportMailto(trace: ErrorTrace, to = "eu@mvfernando.rf.gd"): string {
  const subject = `Silyc — Error report ${trace.traceId}`;
  const body = [
    "Hi,",
    "",
    "I hit an error in Silyc. Details below:",
    "",
    `Trace ID: ${trace.traceId}`,
    `When: ${trace.at}`,
    `Route: ${trace.route}`,
    `Message: ${trace.message}`,
    "",
    "What I was doing:",
    "(please describe in a couple of words)",
    "",
    "— technical context —",
    `User agent: ${trace.userAgent}`,
    trace.stackHead ? `Stack:\n${trace.stackHead}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export async function copyTraceToClipboard(trace: ErrorTrace): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    const payload = JSON.stringify(
      {
        traceId: trace.traceId,
        at: trace.at,
        route: trace.route,
        message: trace.message,
        userAgent: trace.userAgent,
        stack: trace.stackHead,
      },
      null,
      2,
    );
    await navigator.clipboard.writeText(payload);
    return true;
  } catch {
    return false;
  }
}

/** Log a structured line so the trace is grep-able in browser/console logs. */
export function logTrace(trace: ErrorTrace, source: string): void {
  if (typeof console === "undefined") return;
  // eslint-disable-next-line no-console
  console.error(`[silyc:error] ${source} trace=${trace.traceId} route=${trace.route} msg="${trace.message}"`);
}