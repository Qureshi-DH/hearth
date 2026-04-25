import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["dist/**", "src/db/migrations/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      // Fastify plugins and Drizzle builders are full of floating thenables that
      // are genuinely fire and forget, so this is a warning rather than an error.
      "@typescript-eslint/no-floating-promises": "warn",
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    files: ["src/db/seed.ts", "src/db/migrate-cli.ts", "src/index.ts"],
    rules: { "no-console": "off" },
  },
)
