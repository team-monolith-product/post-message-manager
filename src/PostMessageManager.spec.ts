import { jest } from "@jest/globals";
import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { PostMessageManagerImpl } from "./PostMessageManager";
import {
  createStreamWire,
  readStreamWire,
  streamWireTransferList,
} from "./StreamTransport";

const ORIGIN = "https://parent.example.com";
const sentMessages: any[] = [];

Object.assign(globalThis, {
  MessageChannel: NodeMessageChannel,
  ReadableStream: NodeReadableStream,
  TransformStream: NodeTransformStream,
  WritableStream: NodeWritableStream,
});

beforeAll(() => {
  window.postMessage = ((
    message: unknown,
    targetOriginOrOptions?: string | WindowPostMessageOptions
  ) => {
    const transfer =
      typeof targetOriginOrOptions === "object"
        ? targetOriginOrOptions.transfer ?? []
        : [];
    const delivered = message;
    sentMessages.push(delivered);
    queueMicrotask(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: delivered,
          origin: ORIGIN,
          source: window,
        })
      );
    });
  }) as typeof window.postMessage;
});

const manager = new PostMessageManagerImpl();
const sendBase = { target: window, targetOrigin: "*" };

async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
  }
  return chunks;
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("request/response compatibility", () => {
  it("resolves send with the registered callback result", async () => {
    manager.register({
      messageType: "compat:echo",
      callback: (payload) => ({ echoed: payload }),
    });

    await expect(
      manager.send({ messageType: "compat:echo", payload: 1, ...sendBase })
    ).resolves.toEqual({ echoed: 1 });
  });

  it("removes the response handler after a timeout", async () => {
    await expect(
      manager.send({
        messageType: "compat:timeout",
        payload: null,
        timeoutMs: 10,
        ...sendBase,
      })
    ).rejects.toThrow("Timeout");

    expect(Object.keys(manager.responseHandlers)).toHaveLength(0);
  });
});

