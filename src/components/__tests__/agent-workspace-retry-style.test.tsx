/**
 * Regression test for the "Try again" → chosen editing style bug.
 *
 * Zero-config workspace: the user no longer picks a style. The intent
 * ("natural") is derived internally and frozen for the run so Retry
 * always re-runs with the exact same intent the failed run used.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks (declared before importing the component under test)
// ---------------------------------------------------------------------------

// Capture every call to runAgent so we can assert on `intent`.
const runAgentCalls: Array<Record<string, unknown>> = [];

let firstRunReject: ((err: Error) => void) | null = null;
let secondRunResolveShim: (() => void) | null = null;

vi.mock("@/lib/agent", () => ({
  runAgent: (input: Record<string, unknown>) => {
    runAgentCalls.push(input);
    const idx = runAgentCalls.length;
    if (idx === 1) {
      return {
        promise: new Promise((_resolve, reject) => {
          firstRunReject = reject;
        }),
        cancel: () => {},
        isCancelled: () => false,
        pause: () => {},
        resume: () => {},
        isPaused: () => false,
      };
    }
    // Second run: hang forever — the test only needs to prove it was
    // *invoked* with the right intent.
    return {
      promise: new Promise(() => {
        secondRunResolveShim = () => {};
      }),
      cancel: () => {},
      isCancelled: () => false,
      pause: () => {},
      resume: () => {},
      isPaused: () => false,
    };
  },
  weightedGlobalProgress: () => 0,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => (
    <a {...(rest as Record<string, unknown>)}>{children}</a>
  ),
  useNavigate: () => () => {},
  useBlocker: () => ({ status: "idle", reset: () => {}, proceed: () => {} }),
}));

vi.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get: () => (props: Record<string, unknown>) => {
        const { children, ...rest } = props as { children?: React.ReactNode };
        return <div {...(rest as Record<string, unknown>)}>{children}</div>;
      },
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("sonner", () => ({
  toast: { error: () => {}, success: () => {}, warning: () => {} },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
    from: () => ({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({}) }),
    }),
    storage: { from: () => ({ upload: () => Promise.resolve({ error: null }) }) },
  },
}));

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({
    t: new Proxy({} as Record<string, string>, { get: (_t, key) => String(key) }),
    lang: "en",
    setLang: () => {},
  }),
}));

vi.mock("@/lib/validate-upload", () => ({
  validateUpload: () =>
    Promise.resolve({ durationSec: 10, hasAudio: true }),
}));

vi.mock("@/lib/upload-limits", () => ({
  formatFileSize: (n: number) => `${n}B`,
  MAX_UPLOAD_BYTES: 1024 * 1024 * 1024,
}));

vi.mock("@/lib/ffmpeg-processor", () => ({
  formatDuration: (n: number) => `${n}s`,
}));

vi.mock("@/lib/agent-snapshot", () => ({
  clearSnapshot: () => {},
  isRecent: () => false,
  readSnapshot: () => null,
  writeSnapshot: () => {},
}));

vi.mock("@/lib/agent/feedback", () => ({
  saveFeedback: () => Promise.resolve(),
  listRecentFeedback: () => Promise.resolve([]),
}));

// ---------------------------------------------------------------------------
// Import the component AFTER mocks
// ---------------------------------------------------------------------------
import { AgentWorkspace } from "../agent-workspace";

function fakeFile(name = "clip.mp4", size = 5 * 1024): File {
  const blob = new Blob([new Uint8Array(size)], { type: "video/mp4" });
  return new File([blob], name, { type: "video/mp4" });
}

describe("AgentWorkspace — Retry preserves chosen editing style", () => {
  beforeEach(() => {
    cleanup();
    runAgentCalls.length = 0;
    firstRunReject = null;
    secondRunResolveShim = null;
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("re-runs with the same (auto) intent after Try again", async () => {
    render(<AgentWorkspace />);

    // 1. Drop a file into the hidden file input.
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [fakeFile()] });
    fireEvent.change(fileInput);

    // 2. Wait for runAgent to be invoked with the auto intent.
    await waitFor(() => expect(runAgentCalls.length).toBe(1));
    expect(runAgentCalls[0].intent).toBe("natural");

    // 3. Fail the first run.
    firstRunReject?.(new Error("boom"));

    // 4. Wait for the failed stage → Try again button.
    const retryBtn = await screen.findByRole("button", { name: /agent_retry/ });
    fireEvent.click(retryBtn);

    // 5. Second call must reuse the exact same intent.
    await waitFor(() => expect(runAgentCalls.length).toBe(2));
    expect(runAgentCalls[1].intent).toBe(runAgentCalls[0].intent);

    // Silence unused-variable lint for the second-run shim.
    void secondRunResolveShim;
  });
});