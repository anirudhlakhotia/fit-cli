// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The config file itself isn't part of the TS project, so turn off
    // type-aware linting for plain JS files.
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // node:test's top-level test() calls intentionally return floating promises.
    files: ["**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
