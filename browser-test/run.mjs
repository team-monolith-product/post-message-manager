import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { startServers } from "./server.mjs";
import { openBrowser, parseBrowserArgs } from "./open-browser.mjs";

try {
  const browser = parseBrowserArgs(process.argv.slice(2));
  await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    outfile: fileURLToPath(
      new URL("../dist/post-message-manager.js", import.meta.url),
    ),
    bundle: true,
    format: "iife",
    globalName: "PostMessageManager",
    minify: true,
  });
  await startServers();
  const url = "http://127.0.0.1:4173/browser-test/index.html";
  console.log(`Open in a local browser: ${url}`);
  console.log(
    "Results appear in the page and terminal. Ctrl+C stops the servers.",
  );
  console.log(
    "This command serves tests; browser test failures do not set its exit code.",
  );
  if (browser) {
    try {
      await openBrowser(browser, url);
    } catch (error) {
      console.error(`Could not open ${browser}: ${error.message}`);
      console.error(`Open the URL manually: ${url}`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
