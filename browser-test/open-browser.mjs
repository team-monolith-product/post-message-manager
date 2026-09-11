import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

const browsers = ["default", "chrome", "safari", "firefox"];

export function parseBrowserArgs(args) {
  if (args.length === 0) return undefined;
  let browser;
  if (args.length === 2 && args[0] === "--browser") browser = args[1];
  if (args.length === 1 && args[0].startsWith("--browser=")) {
    browser = args[0].slice("--browser=".length);
  }
  if (!browsers.includes(browser)) {
    throw new Error(
      "Use --browser default|chrome|safari|firefox, or omit it to open the printed URL yourself.",
    );
  }
  return browser;
}

export function resolveBrowserCommand(
  browser,
  url,
  { platform = process.platform, env = process.env, exists = existsSync } = {},
) {
  if (!browsers.includes(browser))
    throw new Error("Unknown browser: " + browser);
  if (browser === "safari" && platform !== "darwin") {
    throw new Error(
      "Current Safari is available locally only on macOS. Open the URL on a Mac to test Safari.",
    );
  }
  if (platform === "darwin") {
    const apps = {
      chrome: "Google Chrome",
      safari: "Safari",
      firefox: "Firefox",
    };
    return {
      command: "/usr/bin/open",
      args: browser === "default" ? [url] : ["-a", apps[browser], url],
      waitForExit: true,
    };
  }
  if (platform === "win32") {
    if (browser === "default")
      return { command: "explorer.exe", args: [url], waitForExit: false };
    const suffix =
      browser === "chrome"
        ? ["Google", "Chrome", "Application", "chrome.exe"]
        : ["Mozilla Firefox", "firefox.exe"];
    const roots = [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA,
    ].filter(Boolean);
    const command = roots
      .map((root) => win32.join(root, ...suffix))
      .find(exists);
    if (command) return { command, args: [url], waitForExit: false };
  } else if (platform === "linux") {
    const names =
      browser === "default"
        ? ["xdg-open"]
        : browser === "chrome"
          ? [
              "google-chrome",
              "google-chrome-stable",
              "chromium",
              "chromium-browser",
            ]
          : ["firefox"];
    const directories = (env.PATH || "").split(":").filter(Boolean);
    const command = names
      .flatMap((name) =>
        directories.map((directory) => posix.join(directory, name)),
      )
      .find(exists);
    if (command) return { command, args: [url], waitForExit: false };
  } else {
    throw new Error(
      "Automatic browser opening is not supported on " +
        platform +
        ". Open the printed URL yourself.",
    );
  }
  throw new Error(
    "Could not find " +
      browser +
      ". Open the printed URL in an installed browser.",
  );
}

export async function openBrowser(browser, url) {
  const { command, args, waitForExit } = resolveBrowserCommand(browser, url);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "ignore",
      detached: !waitForExit,
    });
    child.once("error", reject);
    if (waitForExit) {
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              "Could not open " + browser + ". Open the printed URL yourself.",
            ),
          );
      });
    } else {
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    }
  });
}
