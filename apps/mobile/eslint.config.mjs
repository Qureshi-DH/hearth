import js from "@eslint/js"
import expoConfig from "eslint-config-expo/flat.js"
import prettier from "eslint-plugin-prettier/recommended"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "android/**",
      "ios/**",
      ".expo/**",
      "dist/**",
      "expo-env.d.ts",
      "app-dependency-graph.*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...expoConfig,
  prettier,
  {
    rules: {
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-use-before-define": "off",
      // i18next and typescript-eslint both ship a default export alongside
      // named ones. Using the default is correct here.
      "import/no-named-as-default-member": "off",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              importNames: ["default"],
              message: "Import named exports from 'react' instead.",
            },
            {
              name: "react-native",
              importNames: ["SafeAreaView"],
              message: "Use SafeAreaView from 'react-native-safe-area-context'.",
            },
            {
              name: "react-native",
              importNames: ["Text", "Button", "TextInput"],
              message: "Use the wrapper component from '@/components'.",
            },
            {
              name: "react-native",
              importNames: ["Alert"],
              message: "Use alert() from '@/stores/alert', which draws in the app's theme.",
            },
          ],
        },
      ],
    },
  },
  {
    // eslint-config-expo 58 brought the React Compiler's rules. The app was
    // written before them and the compiler is not on, so what they flag is a
    // change of its own, not part of the SDK upgrade.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/immutability": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "test/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
)
