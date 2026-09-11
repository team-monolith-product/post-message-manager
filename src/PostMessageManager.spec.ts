import { jest } from "@jest/globals";
import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
} from "node:stream/web";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { PostMessageManagerImpl } from "./PostMessageManager";

Object.assign(globalThis, {
  MessageChannel: NodeMessageChannel,
  ReadableStream: NodeReadableStream,
  TransformStream: NodeTransformStream,
});
const ORIGIN = "https://parent.example.com";
const messages: any[] = [];
let responseDelayMs = 0;

beforeAll(() => {
  // jsdom의 origin/source 누락을 보완하기 위한 대역
  window.postMessage = ((
    message: unknown,
    options?: string | WindowPostMessageOptions,
  ) => {
    const channel = new MessageChannel();
    channel.port2.onmessage = (event) => {
      channel.port1.close();
      channel.port2.close();
      const dispatch = () =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: event.data,
            origin: ORIGIN,
            source: window,
          }),
        );
      if (event.data.type === "response" && responseDelayMs)
        setTimeout(dispatch, responseDelayMs);
      else dispatch();
    };
    try {
      channel.port1.postMessage(
        message,
        typeof options === "object" ? (options.transfer ?? []) : [],
      );
      messages.push(message);
    } catch (error) {
      channel.port1.close();
      channel.port2.close();
      throw error;
    }
  }) as typeof window.postMessage;
});

