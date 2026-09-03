import "@testing-library/jest-dom/vitest";

/**
 * jsdom does not implement these, and MapLibre plus the layout code touch them. Stubbing them
 * here keeps component tests focused on behaviour rather than environment plumbing.
 */

if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
}

if (!globalThis.scrollTo) {
  globalThis.scrollTo = (() => {}) as unknown as typeof globalThis.scrollTo;
}
