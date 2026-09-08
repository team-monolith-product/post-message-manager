import { test } from "node:test";
import assert from "node:assert/strict";
import { configure, assertResult } from "./config.mjs";

test("Windows and Linux select remote Safari without a local driver", () => {
  for (const platform of ["win32", "linux"]) {
    const config = configure(
      {
        parentUrl: "https://parent.example.com/browser-test/parent.html",
        childOrigin: "https://child.example.com",
      },
      { WEBDRIVER_URL: "https://grid.example.com/wd/hub" },
      platform,
    );
    assert.equal(config.webdriverUrl, "https://grid.example.com/wd/hub");
    assert.equal(config.capabilities.browserName, "safari");
    assert.equal(config.serveLocal, false);
  }
});
test("unsupported local Safari fails rather than skipping", () => {
  assert.throws(() => configure({}, {}, "linux"), /remote WebDriver/);
});
test("remote browsers require explicit reachable fixture addresses", () => {
  assert.throws(
    () =>
      configure({}, { WEBDRIVER_URL: "https://grid.example.com" }, "darwin"),
    /parentUrl/,
  );
});
test("same-origin and invalid modes cannot pass a cross-origin run", () => {
  assert.throws(
    () =>
      configure(
        {
          parentUrl: "https://same.example.com",
          childOrigin: "https://same.example.com",
        },
        {},
        "darwin",
      ),
    /different origin/,
  );
  assert.throws(() => configure({ modes: ["webkit"] }, {}, "darwin"), /modes/);
});
test("missing, failed and wrong-mode results fail", () => {
  for (const result of [
    null,
    {},
    { passed: false, mode: "auto" },
    { passed: true, mode: "native" },
    { passed: true, mode: "auto" },
  ]) {
    assert.throws(() => assertResult(result, "auto"));
  }
  assert.doesNotThrow(() =>
    assertResult(
      {
        passed: true,
        mode: "auto",
        userAgent: "Safari",
        transports: { fallback: 1 },
        nativeTransferSupported: false,
      },
      "auto",
    ),
  );
});
