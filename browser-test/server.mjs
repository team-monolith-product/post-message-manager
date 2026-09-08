import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function start(port) {
  return createServer((request, response) => {
    const pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    if (request.method === "POST" && pathname === "/browser-test/result") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        console.log(`BROWSER_TEST_RESULT ${body}`);
        response.writeHead(204).end();
      });
      return;
    }
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${sep}`) || !stat(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(response);
  }).listen(port, "127.0.0.1");
}

function stat(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export async function startServers() {
  const servers = [];
  try {
    for (const port of [4173, 4174]) {
      const server = start(port);
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    return async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve) => {
              server.close(resolve);
              server.closeAllConnections();
            }),
        ),
      );
    };
  } catch (error) {
    servers.forEach((server) => server.close());
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await startServers();
  console.log("http://127.0.0.1:4173/browser-test/parent.html");
}