const manager = new PostMessageManagerImpl(100);
const request = (messageType: string) => ({
  messageType,
  payload: null,
  target: window,
  targetOrigin: "*",
});
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function collect<T>(opening: Promise<ReadableStream<T>>) {
  const reader = (await opening).getReader();
  const values: T[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return values;
      values.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}
function source(...values: string[]) {
  return new ReadableStream<string>({
    start(controller) {
      values.forEach((value) => controller.enqueue(value));
      controller.close();
    },
  });
}

describe("request and stream contracts", () => {
  it("does not cancel another manager's stream response", async () => {
    new PostMessageManagerImpl();
    manager.registerStream({ messageType: "owner", callback: () => source("owned") });
    const stream = await manager.stream<string>(request("owner"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(collect(Promise.resolve(stream))).resolves.toEqual(["owned"]);
  });
  it("cancels a transferred response delivered after the opening timeout", async () => {
    let cancelled!: (reason: unknown) => void;
    const cancellation = new Promise<unknown>((resolve) => {
      cancelled = resolve;
    });
    manager.registerStream({
      messageType: "late-response",
      callback: () => new ReadableStream({ cancel: cancelled }),
    });
    responseDelayMs = 60;
    try {
      await expect(
        manager.stream({ ...request("late-response"), timeoutMs: 10 }),
      ).rejects.toThrow("Timeout");
      await expect(cancellation).resolves.toMatchObject({
        message: expect.stringContaining("Timeout"),
      });
    } finally {
      responseDelayMs = 0;
    }
  });
  it("round trips application payloads without interpreting stream tags", async () => {
    const payload = {
      type: "post-message-manager-stream-port",
      port: { application: true },
    };
    manager.register({ messageType: "echo", callback: () => payload });
    await expect(manager.send(request("echo"))).resolves.toEqual(payload);
  });

  it("sends a stream request immediately and returns a readable stream", async () => {
    manager.registerStream({
      messageType: "eager",
      callback: () => source("a", "b"),
    });
    const opening = manager.stream<string>(request("eager"));
    expect(messages[messages.length - 1]).toMatchObject({
      messageType: "eager",
      stream: true,
    });
    expect(await opening).toBeInstanceOf(ReadableStream);
    await expect(collect(opening)).resolves.toEqual(["a", "b"]);
  });

  it("keeps concurrent streams independent", async () => {
    manager.registerStream({
      messageType: "parallel",
      callback: (payload) => source(payload),
    });
    await expect(
      Promise.all(
        ["left", "right"].map((payload) =>
          collect(manager.stream({ ...request("parallel"), payload })),
        ),
      ),
    ).resolves.toEqual([["left"], ["right"]]);
  });

  it("keeps RPC and stream registrations and removals independent", async () => {
    manager.register({ messageType: "shared", callback: () => "rpc" });
    manager.registerStream({
      messageType: "shared",
      callback: () => source("stream"),
    });
    await expect(manager.send(request("shared"))).resolves.toBe("rpc");
    await expect(collect(manager.stream(request("shared")))).resolves.toEqual([
      "stream",
    ]);
    manager.unregisterStream("shared");
    await expect(manager.send(request("shared"))).resolves.toBe("rpc");
    await expect(
      manager.stream({ ...request("shared"), timeoutMs: 10 }),
    ).rejects.toThrow("Timeout");
    manager.registerStream({
      messageType: "shared",
      callback: () => source("kept"),
    });
    manager.unregister("shared");
    await expect(collect(manager.stream(request("shared")))).resolves.toEqual([
      "kept",
    ]);
    await expect(
      manager.send({ ...request("shared"), timeoutMs: 10 }),
    ).rejects.toThrow("Timeout");
  });

  it("lets an active stream finish after unregisterStream", async () => {
    let controller!: ReadableStreamDefaultController<string>;
    manager.registerStream({
      messageType: "unregister",
      callback: () =>
        new ReadableStream<string>({
          start(value) {
            controller = value;
          },
        }),
    });
    const stream = await manager.stream<string>(request("unregister"));
    manager.unregisterStream("unregister");
    controller.enqueue("kept");
    controller.close();
    await expect(collect(Promise.resolve(stream))).resolves.toEqual(["kept"]);
    await expect(
      manager.stream({ ...request("unregister"), timeoutMs: 10 }),
    ).rejects.toThrow("Timeout");
  });

  it.each([false, true])(
    "preserves a cloneable callback error (async=%s)",
    async (asyncCallback) => {
      const reason = { code: 429, retryAfter: 10 };
      manager.registerStream({
        messageType: "callback",
        callback: () => {
          if (asyncCallback) return Promise.reject(reason);
          throw reason;
        },
      });
      await expect(manager.stream(request("callback"))).rejects.toEqual(reason);
    },
  );

  it("reports a callback clone failure without waiting for timeout", async () => {
    manager.registerStream({
      messageType: "uncloneable",
      callback: () => {
        throw () => undefined;
      },
    });
    await expect(manager.stream(request("uncloneable"))).rejects.toMatchObject({
      name: "DataCloneError",
    });
  });

  it("keeps normal completion after the signal aborts", async () => {
    const controller = new AbortController();
    manager.registerStream({
      messageType: "completed",
      callback: () => source("done"),
    });
    const reader = (
      await manager.stream({
        ...request("completed"),
        signal: controller.signal,
      })
    ).getReader();
    await reader.read();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    reader.releaseLock();
  });

  it("ignores cancellation from another window or origin", async () => {
    let resolveSource!: (value: ReadableStream<string>) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    manager.registerStream({
      messageType: "spoof",
      callback: () => {
        entered();
        return new Promise<ReadableStream<string>>((resolve) => {
          resolveSource = resolve;
        });
      },
    });
    const opening = manager.stream<string>(request("spoof"));
    await started;
    const id = messages[messages.length - 1].id;
    for (const sender of [
      { origin: "https://other.example.com", source: window },
      { origin: ORIGIN, source: null },
    ]) {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "stream-cancel", parentId: id, reason: "spoof" },
          ...sender,
        }),
      );
    }
    resolveSource(source("kept"));
    await expect(collect(opening)).resolves.toEqual(["kept"]);
  });

  it("rejects a pre-aborted signal without sending a request", async () => {
    const controller = new AbortController();
    const reason = { cancelled: "before-open" };
    controller.abort(reason);
    const count = messages.length;
    await expect(
      manager.stream({ ...request("pre-abort"), signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(messages).toHaveLength(count);
  });

  it.each(["abort", "timeout"])(
    "cancels a late source after opening %s",
    async (mode) => {
      let resolveSource!: (value: ReadableStream<string>) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let cancelled!: (reason: unknown) => void;
      const cancellation = new Promise<unknown>((resolve) => {
        cancelled = resolve;
      });
      manager.registerStream({
        messageType: mode,
        callback: () => {
          entered();
          return new Promise<ReadableStream<string>>((resolve) => {
            resolveSource = resolve;
          });
        },
      });
      const controller = new AbortController();
      const opening = manager.stream({
        ...request(mode),
        signal: controller.signal,
        timeoutMs: 40,
      });
      const rejection =
        mode === "abort"
          ? expect(opening).rejects.toEqual({ cancelled: "opening" })
          : expect(opening).rejects.toThrow("Timeout");
      await started;
      if (mode === "abort") controller.abort({ cancelled: "opening" });
      await rejection;
      await pause();
      resolveSource(new ReadableStream<string>({ cancel: cancelled }));
      if (mode === "abort")
        await expect(cancellation).resolves.toEqual({ cancelled: "opening" });
      else
        await expect(cancellation).resolves.toMatchObject({
          message: expect.stringContaining("Timeout"),
        });
    },
  );

  it("aborts a pending read and forwards the signal reason", async () => {
    let cancelled!: (reason: unknown) => void;
    const cancellation = new Promise<unknown>((resolve) => {
      cancelled = resolve;
    });
    manager.registerStream({
      messageType: "active-abort",
      callback: () => new ReadableStream({ cancel: cancelled }),
    });
    const controller = new AbortController();
    const reader = (
      await manager.stream({
        ...request("active-abort"),
        signal: controller.signal,
      })
    ).getReader();
    const read = reader.read();
    controller.abort({ cancelled: "active" });
    await expect(read).rejects.toEqual({ cancelled: "active" });
    await expect(cancellation).resolves.toEqual({ cancelled: "active" });
    reader.releaseLock();
  });

  it("forwards consumer cancellation with a reason", async () => {
    let cancelled!: (reason: unknown) => void;
    const cancellation = new Promise<unknown>((resolve) => {
      cancelled = resolve;
    });
    manager.registerStream({
      messageType: "cancel",
      callback: () => new ReadableStream({ cancel: cancelled }),
    });
    const stream = await manager.stream(request("cancel"));
    await stream.cancel({ cancelled: "consumer" });
    await expect(cancellation).resolves.toEqual({ cancelled: "consumer" });
  });

  it("supports pipeTo and releases its lock", async () => {
    manager.registerStream({
      messageType: "pipe",
      callback: () => source("a"),
    });
    const stream = await manager.stream<string>(request("pipe"));
    const transform = new TransformStream<string, string>({
      transform(value, controller) {
        controller.enqueue(value.toUpperCase());
      },
    });
    const output = collect(Promise.resolve(transform.readable));
    await stream.pipeTo(transform.writable);
    await expect(output).resolves.toEqual(["A"]);
    expect(stream.locked).toBe(false);
  });

  it("applies the origin predicate to stream registration", async () => {
    const callback = jest.fn(() => source());
    manager.registerStream({
      messageType: "origin",
      origin: (origin) => origin === "https://other.example.com",
      callback,
    });
    await expect(
      manager.stream({ ...request("origin"), timeoutMs: 10 }),
    ).rejects.toThrow("Timeout");
    expect(callback).not.toHaveBeenCalled();
  });
});
