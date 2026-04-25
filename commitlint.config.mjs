/** @type {import("@commitlint/types").UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      ["server", "mobile", "shared", "docs", "ci", "deps", "db", "deploy", "repo"],
    ],
    "body-max-line-length": [1, "always", 100],
  },
}
