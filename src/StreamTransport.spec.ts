import { jest } from "@jest/globals";
import {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import {
  createStreamWire,
  discardStreamWire,
  readStreamWire,
  serializeStreamError,
  streamWireTransferList,
} from "./StreamTransport";

Object.assign(globalThis, {
  MessageChannel: NodeMessageChannel,
  ReadableStream: NodeReadableStream,
  WritableStream: NodeWritableStream,
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

  it.each(["resolve", "reject", "pending"])(
    "preserves a clone error when source cleanup is %s",
    async (cleanup) => {
      const cancelled = jest.fn<(reason?: unknown) => Promise<void>>(() => {
        if (cleanup === "reject") {
          return Promise.reject(new Error("cleanup failed"));
        }
        if (cleanup === "pending") {
          return new Promise(() => undefined);
        }
        return Promise.resolve();
      });
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
    }
  );

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

  it.each([true, false])(
    "stops pulling when the consumer pauses (native: %s)",
    async (useNativeTransfer) => {
      let pulled = 0;
      let resolveCancelled!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        resolveCancelled = resolve;
      });
      const wire = createStreamWire(new ReadableStream<number>({
        pull(controller) {
          controller.enqueue(pulled++);
        },
        cancel: resolveCancelled,
      }), useNativeTransfer);
      const channel = new MessageChannel();
      const received = new Promise<unknown>((resolve) => {
        channel.port2.onmessage = (event) => resolve(event.data);
      });
      channel.port1.postMessage(wire, streamWireTransferList(wire));
      const reader = readStreamWire<number>(await received).getReader();
      channel.port1.close();
      channel.port2.close();
      try {
        await expect(reader.read()).resolves.toEqual({ done: false, value: 0 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const pausedAt = pulled;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(pulled).toBe(pausedAt);
        expect(pulled).toBeLessThan(16);
        await expect(reader.read()).resolves.toEqual({ done: false, value: 1 });
      } finally {
        await reader.cancel();
        await cancellation;
        reader.releaseLock();
      }
    }
  );

  it("leaves ordinary and error responses alone when discarding", () => {
    expect(() => discardStreamWire({ result: "ordinary" })).not.toThrow();
    expect(() =>
      discardStreamWire(serializeStreamError(new Error("failure")))
    ).not.toThrow();
  });
});
