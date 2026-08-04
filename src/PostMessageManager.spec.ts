import { PostMessageManagerImpl } from "./PostMessageManager";

const ORIGIN = "https://parent.example.com";

// jsdom 의 window.postMessage 는 event.origin=""/event.source=null 로 이벤트를
// 만들고 options 오버로드를 지원하지 않아 응답 경로가 끊긴다. 실브라우저처럼
// origin·source 를 지정한 합성 MessageEvent 로 대체한다.
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
  });

  it("공급자 에러가 name·message 를 보존해 throw 된다", async () => {
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

  it("소비자가 루프를 벗어나면 공급자 signal 이 abort 된다", async () => {
    let producerSignal: AbortSignal | undefined;
    manager.registerStream({
      messageType: "stream:break",
      callback: (_payload, controller) => {
        producerSignal = controller.signal;
        controller.enqueue(1);
        controller.enqueue(2);
        // close 하지 않는다 — 소비자 이탈로만 끝난다.
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
        // 이후 아무것도 보내지 않는다.
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

  it("청크 seq 가 어긋나면 에러로 끝난다", async () => {
    // 핸들러 없이 스트림을 열고, 잘못된 seq 의 청크를 직접 합성한다.
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
