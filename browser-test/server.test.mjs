import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServers } from "./server.mjs";

test("serves fixture pages on distinct origins without exposing repository files", async () => {
  const servers = await startServers([0, 0]);
  try {
    const urls = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
    assert.notEqual(urls[0], urls[1]);
    for (const url of urls) {
      const page = await fetch(url + "/browser-test/index.html");
      assert.equal(page.status, 200);
      assert.match(await page.text(), /PMM local browser tests/);
      assert.equal((await fetch(url + "/package.json")).status, 404);
    }
  } finally {
    await Promise.all(
      servers.map(
        (s) =>
          new Promise((resolve) => {
            s.close(resolve);
            s.closeAllConnections();
          }),
      ),
    );
  }
});

test("startup failure releases an already opened port", async () => {
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const availablePort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  try {
    await assert.rejects(
      startServers([availablePort, occupied.address().port]),
      { code: "EADDRINUSE" },
    );
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(availablePort, "127.0.0.1", resolve);
    });
  } finally {
    await Promise.all(
      [occupied, reservation].map(
        (s) => new Promise((resolve) => s.close(resolve)),
      ),
    );
  }
});
