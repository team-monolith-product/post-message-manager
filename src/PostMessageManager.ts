import { uid } from "uid";

// request type 메시지 객체 구성입니다.
interface MessageRequest {
  type: "request";
  messageType: string;
  id: string;
  payload: any;
}

// response type 메시지 객체 구성입니다.
interface MessageResponse {
  type: "response";
  messageType: string;
  parentId: string;
  payload: any;
}

// stream 계열 메시지 객체 구성입니다.
// 스트림은 stream-open 으로 열리고, stream-chunk 가 0회 이상 흐른 뒤
// stream-end(정상) 또는 stream-error(실패)로 닫힙니다.
// 소비자는 stream-cancel 로 중단을 요청할 수 있습니다.
interface StreamOpen {
  type: "stream-open";
  messageType: string;
  id: string;
  payload: any;
}

interface StreamChunk {
  type: "stream-chunk";
  messageType: string;
  parentId: string;
  seq: number;
  payload: any;
}

interface StreamEnd {
  type: "stream-end";
  messageType: string;
  parentId: string;
}

interface StreamError {
  type: "stream-error";
  messageType: string;
  parentId: string;
  payload: { name: string; message: string };
}

interface StreamCancel {
  type: "stream-cancel";
  messageType: string;
  parentId: string;
}

type Message =
  | MessageRequest
  | MessageResponse
  | StreamOpen
  | StreamChunk
  | StreamEnd
  | StreamError
  | StreamCancel;

type RequestHandler = Pick<
  PostMessageManager.RegisterProps,
  "callback" | "origin"
>;
type ResponseHandler = {
  resolve: (payload: any) => void;
  timer: ReturnType<typeof setTimeout>;
} & Pick<MessageResponse, "type" | "parentId">;

type StreamHandler = Pick<
  PostMessageManager.RegisterStreamProps,
  "callback" | "origin"
>;

// 소비자 측 활성 스트림 상태입니다.
type StreamConsumer = {
  buffer: any[];
  done: boolean;
  failure?: Error;
  expectedSeq: number;
  wake?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  bumpIdle: () => void;
  /** wire 발 종료(end·error). 상태 확정·타이머 해제·맵 제거·wake 를 수행합니다. */
  finish: (failure?: Error) => void;
  /** 소비자 발 종료(idle·abort·break·seq). 공급자에 취소 전파 후 finish 합니다. */
  cancelAndFinish: (failure?: Error) => void;
};

function serializeError(e: unknown): { name: string; message: string } {
  if (e instanceof Error) {
    return { name: e.name, message: e.message };
  }
  return { name: "Error", message: String(e) };
}

function reviveError(payload: { name: string; message: string }): Error {
  const error = new Error(payload.message);
  error.name = payload.name;
  return error;
}

// handler의 origin이 정의되어 있을 때, origin 체크를 합니다.
function isOriginAllowed(
  allowed: string | ((origin: string) => boolean) | undefined,
  origin: string
): boolean {
  if (!allowed) {
    return true;
  }
  if (typeof allowed === "string") {
    // origin이 string일 때는 정확히 일치하는지 확인합니다.
    return allowed === origin;
  }
  // origin이 함수일 때는 함수의 return 값이 true인지 확인합니다.
  return allowed(origin);
}

export namespace PostMessageManager {
  export interface RegisterProps {
    messageType: string;
    callback: (payload: any) => Promise<any> | any;
    origin?: string | ((origin: string) => boolean);
  }
  export interface SendProps {
    messageType: string;
    payload: any;
    target: Window;
    targetOrigin: string;

    /** response message를 받을 때까지 기다릴 시간 (ms).
     * 이 시간이 지나도 message가 오지 않으면 Error를 reject 합니다. */
    timeoutMs?: number;
  }
  export type NotifyProps = Omit<SendProps, "timeoutMs">;

  /** 스트림 공급자가 청크를 밀어 넣는 컨트롤러입니다. */
  export interface StreamController {
    /** 청크 하나를 소비자에게 보냅니다. close/error 이후에는 무시됩니다. */
    enqueue(chunk: any): void;
    /** 스트림을 정상 종료합니다. */
    close(): void;
    /** 스트림을 에러로 종료합니다. */
    error(e: unknown): void;
    /** 소비자가 취소하면 abort 됩니다. 공급 측 자원 정리에 사용합니다. */
    signal: AbortSignal;
  }

  export interface RegisterStreamProps {
    messageType: string;
    /** stream-open 을 받으면 호출됩니다. 반드시 close() 또는 error() 로
     * 스트림을 닫아야 합니다 — 닫지 않으면 소비자 쪽 idle 타임아웃으로 끝납니다. */
    callback: (
      payload: any,
      controller: StreamController
    ) => Promise<void> | void;
    origin?: string | ((origin: string) => boolean);
  }

