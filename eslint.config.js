import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/dist-types/**", "**/.wrangler/**", "node_modules/**", "supabase/functions/**", "packages/shared/src/database.types.ts"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node, ...globals.serviceworker } },
    rules: {
      "no-console": ["error", { allow: ["log"] }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
