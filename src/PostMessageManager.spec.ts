import { PostMessageManager, PostMessageManagerImpl } from "./PostMessageManager";

const ORIGIN = "https://parent.example.com";

// jsdom 의 window.postMessage 는 event.origin=""/event.source=null 로 이벤트를
// 만들고 options 오버로드를 지원하지 않아 응답 경로가 끊긴다. 실브라우저처럼
// origin/source 를 지정한 합성 MessageEvent 로 대체한다.
const sentMessages: any[] = [];
beforeAll(() => {
  window.postMessage = ((message: unknown) => {
    sentMessages.push(message);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: message,
        origin: ORIGIN,
        source: window,
      })
    );
  }) as typeof window.postMessage;
});

const manager = new PostMessageManagerImpl();
const sendBase = { target: window, targetOrigin: "*" };

async function collect<T>(iterator: AsyncGenerator<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
  }
  return chunks;
}

function latestStreamOpen(messageType: string): { id: string } {
  const message = [...sentMessages]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === "stream-open" && candidate.messageType === messageType
    );
  if (!message) {
    throw new Error(`stream-open not found for ${messageType}`);
  }
  return message;
}

function dispatchStreamMessage(data: any) {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin: ORIGIN, source: window })
  );
}

describe("send/notify 하위호환", () => {
  it("send 는 register 된 콜백의 반환값으로 resolve 된다", async () => {
    manager.register({
      messageType: "compat:echo",
      callback: (payload) => ({ echoed: payload }),
    });

    await expect(
      manager.send({ messageType: "compat:echo", payload: 1, ...sendBase })
    ).resolves.toEqual({ echoed: 1 });
  });

  it("send 타임아웃 시 responseHandlers 가 정리된다", async () => {
    await expect(
      manager.send({
        messageType: "compat:none",
        payload: null,
        timeoutMs: 20,
        ...sendBase,
      })
    ).rejects.toThrow("Timeout");

    expect(Object.keys(manager.responseHandlers)).toHaveLength(0);
  });
});