describe("stream transport", () => {
  it("moves a native stream through an actual MessagePort transfer", async () => {
    const channel = new MessageChannel();
    const wire = createStreamWire(
      new ReadableStream({
        start(controller) {
          controller.enqueue("native");
          controller.close();
        },
      }),
      true
    );
    const received = new Promise<unknown>((resolve) => {
      channel.port2.onmessage = (event) => resolve(event.data);
    });

    channel.port1.postMessage(wire, streamWireTransferList(wire));
    await expect(
      collect(readStreamWire<string>(await received).values())
    ).resolves.toEqual(["native"]);
    channel.port1.close();
    channel.port2.close();
  });

  it("transfers ordered chunks and closes through the native path", async () => {
    manager.registerStream({
      messageType: "stream:native",
      callback: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue("a");
            controller.enqueue("b");
            controller.close();
          },
        }),
    });

    await expect(
      collect(
        manager.stream({
          messageType: "stream:native",
          payload: null,
          ...sendBase,
        })
      )
    ).resolves.toEqual(["a", "b"]);
  });

  it("keeps concurrent streams isolated", async () => {
    manager.registerStream({
      messageType: "stream:parallel",
      callback: (payload) =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(`${payload}-1`);
            controller.enqueue(`${payload}-2`);
            controller.close();
          },
        }),
    });

    const left = collect(
      manager.stream<string>({
        messageType: "stream:parallel",
        payload: "left",
        ...sendBase,
      })
    );
    const right = collect(
      manager.stream<string>({
        messageType: "stream:parallel",
        payload: "right",
        ...sendBase,
      })
    );

    await expect(Promise.all([left, right])).resolves.toEqual([
      ["left-1", "left-2"],
      ["right-1", "right-2"],
    ]);
  });

  it("preserves a stream error name and message", async () => {
    manager.registerStream({
      messageType: "stream:error",
      callback: () =>
        new ReadableStream({
          start(controller) {
            const error = new Error("stream failed");
            error.name = "SupplierError";
            controller.error(error);
          },
        }),
    });

    await expect(
      collect(
        manager.stream({
          messageType: "stream:error",
          payload: null,
          ...sendBase,
        })
      )
    ).rejects.toMatchObject({
      name: "SupplierError",
      message: "stream failed",
    });
  });

  it("returns a serialized error when the stream callback rejects", async () => {
    manager.registerStream({
      messageType: "stream:callback-error",
      callback: async () => {
        throw Object.assign(new Error("callback failed"), {
          name: "CallbackError",
        });
      },
    });

    await expect(
      collect(
        manager.stream({
          messageType: "stream:callback-error",
          payload: null,
          ...sendBase,
        })
      )
    ).rejects.toMatchObject({
      name: "CallbackError",
      message: "callback failed",
    });
  });

  it("does not send a request for an already aborted signal", async () => {
    const callback = jest.fn();
    manager.registerStream({
      messageType: "stream:pre-aborted",
      callback,
    });
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      collect(
        manager.stream({
          messageType: "stream:pre-aborted",
          payload: null,
          signal: abortController.signal,
          ...sendBase,
        })
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(callback).not.toHaveBeenCalled();
    expect(
      sentMessages.some(
        (message) => message.messageType === "stream:pre-aborted"
      )
    ).toBe(false);
  });

  it("cancels a stream that arrives after the opening request is aborted", async () => {
    const cancelled = jest.fn();
    let resolveSource!: (source: ReadableStream<string>) => void;
    manager.registerStream({
      messageType: "stream:opening-abort",
      callback: () =>
        new Promise((resolve) => {
          resolveSource = resolve;
        }),
    });
    const abortController = new AbortController();
    const result = collect(
      manager.stream({
        messageType: "stream:opening-abort",
        payload: null,
        signal: abortController.signal,
        ...sendBase,
      })
    );
    await nextTask();

    abortController.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });

    resolveSource(
      new ReadableStream({
        cancel: cancelled,
      })
    );
    await nextTask();
    await nextTask();

    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("cancels the native source when the consumer stops early", async () => {
    const cancelled = jest.fn();
    manager.registerStream({
      messageType: "stream:native-cancel",
      callback: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue("first");
          },
          cancel: cancelled,
        }),
    });

    for await (const chunk of manager.stream({
      messageType: "stream:native-cancel",
      payload: null,
      ...sendBase,
    })) {
      expect(chunk).toBe("first");
      break;
    }
    await nextTask();

    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("propagates AbortSignal cancellation to the source", async () => {
    const cancelled = jest.fn();
    manager.registerStream({
      messageType: "stream:abort",
      callback: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue("first");
          },
          cancel: cancelled,
        }),
    });
    const abortController = new AbortController();
    const iterator = manager.stream({
      messageType: "stream:abort",
      payload: null,
      signal: abortController.signal,
      ...sendBase,
    });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: "first",
    });
    abortController.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    await nextTask();

    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("times out while waiting for an unregistered stream", async () => {
    await expect(
      collect(
        manager.stream({
          messageType: "stream:missing",
          payload: null,
          timeoutMs: 10,
          ...sendBase,
        })
      )
    ).rejects.toThrow("Timeout");
  });

  it("applies the existing origin predicate to stream registration", async () => {
    const callback = jest.fn(
      () =>
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        })
    );
    manager.registerStream({
      messageType: "stream:origin",
      origin: (origin) => origin === "https://other.example.com",
      callback,
    });

    await expect(
      collect(
        manager.stream({
          messageType: "stream:origin",
          payload: null,
          timeoutMs: 10,
          ...sendBase,
        })
      )
    ).rejects.toThrow("Timeout");
    expect(callback).not.toHaveBeenCalled();
  });

  it("stops serving a stream after unregisterStream", async () => {
    const callback = jest.fn();
    manager.registerStream({
      messageType: "stream:unregister",
      callback,
    });
    manager.unregisterStream("stream:unregister");

    await expect(
      collect(
        manager.stream({
          messageType: "stream:unregister",
          payload: null,
          timeoutMs: 10,
          ...sendBase,
        })
      )
    ).rejects.toThrow("Timeout");
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects an invalid stream response", () => {
    expect(() => readStreamWire({ transport: "native" })).toThrow(
      "Invalid stream response"
    );
  });
});
