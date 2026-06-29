import { useEffect, useMemo, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import {
  buildReportMailto,
  buildTrace,
  copyTraceToClipboard,
  logTrace,
  type ErrorTrace,
} from "@/lib/error-trace";
import { reportLovableError } from "@/lib/lovable-error-reporting";

type Props = {
  error: Error;
  reset: () => void;
  source: string;
  variant?: "page" | "boundary"; // page = full-screen (root), boundary = scoped (router default)
};

export function ErrorFallback({ error, reset, source, variant = "boundary" }: Props) {
  const router = useRouter();
  const trace = useMemo<ErrorTrace>(() => buildTrace(error), [error]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    logTrace(trace, source);
    reportLovableError(error, { boundary: source, traceId: trace.traceId, route: trace.route });
  }, [error, source, trace]);

  const mailto = buildReportMailto(trace);
  const wrapClass =
    variant === "page"
      ? "flex min-h-screen items-center justify-center bg-background px-4"
      : "flex min-h-[60vh] items-center justify-center px-4";

  const onCopy = async () => {
    const ok = await copyTraceToClipboard(trace);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  };

  const onTryAgain = () => {
    router.invalidate();
    reset();
  };

  return (
    <div role="alert" aria-live="polite" className={wrapClass}>
      <div className="w-full max-w-lg rounded-lg border border-border/60 bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          Something went wrong on this page
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The page failed to load. You can try again, head back, or report the issue —
          we&apos;ll have everything we need to investigate.
        </p>

        <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Try again — most issues resolve on retry.</li>
          <li>If it persists, go back to a previous screen or your projects.</li>
          <li>If you&apos;re stuck, report it with the trace ID below.</li>
        </ol>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onTryAgain}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => router.history.back()}
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            Go back
          </button>
          <Link
            to="/projects"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            My projects
          </Link>
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            Go home
          </Link>
        </div>

        <div className="mt-6 rounded-md border border-border/60 bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              Trace ID
              <code className="ml-2 rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {trace.traceId}
              </code>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onCopy}
                className="rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
              >
                {copied ? "Copied" : "Copy details"}
              </button>
              <a
                href={mailto}
                className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:opacity-90"
              >
                Report by email
              </a>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Include the trace ID in your message — it links to the diagnostic logs.
          </p>
        </div>
      </div>
    </div>
  );
}