import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "eslint.config.js",
      "node_modules/**",
      "scripts/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" }
      ],
      "@typescript-eslint/no-confusing-void-expression": "error"
    }
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/require-await": "off",
      // Prototype-patching tests (pg/redis/mysql2/mongodb DB wrappers, fs.promises)
      // legitimately capture/compare/reassign class-instance method REFERENCES
      // off a `.prototype` object without ever calling them detached — the
      // exact "monkey-patch for testing" false-positive typescript-eslint's
      // own docs call out for this rule. Never relaxed in src/.
      "@typescript-eslint/unbound-method": "off"
    }
  }
);
