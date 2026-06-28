/// <reference types="vitest/globals" />
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInView, usePrefersReducedMotion } from "./use-in-view";

type Cb = (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;

// Capture the observer callback so tests can drive intersection state.
let lastCb: Cb | null = null;
const observe = vi.fn();
const disconnect = vi.fn();

class MockIO {
  constructor(cb: Cb) {
    lastCb = cb;
  }
  observe = observe;
  unobserve = vi.fn();
  disconnect = disconnect;
  takeRecords = () => [];
  root = null;
  rootMargin = "";
  thresholds = [];
}

beforeEach(() => {
  lastCb = null;
  observe.mockClear();
  disconnect.mockClear();
  // @ts-expect-error – install mock
  globalThis.IntersectionObserver = MockIO;
  // Make rAF synchronous so state updates are observable.
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fire(intersecting: boolean) {
  act(() => {
    lastCb?.([{ isIntersecting: intersecting, target: document.createElement("div") }]);
  });
}

describe("useInView — drives the animation-play gate", () => {
  it("starts hidden, observes the element, and stops observing on unmount", () => {
    const { result, unmount } = renderHook(() => useInView<HTMLDivElement>());
    // Attach the ref to a real DOM node so the effect can observe it.
    act(() => {
      (result.current.ref as { current: HTMLDivElement | null }).current =
        document.createElement("div");
    });
    // Re-render to run the effect with the attached node.
    const { result: r2, unmount: u2 } = renderHook(() => {
      const v = useInView<HTMLDivElement>();
      (v.ref as { current: HTMLDivElement | null }).current = document.createElement("div");
      return v;
    });
    expect(r2.current.inView).toBe(false);
    u2();
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("turns the play-gate on when the section enters and off when it leaves", () => {
    const { result } = renderHook(() => useInView<HTMLDivElement>());
    act(() => {
      (result.current.ref as { current: HTMLDivElement | null }).current =
        document.createElement("div");
    });

    // Section enters → animations should start.
    fire(true);
    expect(result.current.inView).toBe(true);

    // Section leaves → animations should stop.
    fire(false);
    expect(result.current.inView).toBe(false);

    // Re-entering must resume.
    fire(true);
    expect(result.current.inView).toBe(true);
  });

  it("falls back to inView=true when IntersectionObserver is unavailable", () => {
    // @ts-expect-error – remove
    delete globalThis.IntersectionObserver;
    const { result } = renderHook(() => useInView<HTMLDivElement>());
    expect(result.current.inView).toBe(true);
  });
});

describe("usePrefersReducedMotion — disables animations for users that asked for it", () => {
  function mockMatchMedia(matches: boolean) {
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const mql = {
      matches,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
      removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
      dispatchEvent: () => false,
    };
    vi.stubGlobal("matchMedia", () => mql);
    // @ts-expect-error – install on window
    window.matchMedia = () => mql;
    return {
      mql,
      change: (next: boolean) =>
        listeners.forEach((l) => l({ matches: next } as MediaQueryListEvent)),
    };
  }

  it("returns true when the OS prefers reduced motion (animations must NOT auto-play)", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it("reacts to live OS changes", () => {
    const { change } = mockMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => change(true));
    expect(result.current).toBe(true);
  });
});