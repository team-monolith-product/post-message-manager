import { jest } from "@jest/globals";
import {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import {
  createStreamWire,
  readStreamWire,
  streamWireTransferList,
  StreamWire,
} from "./StreamTransport";

Object.assign(globalThis, {
  MessageChannel: NodeMessageChannel,
  ReadableStream: NodeReadableStream,
  WritableStream: NodeWritableStream,
});

async function transfer<T>(wire: StreamWire<T>): Promise<ReadableStream<T>> {
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    channel.port2.onmessage = (event) => {
      channel.port1.close();
      channel.port2.close();
      resolve(readStreamWire<T>(event.data));
    };
    channel.port1.postMessage(wire, streamWireTransferList(wire));
  });
}

describe.each([true, false])("stream transport native=%s", (native) => {
  it("transfers chunks and closes", async () => {
    const wire = createStreamWire(
      new ReadableStream({
        start(controller) {
          controller.enqueue("first");
          controller.enqueue("second");
          controller.close();
        },
      }),
      native,
    );
    const reader = (await transfer(wire)).getReader();

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

  it("propagates source errors", async () => {
    const error = { code: 429, detail: ["source failed"] };
    const wire = createStreamWire(
      new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      }),
      native,
    );

    await expect((await transfer(wire)).getReader().read()).rejects.toEqual(
      error,
    );
  });

  it("pulls only when the consumer requests data", async () => {
    let pulled = 0;
    const wire = createStreamWire(
      new ReadableStream<number>({
        pull(controller) {
          controller.enqueue(pulled++);
        },
      }),
      native,
    );
    const reader = (await transfer(wire)).getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pausedAt = pulled;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pulled).toBe(pausedAt);

    await reader.cancel();
  });

  it("preserves cancellation reasons without waiting for remote cleanup", async () => {
    let finish!: () => void;
    let observed!: (reason: unknown) => void;
    const reasonReceived = new Promise((resolve) => {
      observed = resolve;
    });
    const cancel = jest.fn((reason: unknown) => {
      observed(reason);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const source = new ReadableStream({ cancel });
    const stream = await transfer(createStreamWire(source, native));
    const reason = { code: "user-cancel", details: [1, 2] };
    await stream.cancel(reason);
    await expect(reasonReceived).resolves.toEqual(reason);
    await stream.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    finish();
  });

  it("reports errors even without pending reads", async () => {
    let sourceController!: ReadableStreamDefaultController;
    const source = new ReadableStream({
      start(controller) {
        sourceController = controller;
      },
    });
    const reader = (
      await transfer(createStreamWire(source, native))
    ).getReader();
    const closed = expect(reader.closed).rejects.toEqual("failed while idle");
    sourceController.error("failed while idle");
    await closed;
  });

  it("closes an empty source without requiring a read", async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    const reader = (
      await transfer(createStreamWire(source, native))
    ).getReader();
    await expect(reader.closed).resolves.toBeUndefined();
  });

  it("fails and cancels the source when a chunk cannot be cloned", async () => {
    let observed!: (reason: unknown) => void;
    const cancelled = new Promise((resolve) => {
      observed = resolve;
    });
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(() => undefined);
      },
      cancel(reason) {
        observed(reason);
      },
    });
    const reader = (
      await transfer(createStreamWire(source, native))
    ).getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: "DataCloneError",
    });
    await expect(cancelled).resolves.toMatchObject({ name: "DataCloneError" });
  });

  it("converts uncloneable source errors to clone errors", async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.error(() => undefined);
      },
    });
    const reader = (
      await transfer(createStreamWire(source, native))
    ).getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: "DataCloneError",
    });
  });

  it("rejects uncloneable cancellation reasons and still cancels the source", async () => {
    let observed!: (reason: unknown) => void;
    const cancelled = new Promise((resolve) => {
      observed = resolve;
    });
    const source = new ReadableStream({
      cancel(reason) {
        observed(reason);
      },
    });
    const stream = await transfer(createStreamWire(source, native));
    await expect(stream.cancel(() => undefined)).rejects.toMatchObject({
      name: "DataCloneError",
    });
    await expect(cancelled).resolves.toMatchObject({ name: "DataCloneError" });
  });

  it("delivers concurrent reads in order", async () => {
    let index = 0;
    const source = new ReadableStream({
      async pull(controller) {
        await Promise.resolve();
        if (index === 3) controller.close();
        else controller.enqueue(index++);
      },
    });
    const reader = (
      await transfer(createStreamWire(source, native))
    ).getReader();
    await expect(
      Promise.all([reader.read(), reader.read(), reader.read(), reader.read()]),
    ).resolves.toEqual([
      { value: 0, done: false },
      { value: 1, done: false },
      { value: 2, done: false },
      { value: undefined, done: true },
    ]);
  });
});
