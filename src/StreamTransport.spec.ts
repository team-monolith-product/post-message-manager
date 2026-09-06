import { jest } from "@jest/globals";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import {
  createStreamWire,
  discardStreamWire,
  readStreamWire,
  serializeStreamError,
} from "./StreamTransport";

Object.assign(globalThis, {
  MessageChannel: NodeMessageChannel,
  ReadableStream: NodeReadableStream,
});

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MessagePort stream cleanup", () => {
  it("ignores queued chunks and close messages after the consumer cancels", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wire = createStreamWire(
        new ReadableStream({
          start(controller) {
            controller.enqueue("first");
            controller.enqueue("queued");
            controller.close();
          },
        }),
        false
      );
      const reader = readStreamWire<string>(wire).getReader();
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: "first",
      });
      await reader.cancel();
      await nextTask();
      await expect(reader.read()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    }
  });

  it("cancels an uncloneable source and preserves the transport error when cleanup rejects", async () => {
    const cancelled = jest
      .fn<(reason?: unknown) => Promise<void>>()
      .mockRejectedValue(new Error("cleanup failed"));
    const wire = createStreamWire(
      new ReadableStream({
        start(controller) {
          controller.enqueue(() => "not cloneable");
        },
        cancel: cancelled,
      }),
      false
    );

    await expect(readStreamWire(wire).getReader().read()).rejects.toMatchObject({
      name: "DataCloneError",
    });
    await nextTask();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledWith(
      expect.objectContaining({ name: "DataCloneError" })
    );
  });

  it.each([true, false])(
    "discards an unused stream response with native transfer set to %s",
    async (useNativeTransfer) => {
      let resolveCancelled!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        resolveCancelled = resolve;
      });
      const cancelled = jest.fn<(reason?: unknown) => void>(resolveCancelled);
      const wire = createStreamWire(
        new ReadableStream({ cancel: cancelled }),
        useNativeTransfer
      );

      discardStreamWire(wire);
      await cancellation;
      expect(cancelled).toHaveBeenCalledTimes(1);
    }
  );

  it("leaves ordinary and error responses alone when discarding", () => {
    expect(() => discardStreamWire({ result: "ordinary" })).not.toThrow();
    expect(() =>
      discardStreamWire(serializeStreamError(new Error("failure")))
    ).not.toThrow();
  });
});
