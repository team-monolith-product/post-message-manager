import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserArgs, resolveBrowserCommand } from "./open-browser.mjs";

const url = "http://127.0.0.1:4173/browser-test/parent.html";

test("browser selection is opt-in and accepts both option forms", () => {
  assert.equal(parseBrowserArgs([]), undefined);
  for (const browser of ["default", "chrome", "safari", "firefox"]) {
    assert.equal(parseBrowserArgs(["--browser", browser]), browser);
    assert.equal(parseBrowserArgs(["--browser=" + browser]), browser);
  }
  for (const args of [
    ["--browser"],
    ["chrome"],
    ["--browser=edge"],
    ["--browser=chrome", "extra"],
  ]) {
    assert.throws(() => parseBrowserArgs(args), /Use --browser/);
  }
});

test("macOS selects named applications without shell interpolation", () => {
  for (const [browser, app] of [
    ["chrome", "Google Chrome"],
    ["safari", "Safari"],
    ["firefox", "Firefox"],
  ]) {
    assert.deepEqual(
      resolveBrowserCommand(browser, url, { platform: "darwin" }),
      {
        command: "/usr/bin/open",
        args: ["-a", app, url],
        waitForExit: true,
      },
    );
  }
  assert.deepEqual(
    resolveBrowserCommand("default", url, { platform: "darwin" }).args,
    [url],
  );
});

test("Windows resolves installed Chrome and Firefox paths", () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\developer\\AppData\\Local",
  };
  for (const [browser, executable] of [
    [
      "chrome",
      "C:\\Users\\developer\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ],
    ["firefox", "C:\\Program Files\\Mozilla Firefox\\firefox.exe"],
  ]) {
    assert.equal(
      resolveBrowserCommand(browser, url, {
        platform: "win32",
        env,
        exists: (path) => path === executable,
      }).command,
      executable,
    );
  }
  assert.equal(
    resolveBrowserCommand("default", url, { platform: "win32" }).command,
    "explorer.exe",
  );
  assert.throws(
    () =>
      resolveBrowserCommand("chrome", url, {
        platform: "win32",
        env,
        exists: () => false,
      }),
    /Could not find/,
  );
});

test("Linux resolves installed browser alternatives from PATH", () => {
  for (const [browser, executable] of [
    ["chrome", "/usr/bin/chromium"],
    ["firefox", "/usr/bin/firefox"],
    ["default", "/usr/bin/xdg-open"],
  ]) {
    assert.equal(
      resolveBrowserCommand(browser, url, {
        platform: "linux",
        env: { PATH: "/usr/local/bin:/usr/bin" },
        exists: (path) => path === executable,
      }).command,
      executable,
    );
  }
  assert.throws(
    () =>
      resolveBrowserCommand("chrome", url, {
        platform: "linux",
        env: {},
        exists: () => false,
      }),
    /Could not find/,
  );
});

test("Safari is rejected outside macOS and unknown platforms stay manual", () => {
  for (const platform of ["win32", "linux"]) {
    assert.throws(
      () => resolveBrowserCommand("safari", url, { platform }),
      /only on macOS/,
    );
  }
  assert.throws(
    () => resolveBrowserCommand("chrome", url, { platform: "other" }),
    /not supported/,
  );
});
