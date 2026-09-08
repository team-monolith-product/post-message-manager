import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Builder, By } from "selenium-webdriver";
import { configure, assertResult } from "./config.mjs";
import { startServers } from "./server.mjs";

let driver;
let closeServers;
const results = [];
const digest = (value) => createHash("sha256").update(value).digest("hex");
try {
  const configPath = process.argv[2];
  const input = configPath
    ? JSON.parse(await readFile(configPath, "utf8"))
    : {};
  const config = configure(input);
  const expectedBundle = digest(
    await readFile(new URL("../dist/post-message-manager.js", import.meta.url)),
  );
  if (config.serveLocal) closeServers = await startServers();
  let builder = new Builder()
    .disableEnvironmentOverrides()
    .withCapabilities(config.capabilities);
  if (config.webdriverUrl) builder = builder.usingServer(config.webdriverUrl);
  driver = await builder.build();
  await driver.manage().setTimeouts({ pageLoad: 30000, script: 10000 });
  const actual = await driver.getCapabilities();
  const browser = {
    name: actual.get("browserName"),
    version: actual.get("browserVersion"),
    platform: actual.get("platformName"),
  };
  if (
    browser.name?.toLowerCase() !==
    config.capabilities.browserName.toLowerCase()
  ) {
    throw new Error("WebDriver returned a different browser than requested.");
  }
  for (const mode of config.modes) {
    const url = new URL(config.parentUrl);
    url.searchParams.set("mode", mode);
    url.searchParams.set("childOrigin", config.childOrigin);
    url.searchParams.set("bundleSha256", expectedBundle);
    await driver.get(url.href);
    for (const frame of ["parent", "child"]) {
      if (frame === "child")
        await driver
          .switchTo()
          .frame(await driver.findElement(By.css("iframe")));
      try {
        const bundle = await driver.executeScript(
          "return { loaded: window.__bundleLoaded, hash: window.__bundleSha256 }",
        );
        if (bundle.loaded !== true || bundle.hash !== expectedBundle) {
          throw new Error(
            "The " +
              frame +
              " fixture bundle does not match this checkout's build.",
          );
        }
      } finally {
        await driver.switchTo().defaultContent();
      }
    }
    const result = await driver.wait(
      async () => {
        const value = await driver.executeScript(
          "return window.__browserTest || null",
        );
        return value && typeof value.passed === "boolean" ? value : false;
      },
      30000,
      "Browser fixture did not report a result.",
      200,
    );
    results.push({ browser, bundleSha256: expectedBundle, ...result });
    assertResult(result, mode);
    console.log(
      JSON.stringify({
        browser,
        mode,
        passed: result.passed,
        nativeTransferSupported: result.nativeTransferSupported,
        transports: result.transports,
      }),
    );
  }
} catch (error) {
  console.error(
    error.name +
      ": " +
      (error.message ?? "Browser test failed.").replace(
        /https?:\/\/[^\s]+/g,
        "[URL]",
      ),
  );
  process.exitCode = 1;
} finally {
  try {
    if (driver) await driver.quit();
  } catch {
    console.error("Failed to close the WebDriver session.");
    process.exitCode = 1;
  }
  if (closeServers) await closeServers();
  await writeFile(
    new URL("./results.json", import.meta.url),
    JSON.stringify({ passed: process.exitCode !== 1, results }, null, 2) + "\n",
  );
}
