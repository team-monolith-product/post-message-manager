import { jest } from "@jest/globals";
import {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { createStreamWire, readStreamWire } from "./StreamTransport";

Object.assign(globalThis, {
  MessageChannel: NodeMessageChannel,
  ReadableStream: NodeReadableStream,
  WritableStream: NodeWritableStream,
});

describe("MessagePort stream fallback", () => {
  it("transfers chunks and closes", async () => {
    const wire = createStreamWire(
      new ReadableStream({
        start(controller) {
          controller.enqueue("first");
          controller.enqueue("second");
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
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: "second",
    });
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("propagates cancellation to the source", async () => {
    const cancelled = jest.fn<() => void>();
    const wire = createStreamWire(
      new ReadableStream({ cancel: cancelled }),
      false
    );
    const reader = readStreamWire(wire).getReader();

    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("propagates source errors", async () => {
    const error = Object.assign(new Error("source failed"), {
      name: "SourceError",
    });
    const wire = createStreamWire(
      new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      }),
      false
    );

    await expect(readStreamWire(wire).getReader().read()).rejects.toMatchObject({
      name: "SourceError",
      message: "source failed",
    });
  });

  it("pulls only when the consumer requests data", async () => {
    let pulled = 0;
    const wire = createStreamWire(
      new ReadableStream<number>({
        pull(controller) {
          controller.enqueue(pulled++);
        },
      }),
      false
    );
    const reader = readStreamWire<number>(wire).getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pausedAt = pulled;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pulled).toBe(pausedAt);

    await reader.cancel();
  });
});
