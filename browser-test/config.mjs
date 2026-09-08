export function configure(
  input = {},
  env = process.env,
  platform = process.platform,
) {
  const webdriverUrl = env.WEBDRIVER_URL || input.webdriverUrl;
  const capabilities = input.capabilities ?? { browserName: "safari" };
  if (!capabilities.browserName)
    throw new Error("capabilities.browserName is required.");
  if (
    !webdriverUrl &&
    capabilities.browserName.toLowerCase() === "safari" &&
    platform !== "darwin"
  ) {
    throw new Error(
      "Safari requires a remote WebDriver on this OS. Set WEBDRIVER_URL and configure parentUrl/childOrigin reachable by that browser.",
    );
  }
  if (webdriverUrl && (!input.parentUrl || !input.childOrigin)) {
    throw new Error(
      "Remote WebDriver requires explicit parentUrl and childOrigin reachable from the remote browser (a hosted fixture or a configured tunnel).",
    );
  }
  const parentUrl = new URL(
    input.parentUrl ?? "http://127.0.0.1:4173/browser-test/parent.html",
  );
  const childUrl = new URL(input.childOrigin ?? "http://127.0.0.1:4174");
  if (
    ![parentUrl, childUrl].every((url) =>
      ["http:", "https:"].includes(url.protocol),
    )
  ) {
    throw new Error("Fixture URLs must use HTTP or HTTPS.");
  }
  if (parentUrl.origin === childUrl.origin)
    throw new Error("The iframe must use a different origin.");
  const modes = input.modes ?? ["auto", "fallback"];
  if (
    !Array.isArray(modes) ||
    !modes.length ||
    modes.some((mode) => !["auto", "native", "fallback"].includes(mode))
  ) {
    throw new Error("modes must contain auto, native or fallback.");
  }
  return {
    webdriverUrl,
    capabilities,
    parentUrl: parentUrl.href,
    childOrigin: childUrl.origin,
    modes,
    serveLocal: input.serveLocal ?? !webdriverUrl,
  };
}

export function assertResult(result, mode) {
  if (!result || result.mode !== mode || result.passed !== true) {
    throw new Error("Browser fixture failed or returned an unexpected mode.");
  }
  if (
    !result.userAgent ||
    !result.transports ||
    typeof result.nativeTransferSupported !== "boolean"
  ) {
    throw new Error(
      "Browser fixture is missing browser or transport evidence.",
    );
  }
}
