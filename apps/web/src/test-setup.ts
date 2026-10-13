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

/*
 * jsdom has no object URLs, and MapLibre asks for one at import time to build its worker. Any
 * test that imports a page containing the map therefore fails before it renders anything.
 *
 * Stubbed rather than worked around by not importing the page: the deep link that decides where
 * the map opens is a property of the page, and testing a copy of it would test the copy. Nothing
 * here makes the map work in jsdom — it cannot, there is no WebGL — it only lets the module load
 * so the parts that are not the canvas can be exercised.
 */
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
}