  export interface StreamProps extends Omit<SendProps, "timeoutMs"> {
    /** 소비자 측 취소 신호. abort 되면 공급자에게 stream-cancel 이 전달됩니다. */
    signal?: AbortSignal;
    /** 청크 사이 무활동 한도 (ms). 초과하면 스트림이 에러로 끝나고
     * 공급자에게 stream-cancel 이 전달됩니다. 생략하면 생성자의 timeoutMs 를
     * 사용합니다. */
    idleTimeoutMs?: number;
  }
}

/**
 * PostMessageManager는 window.postMessage를 이용하여 다른 window에게 메시지를 보내고, 받을 수 있도록 합니다.
 *
 * send 함수를 이용하여 다른 window에게 메시지를 보내고, 받은 메시지에 대한 응답을 받을 수 있습니다.
 *  - 이 함수에서는 Promise를 반환하며, 다른 window에서 보낸 메시지에 대한 응답을 받으면 resolve 됩니다.
 *  - timeoutMs 시간이 지나면 reject 됩니다.
 *  - 내부적으로 responseHandlers에 ResponseHandler 타입의 객체를 저장합니다.
 *
 * notify 함수를 이용하여 다른 window에게 메시지를 보낼 수 있습니다.
 * - send와 비슷하나, 이 함수는 응답을 받지 않으며, promise를 반환하지 않습니다.
 * - 단방향 통신이 필요할 때 사용합니다.
 *
 * register 함수를 이용하여 다른 window로부터 메시지를 받을 때, 어떤 callback 함수를 실행할지 등록할 수 있습니다.
 *  - 내부적으로 requestHandlers에 RequestHandler 타입의 객체를 저장합니다.
 * unregister 함수를 이용하여 등록된 callback 함수를 삭제할 수 있습니다.
 *
 * stream 함수를 이용하여 다른 window로부터 여러 청크의 응답을 순서대로 받을 수 있습니다.
 *  - AsyncGenerator를 반환하며, for await...of 로 소비합니다.
 *  - 루프를 중간에 벗어나거나 signal 을 abort 하면 공급자에게 취소(stream-cancel)가 전파됩니다.
 *  - 청크 사이 무활동이 idleTimeoutMs 를 넘으면 에러로 끝납니다.
 * registerStream 함수를 이용하여 스트림 요청을 받았을 때 청크를 공급할 callback을 등록합니다.
 *  - callback은 controller 로 enqueue/close/error 하고, 소비자 취소는 controller.signal 로 받습니다.
 */
export interface PostMessageManager {
  register(args: PostMessageManager.RegisterProps): void;
  unregister(messageType: string): void;
  send<T>(args: PostMessageManager.SendProps): Promise<T>;
  notify(args: PostMessageManager.NotifyProps): void;
  registerStream(args: PostMessageManager.RegisterStreamProps): void;
  unregisterStream(messageType: string): void;
  stream<T = any>(
    args: PostMessageManager.StreamProps
  ): AsyncGenerator<T, void, void>;
}

export class PostMessageManagerImpl implements PostMessageManager {
  constructor(timeoutMs = 3000) {
    // 메시지의 messageType·parentId 는 외부 창이 임의로 보낼 수 있는 값이라
    // "__proto__" 등으로 Object.prototype 이 조회·오염되지 않도록
    // 프로토타입 없는 객체를 사용함.
    this.requestHandlers = Object.create(null); // key: messageType, value: RequestHandler
    this.responseHandlers = Object.create(null); // key: id, value: ResponseHandler
    this.streamHandlers = Object.create(null); // key: messageType, value: StreamHandler
    this.streamConsumers = Object.create(null); // key: id, value: StreamConsumer
    this.streamProducers = Object.create(null); // key: id, value: AbortController
    this.timeoutMs = timeoutMs;
    this._init();
  }

  private _init() {
    window.addEventListener("message", this._onMessage.bind(this));
  }