describe("stream", () => {
  it("청크를 순서대로 전달하고 정상 종료한다", async () => {
    manager.registerStream({
      messageType: "stream:ok",
      callback: (_payload, controller) => {
        controller.enqueue("a");
        controller.enqueue("b");
        controller.enqueue("c");
        controller.close();
      },
    });

    const chunks = await collect(
      manager.stream({ messageType: "stream:ok", payload: null, ...sendBase })
    );

    expect(chunks).toEqual(["a", "b", "c"]);
    expect(Object.keys(manager.streamConsumers)).toHaveLength(0);
  });

  it("같은 messageType 의 동시 스트림도 id 별로 분리한다", async () => {
    const controllers: Record<string, PostMessageManager.StreamController> =
      Object.create(null);
    manager.registerStream({
      messageType: "stream:parallel",
      callback: (payload, controller) => {
        controllers[payload] = controller;
      },
    });

    const left = manager.stream<string>({
      messageType: "stream:parallel",
      payload: "left",
      ...sendBase,
    });
    const right = manager.stream<string>({
      messageType: "stream:parallel",
      payload: "right",
      ...sendBase,
    });

    controllers.right.enqueue("right-1");
    controllers.left.enqueue("left-1");
    controllers.right.close();
    controllers.left.close();

    await expect(Promise.all([collect(left), collect(right)])).resolves.toEqual([
      ["left-1"],
      ["right-1"],
    ]);
    expect(Object.keys(manager.streamConsumers)).toHaveLength(0);
    expect(Object.keys(manager.streamProducers)).toHaveLength(0);
  });

  it("error 전에 받은 청크는 전달한 뒤 name/message 를 보존해 throw 한다", async () => {
    manager.registerStream({
      messageType: "stream:chunk-then-error",
      callback: (_payload, controller) => {
        const error = new Error("boom after chunk");
        error.name = "CustomError";
        controller.enqueue("first");
        controller.error(error);
      },
    });

    const iterator = manager.stream<string>({
      messageType: "stream:chunk-then-error",
      payload: null,
      ...sendBase,
    });

    await expect(iterator.next()).resolves.toEqual({ value: "first", done: false });
    await expect(iterator.next()).rejects.toMatchObject({
      name: "CustomError",
      message: "boom after chunk",
    });
    expect(Object.keys(manager.streamConsumers)).toHaveLength(0);
  });

  it("이미 aborted 된 signal 이면 stream-open 없이 즉시 실패한다", async () => {
    const callback = jest.fn();
    manager.registerStream({ messageType: "stream:pre-aborted", callback });
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
    ).rejects.toThrow("Aborted");
    expect(callback).not.toHaveBeenCalled();
    expect(
      sentMessages.filter(
        (message) => message.messageType === "stream:pre-aborted"
      )
    ).toHaveLength(0);
  });

  it("스트림 종료 후의 abort 는 이미 확정된 정상 종료를 덮어쓰지 않는다", async () => {
    manager.registerStream({
      messageType: "stream:late-abort",
      callback: (_payload, controller) => {
        controller.enqueue("a");
        controller.close();
      },
    });

    const abortController = new AbortController();
    const iterator = manager.stream({
      messageType: "stream:late-abort",
      payload: null,
      signal: abortController.signal,
      ...sendBase,
    });
    // 합성 postMessage 는 동기 dispatch 라 이 시점에 이미 stream-end 까지
    // 도착해 있어 종료 확정 후의 abort 경합을 재현함.
    abortController.abort();

    await expect(collect(iterator)).resolves.toEqual(["a"]);
  });

  it("iterate 하지 않고 버린 스트림도 idle 타임아웃 후 정리된다", async () => {
    manager.registerStream({
      messageType: "stream:orphan",
      callback: () => {},
    });

    manager.stream({
      messageType: "stream:orphan",
      payload: null,
      idleTimeoutMs: 20,
      ...sendBase,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(Object.keys(manager.streamConsumers)).toHaveLength(0);
  });

  it("공급자 에러가 name/message 를 보존해 throw 된다", async () => {
    manager.registerStream({
      messageType: "stream:error",
      callback: (_payload, controller) => {
        const error = new Error("boom");
        error.name = "CustomError";
        controller.error(error);
      },
    });

    await expect(
      collect(
        manager.stream({
          messageType: "stream:error",
          payload: null,
          ...sendBase,
        })
      )
    ).rejects.toMatchObject({ name: "CustomError", message: "boom" });
  });

  it("callback 이 close 전에 던지면 에러로 끝난다", async () => {
    manager.registerStream({
      messageType: "stream:throw",
      callback: () => {
        throw new Error("supplier crashed");
      },
    });

    await expect(
      collect(
        manager.stream({
          messageType: "stream:throw",
          payload: null,
          ...sendBase,
        })
      )
    ).rejects.toThrow("supplier crashed");
  });

  it("async callback 의 reject 도 stream-error 로 끝난다", async () => {
    manager.registerStream({
      messageType: "stream:async-throw",
      callback: async () => {
        await Promise.resolve();
        throw new Error("async supplier crashed");
      },
    });

    await expect(
      collect(
        manager.stream({
          messageType: "stream:async-throw",
          payload: null,
          ...sendBase,
        })
      )
    ).rejects.toThrow("async supplier crashed");
    expect(Object.keys(manager.streamProducers)).toHaveLength(0);
  });

  it("소비자가 루프를 벗어나면 공급자 signal 이 abort 된다", async () => {
    let producerSignal: AbortSignal | undefined;
    manager.registerStream({
      messageType: "stream:break",
      callback: (_payload, controller) => {
        producerSignal = controller.signal;
        controller.enqueue(1);
        controller.enqueue(2);
      },
    });

    for await (const chunk of manager.stream({
      messageType: "stream:break",
      payload: null,
      ...sendBase,
    })) {
      expect(chunk).toBe(1);
      break;
    }

    expect(producerSignal?.aborted).toBe(true);
  });

  it("소비자 취소 뒤 공급자의 late chunk 와 terminal 은 전송되지 않는다", async () => {
    let producerSignal: AbortSignal | undefined;
    manager.registerStream({
      messageType: "stream:cancel-fence",
      callback: (_payload, controller) => {
        producerSignal = controller.signal;
        controller.enqueue("first");
        controller.signal.addEventListener("abort", () => {
          controller.enqueue("late");
          controller.close();
          controller.error(new Error("late error"));
        });
      },
    });

    const iterator = manager.stream<string>({
      messageType: "stream:cancel-fence",
      payload: null,
      ...sendBase,
    });
    const { id } = latestStreamOpen("stream:cancel-fence");

    await expect(iterator.next()).resolves.toEqual({ value: "first", done: false });
    await iterator.return();

    const messages = sentMessages.filter((message) => message.parentId === id);
    expect(producerSignal?.aborted).toBe(true);
    expect(messages.filter((message) => message.type === "stream-chunk")).toEqual([
      expect.objectContaining({ payload: "first", seq: 0 }),
    ]);
    expect(
      messages.some(
        (message) =>
          message.type === "stream-end" || message.type === "stream-error"
      )
    ).toBe(false);
  });

  it("AbortSignal 로 취소하면 Aborted 로 끝나고 공급자에 전파된다", async () => {
    let producerSignal: AbortSignal | undefined;
    manager.registerStream({
      messageType: "stream:abort",
      callback: (_payload, controller) => {
        producerSignal = controller.signal;
        controller.enqueue(1);
      },
    });

    const abortController = new AbortController();
    const iterator = manager.stream({
      messageType: "stream:abort",
      payload: null,
      signal: abortController.signal,
      ...sendBase,
    });

    expect((await iterator.next()).value).toBe(1);
    abortController.abort();
    await expect(iterator.next()).rejects.toThrow("Aborted");
    expect(producerSignal?.aborted).toBe(true);
  });

  it("idle 한도를 넘기면 Timeout 으로 끝나고 공급자에 취소가 전파된다", async () => {
    let producerSignal: AbortSignal | undefined;
    manager.registerStream({
      messageType: "stream:idle",
      callback: (_payload, controller) => {
        producerSignal = controller.signal;
        controller.enqueue(1);
      },
    });

    await expect(
      collect(
        manager.stream({
          messageType: "stream:idle",
          payload: null,
          idleTimeoutMs: 30,
          ...sendBase,
        })
      )
    ).rejects.toThrow("Timeout: no stream activity");
    expect(producerSignal?.aborted).toBe(true);
  });

  it("origin 가드가 다르면 stream-open 을 무시한다", async () => {
    const callback = jest.fn();
    manager.registerStream({
      messageType: "stream:origin",
      origin: "https://other.example.com",
      callback,
    });

    await expect(
      collect(
        manager.stream({
          messageType: "stream:origin",
          payload: null,
          idleTimeoutMs: 20,
          ...sendBase,
        })
      )
    ).rejects.toThrow("Timeout");
    expect(callback).not.toHaveBeenCalled();
  });

  it("origin predicate 가 허용한 stream-open 은 공급자에게 전달한다", async () => {
    const callback = jest.fn((_payload, controller) => {
      controller.enqueue("allowed");
      controller.close();
    });
    manager.registerStream({
      messageType: "stream:origin-predicate",
      origin: (origin) => origin === ORIGIN,
      callback,
    });

    await expect(
      collect(
        manager.stream({
          messageType: "stream:origin-predicate",
          payload: null,
          ...sendBase,
        })
      )
    ).resolves.toEqual(["allowed"]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("unregisterStream 뒤 stream-open 은 공급자 callback 을 호출하지 않는다", async () => {
    const callback = jest.fn();
    manager.registerStream({ messageType: "stream:unregister", callback });
    manager.unregisterStream("stream:unregister");

    await expect(
      collect(
        manager.stream({
          messageType: "stream:unregister",
          payload: null,
          idleTimeoutMs: 20,
          ...sendBase,
        })
      )
    ).rejects.toThrow("Timeout");
    expect(callback).not.toHaveBeenCalled();
  });

  it("청크 seq 가 어긋나면 에러로 끝난다", async () => {
    const iterator = manager.stream({
      messageType: "stream:seq",
      payload: null,
      idleTimeoutMs: 1000,
      ...sendBase,
    });
    const open = sentMessages.find(
      (message) =>
        message.type === "stream-open" && message.messageType === "stream:seq"
    );

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "stream-chunk",
          messageType: "stream:seq",
          parentId: open.id,
          seq: 3,
          payload: "x",
        },
        origin: ORIGIN,
        source: window,
      })
    );

    await expect(collect(iterator)).rejects.toThrow("out of order");
    expect(
      sentMessages.some(
        (message) =>
          message.type === "stream-cancel" && message.parentId === open.id
      )
    ).toBe(true);
  });

  it("stream-end 뒤 도착한 chunk 와 error 는 결과를 바꾸지 않는다", async () => {
    const messageType = "stream:late-wire";
    const iterator = manager.stream({
      messageType,
      payload: null,
      idleTimeoutMs: 1000,
      ...sendBase,
    });
    const { id } = latestStreamOpen(messageType);

    dispatchStreamMessage({ type: "stream-end", messageType, parentId: id });
    dispatchStreamMessage({
      type: "stream-chunk",
      messageType,
      parentId: id,
      seq: 0,
      payload: "late",
    });
    dispatchStreamMessage({
      type: "stream-error",
      messageType,
      parentId: id,
      payload: { name: "LateError", message: "late failure" },
    });

    await expect(collect(iterator)).resolves.toEqual([]);
    expect(Object.keys(manager.streamConsumers)).toHaveLength(0);
  });

  it("생성자 timeoutMs 를 idleTimeoutMs 기본값으로 사용한다", async () => {
    const shortTimeoutManager = new PostMessageManagerImpl(20);

    await expect(
      collect(
        shortTimeoutManager.stream({
          messageType: "stream:default-idle-timeout",
          payload: null,
          ...sendBase,
        })
      )
    ).rejects.toThrow("Timeout: no stream activity");
    expect(Object.keys(shortTimeoutManager.streamConsumers)).toHaveLength(0);
  });

  it("악의적 parentId(__proto__)가 Object.prototype 을 오염시키지 못한다", async () => {
    for (const data of [
      { type: "stream-end", messageType: "stream:evil", parentId: "__proto__" },
      {
        type: "stream-error",
        messageType: "stream:evil",
        parentId: "__proto__",
        payload: { name: "Evil", message: "polluted" },
      },
    ]) {
      window.dispatchEvent(
        new MessageEvent("message", { data, origin: ORIGIN, source: window })
      );
    }
    await Promise.resolve();

    expect(({} as Record<string, unknown>).done).toBeUndefined();
    expect(({} as Record<string, unknown>).failure).toBeUndefined();
  });
});
