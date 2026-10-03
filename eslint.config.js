import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["**/dist/**", "**/dist-e2e*/**", "**/test-results/**", "**/node_modules/**", "**/.maypop/**", "**/coverage/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Source text and user reports are untrusted: never render raw HTML.
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Never render raw HTML. Source content and user reports are untrusted.",
        },
      ],
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: "Never assign raw HTML. Use text content." },
        { property: "outerHTML", message: "Never assign raw HTML. Use text content." },
      ],
    },
  },
  {
    files: [
      "**/*.mjs",
      "eslint.config.js",
      "apps/web/vite.config.ts",
      "apps/web/vitest.config.ts",
      "apps/web/playwright.config.ts",
      "apps/web/build/**/*.ts",
      "apps/web/e2e/**/*.ts",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/web/public/**/*.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
  },
]);
