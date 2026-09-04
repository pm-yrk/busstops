// @ts-check
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

/** Globals available to Node scripts and pipeline entry points. */
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  fetch: "readonly",
  Request: "readonly",
  Response: "readonly",
  Headers: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  crypto: "readonly",
  RequestInit: "readonly",
  ResponseInit: "readonly",
  HeadersInit: "readonly",
  BodyInit: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  structuredClone: "readonly",
};

/** Browser globals used by apps/web. */
const browserGlobals = {
  ...nodeGlobals,
  document: "readonly",
  window: "readonly",
  navigator: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  location: "readonly",
  history: "readonly",
  DOMException: "readonly",
  HTMLElement: "readonly",
  HTMLButtonElement: "readonly",
  HTMLDivElement: "readonly",
  HTMLInputElement: "readonly",
  Element: "readonly",
  Node: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  MutationObserver: "readonly",
  ResizeObserver: "readonly",
  IntersectionObserver: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  matchMedia: "readonly",
  getComputedStyle: "readonly",
  scrollTo: "readonly",
};

export default [
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: nodeGlobals,
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // Node scripts that drive a browser: the bodies passed to page.evaluate run in the page, so
    // they legitimately reference browser globals.
    files: ["tools/pixel-art/page-shots.mjs"],
    languageOptions: {
      globals: browserGlobals,
    },
  },
  {
    // The end-to-end suite runs in Node but evaluates code inside the browser via page.evaluate,
    // so it legitimately references browser globals.
    files: ["apps/web/**/*.{ts,tsx}", "tests/e2e/**/*.ts"],
    languageOptions: {
      globals: browserGlobals,
    },
    plugins: {
      "react-hooks": reactHooks,
      // Accessibility is a build gate, not a review checklist: WCAG 2.2 AA is the target.
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  {
    // Pipeline and script entry points: their console output is the operator-facing interface.
    files: ["pipelines/*/run-*.ts", "scripts/**"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "tests/fixtures/raw/**",
    ],
  },
  prettier,
];
