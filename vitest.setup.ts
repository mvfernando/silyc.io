// jsdom doesn't ship ResizeObserver; Radix Slider needs it.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error — assigning global polyfill
globalThis.ResizeObserver = globalThis.ResizeObserver ?? ResizeObserverStub;