  private async _onMessage(event: MessageEvent<Message>) {
    const { data } = event;

    if (data.type === "request") {
      // request type의 message를 받으면, handler를 찾아서 실행하고 response message를 보낸다.
      const { messageType, payload, id } = data;
      const handler = this.requestHandlers[messageType];
      if (!handler) {
        return;
      }

      if (!isOriginAllowed(handler.origin, event.origin)) {
        return;
      }

      // request message에 대해서는 항상 response message를 보낸다.
      // (callback의 return 값이 없어도 response message를 보낸다.)
      const response = await handler.callback(payload);
      const message: MessageResponse = {
        type: "response",
        parentId: id,
        messageType,
        payload: response,
      };
      this._replyTo(event)(message);
    } else if (data.type === "response") {
      // response type의 message를 받으면, handler를 찾아서
      // resolve하고, handler를 삭제한다.
      const { payload, parentId } = data;
      const handler = this.responseHandlers[parentId];
      if (!handler) {
        return;
      }
      // payload가 undefined일 수 있다.
      handler.resolve(payload);
      clearTimeout(handler.timer);
      delete this.responseHandlers[parentId]; // response message를 받으면 handler를 삭제한다.
    } else if (data.type === "stream-open") {
      await this._onStreamOpen(event, data);
    } else if (data.type === "stream-cancel") {
      // 소비자의 취소를 공급자 callback 에 signal 로 전파한다.
      const abortController = this.streamProducers[data.parentId];
      if (!abortController) {
        return;
      }
      delete this.streamProducers[data.parentId];
      abortController.abort();
    } else if (
      data.type === "stream-chunk" ||
      data.type === "stream-end" ||
      data.type === "stream-error"
    ) {
      this._onStreamMessage(data);
    }
  }

  // 받은 이벤트의 발신 창으로 메시지를 돌려보내는 함수를 만든다.
  // srcdoc iframe의 origin은 "null"(opaque origin)이므로 postMessage의
  // targetOrigin으로 사용할 수 없다. 이 경우 "*"로 대체한다.
  private _replyTo(event: MessageEvent<Message>): (message: Message) => void {
    const targetOrigin = event.origin === "null" ? "*" : event.origin;
    const source = event.source;
    return (message) => {
      source?.postMessage(message, { targetOrigin });
    };
  }

  private async _onStreamOpen(event: MessageEvent<Message>, data: StreamOpen) {
    const { messageType, payload, id } = data;
    const handler = this.streamHandlers[messageType];
    if (!handler) {
      return;
    }
    if (!isOriginAllowed(handler.origin, event.origin)) {
      return;
    }

    const abortController = new AbortController();
    this.streamProducers[id] = abortController;

    let seq = 0;
    let closed = false;
    const post = this._replyTo(event);
    const finish = () => {
      closed = true;
      delete this.streamProducers[id];
    };
    // 소비자가 취소하면 이후의 enqueue/close/error 를 무시한다.
    abortController.signal.addEventListener("abort", () => {
      closed = true;
    });

    const controller: PostMessageManager.StreamController = {
      enqueue: (chunk) => {
        if (closed) {
          return;
        }
        post({
          type: "stream-chunk",
          messageType,
          parentId: id,
          seq: seq++,
          payload: chunk,
        });
      },
      close: () => {
        if (closed) {
          return;
        }
        finish();
        post({ type: "stream-end", messageType, parentId: id });
      },
      error: (e) => {
        if (closed) {
          return;
        }
        finish();
        post({
          type: "stream-error",
          messageType,
          parentId: id,
          payload: serializeError(e),
        });
      },
      signal: abortController.signal,
    };

    try {
      await handler.callback(payload, controller);
    } catch (e) {
      // callback이 close/error 전에 던지면 에러로 종료한다.
      controller.error(e);
    }
  }

  private _onStreamMessage(data: StreamChunk | StreamEnd | StreamError) {
    const consumer = this.streamConsumers[data.parentId];
    if (!consumer) {
      return;
    }

    if (data.type === "stream-chunk") {
      if (data.seq !== consumer.expectedSeq) {
        // 방어 발동 시에도 공급자 자원이 남지 않도록 취소를 전파함.
        consumer.cancelAndFinish(
          new Error(
            `Stream chunk out of order for ${data.messageType}: expected ${consumer.expectedSeq}, got ${data.seq}`
          )
        );
      } else {
        consumer.expectedSeq += 1;
        consumer.buffer.push(data.payload);
        consumer.bumpIdle();
        consumer.wake?.();
      }
    } else if (data.type === "stream-end") {
      consumer.finish();
    } else {
      consumer.finish(reviveError(data.payload));
    }
  }

  register(args: PostMessageManager.RegisterProps) {
    const { messageType, callback, origin } = args;
    if (this.requestHandlers[messageType]) {
      console.warn(`Handler for ${messageType} is already registered`);
    }
    this.requestHandlers[messageType] = { callback, origin };
  }

  unregister(messageType: string) {
    delete this.requestHandlers[messageType];
  }

