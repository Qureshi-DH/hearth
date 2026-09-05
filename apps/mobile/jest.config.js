/** @type {import('@jest/types').Config.ProjectConfig} */
module.exports = {
  preset: "jest-expo",
  globalSetup: "<rootDir>/test/globalSetup.js",
  setupFiles: ["<rootDir>/test/setup.ts"],
}
