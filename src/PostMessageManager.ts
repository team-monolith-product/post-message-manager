import { uid } from "uid";
import {
  createStreamWire,
  readStreamWire,
  serializeStreamError,
  streamWireTransferList,
} from "./StreamTransport";

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

type RequestHandler = Pick<
  PostMessageManager.RegisterProps,
  "callback" | "origin"
>;
type ResponseHandler = {
  resolve: (payload: any) => void;
  timer: ReturnType<typeof setTimeout>;
} & Pick<MessageResponse, "type" | "parentId">;

function isOriginAllowed(
  allowed: string | ((origin: string) => boolean) | undefined,
  origin: string
): boolean {
  if (!allowed) {
    return true;
  }
  return typeof allowed === "string" ? allowed === origin : allowed(origin);
}

function createAbortError(messageType: string): Error {
  const error = new Error(`Stream for ${messageType} was aborted`);
  error.name = "AbortError";
  return error;
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

  export interface RegisterStreamProps<T = any> {
    messageType: string;
    callback: (payload: any) => ReadableStream<T> | Promise<ReadableStream<T>>;
    origin?: string | ((origin: string) => boolean);
  }

  export interface StreamProps extends SendProps {
    signal?: AbortSignal;
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
 */
export interface PostMessageManager {
  register(args: PostMessageManager.RegisterProps): void;
  unregister(messageType: string): void;
  send<T>(args: PostMessageManager.SendProps): Promise<T>;
  notify(args: PostMessageManager.NotifyProps): void;
  registerStream<T>(args: PostMessageManager.RegisterStreamProps<T>): void;
  unregisterStream(messageType: string): void;
  stream<T>(args: PostMessageManager.StreamProps): AsyncGenerator<T, void, void>;
}

export class PostMessageManagerImpl implements PostMessageManager {
  constructor(timeoutMs = 3000) {
    this.requestHandlers = Object.create(null);
    this.responseHandlers = Object.create(null);
    this.timeoutMs = timeoutMs;
    this._init();
  }

  private _init() {
    window.addEventListener("message", this._onMessage.bind(this));
  }

  private async _onMessage(
    event: MessageEvent<MessageResponse | MessageRequest>
  ) {
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
      // srcdoc iframe의 origin은 "null"(opaque origin)이므로 postMessage의
      // targetOrigin으로 사용할 수 없다. 이 경우 "*"로 대체한다.
      const responseOrigin = event.origin === "null" ? "*" : event.origin;
      event.source?.postMessage(message, {
        targetOrigin: responseOrigin,
        transfer: streamWireTransferList(response),
      });
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

  registerStream<T>(args: PostMessageManager.RegisterStreamProps<T>): void {
    const { messageType, callback, origin } = args;
    this.register({
      messageType,
      origin,
      callback: async (payload) => {
        try {
          return createStreamWire(await callback(payload));
        } catch (error) {
          return serializeStreamError(error);
        }
      },
    });
  }

  unregisterStream(messageType: string): void {
    this.unregister(messageType);
  }

  stream<T>(args: PostMessageManager.StreamProps): AsyncGenerator<T, void, void> {
    const manager = this;
    return (async function* () {
      const { signal, ...sendArgs } = args;
      if (signal?.aborted) {
        throw createAbortError(args.messageType);
      }

      const readable = readStreamWire<T>(await manager.send(sendArgs));
      const reader = readable.getReader();
      let abortError: Error | undefined;
      const onAbort = () => {
        abortError = createAbortError(args.messageType);
        void reader.cancel(abortError);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (abortError) {
            throw abortError;
          }
          if (done) {
            return;
          }
          yield value;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await reader.cancel();
      }
    })();
  }

  requestHandlers: Record<string, RequestHandler>;
  responseHandlers: Record<string, ResponseHandler>;
  timeoutMs: number;
}
