module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "jsdom",
  testMatch: ["**/*.spec.ts"],
  extensionsToTreatAsEsm: [".ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { useESM: true }],
  },
};