  async send<T>(args: PostMessageManager.SendProps) {
    const {
      messageType,
      payload,
      target,
      targetOrigin,
      timeoutMs: timeoutMsArgs,
    } = args;
    const id = uid();

    // args로 timeoutMs를 설정하면 그 값을 사용하고, 없으면 기본값을 사용합니다.
    const timeoutMs = timeoutMsArgs ?? this.timeoutMs;

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timeout: no response for ${messageType} after ${timeoutMs}ms`
          )
        );
        delete this.responseHandlers[id];
      }, timeoutMs);

      const message: MessageRequest = {
        type: "request",
        id,
        payload,
        messageType,
      };
      target.postMessage(message, targetOrigin);
      this.responseHandlers[id] = {
        type: "response",
        parentId: id,
        resolve,
        timer,
      };
    });
    return promise;
  }

  notify(args: PostMessageManager.NotifyProps): void {
    const { messageType, payload, target, targetOrigin } = args;
    const message: MessageRequest = {
      type: "request",
      id: uid(),
      payload,
      messageType,
    };
    target.postMessage(message, targetOrigin);
  }

  registerStream(args: PostMessageManager.RegisterStreamProps) {
    const { messageType, callback, origin } = args;
    if (this.streamHandlers[messageType]) {
      console.warn(`Stream handler for ${messageType} is already registered`);
    }
    this.streamHandlers[messageType] = { callback, origin };
  }

  unregisterStream(messageType: string) {
    delete this.streamHandlers[messageType];
  }

  stream<T = any>(
    args: PostMessageManager.StreamProps
  ): AsyncGenerator<T, void, void> {
    const { messageType, payload, target, targetOrigin, signal, idleTimeoutMs } =
      args;
    // 이미 abort 된 signal 은 abort 이벤트가 다시 발생하지 않으므로,
    // stream-open 을 보내지 않고 즉시 실패한다.
    if (signal?.aborted) {
      return (async function* () {
        throw new Error(`Aborted: stream for ${messageType} was cancelled`);
      })();
    }
    const id = uid();
    const idleMs = idleTimeoutMs ?? this.timeoutMs;
    const consumers = this.streamConsumers;

    const cancel = () => {
      const message: StreamCancel = {
        type: "stream-cancel",
        messageType,
        parentId: id,
      };
      target.postMessage(message, targetOrigin);
    };

    const consumer: StreamConsumer = {
      buffer: [],
      done: false,
      expectedSeq: 0,
      bumpIdle: () => {
        clearTimeout(consumer.idleTimer);
        consumer.idleTimer = setTimeout(() => {
          consumer.cancelAndFinish(
            new Error(
              `Timeout: no stream activity for ${messageType} after ${idleMs}ms`
            )
          );
        }, idleMs);
      },
      // 터미널 전이 4단계를 한 곳에 모음. 맵에서 즉시 제거해
      // "map 에 있다 ⟺ wire 에 살아있는 스트림"을 유지함.
      // 전이는 첫 번째만 유효함 — 종료 직후 abort 가 경합해도
      // 이미 확정된 종료 원인을 덮어쓰지 않도록 함.
      finish: (failure?: Error) => {
        if (consumer.done) {
          return;
        }
        consumer.failure = failure;
        consumer.done = true;
        clearTimeout(consumer.idleTimer);
        delete consumers[id];
        consumer.wake?.();
      },
      cancelAndFinish: (failure?: Error) => {
        if (consumer.done) {
          return;
        }
        cancel();
        consumer.finish(failure);
      },
    };
    consumers[id] = consumer;

    const onAbort = () => {
      consumer.cancelAndFinish(
        new Error(`Aborted: stream for ${messageType} was cancelled`)
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const open: StreamOpen = { type: "stream-open", messageType, id, payload };
    target.postMessage(open, targetOrigin);
    consumer.bumpIdle();

    return (async function* () {
      try {
        for (;;) {
          while (consumer.buffer.length === 0 && !consumer.done) {
            await new Promise<void>((resolve) => {
              consumer.wake = resolve;
            });
            consumer.wake = undefined;
          }
          while (consumer.buffer.length > 0) {
            yield consumer.buffer.shift() as T;
          }
          if (consumer.done) {
            if (consumer.failure) {
              throw consumer.failure;
            }
            return;
          }
        }
      } finally {
        // 터미널 전이의 상태 정리는 각 전이 시점에 끝나 있으므로,
        // 여기는 리스너 해제와 중도 이탈(break) 취소만 맡는다.
        signal?.removeEventListener("abort", onAbort);
        if (!consumer.done) {
          consumer.cancelAndFinish();
        }
      }
    })();
  }

  requestHandlers: Record<string, RequestHandler>;
  responseHandlers: Record<string, ResponseHandler>;
  streamHandlers: Record<string, StreamHandler>;
  streamConsumers: Record<string, StreamConsumer>;
  streamProducers: Record<string, AbortController>;
  timeoutMs: number;
}
