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
  stream?: true;
}

// response type 메시지 객체 구성입니다.
interface MessageResponse {
  type: "response";
  messageType: string;
  parentId: string;
  payload: any;
}

interface MessageStreamCancel {
  type: "stream-cancel";
  parentId: string;
  reason: unknown;
}

type RequestContext = {
  id: string;
  origin: string;
  source: MessageEventSource | null;
};
type PreparedResponse = {
  payload: any;
  transfer: Transferable[];
};
type RequestHandler = {
  callback: (
    payload: any,
    context: RequestContext,
  ) => Promise<PreparedResponse> | PreparedResponse;
  origin?: string | ((origin: string) => boolean);
};
type ResponseHandler = {
  resolve: (payload: any) => void;
  timer: ReturnType<typeof setTimeout>;
} & Pick<MessageResponse, "type" | "parentId">;
type StreamRequestState = {
  cancelled: boolean;
  reason?: unknown;
  origin: string;
  source: MessageEventSource | null;
};

function isOriginAllowed(
  allowed: string | ((origin: string) => boolean) | undefined,
  origin: string,
): boolean {
  if (!allowed) {
    return true;
  }
  return typeof allowed === "string" ? allowed === origin : allowed(origin);
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
  stream<T>(args: PostMessageManager.StreamProps): Promise<ReadableStream<T>>;
}

export class PostMessageManagerImpl implements PostMessageManager {
  constructor(timeoutMs = 3000) {
    this.requestHandlers = Object.create(null);
    this.responseHandlers = Object.create(null);
    this.streamHandlers = Object.create(null);
    this.streamRequestStates = Object.create(null);
    this.timeoutMs = timeoutMs;
    this._init();
  }

  private _init() {
    window.addEventListener("message", this._onMessage.bind(this));
  }

  private async _onMessage(
    event: MessageEvent<MessageResponse | MessageRequest | MessageStreamCancel>,
  ) {
    const { data } = event;

    if (data.type === "stream-cancel") {
      const state = this.streamRequestStates[data.parentId];
      if (
        state &&
        state.origin === event.origin &&
        state.source === event.source
      ) {
        state.cancelled = true;
        state.reason = data.reason;
      }
    } else if (data.type === "request") {
      // request type의 message를 받으면, handler를 찾아서 실행하고 response message를 보낸다.
      const { messageType, payload, id } = data;
      const handler = (
        data.stream ? this.streamHandlers : this.requestHandlers
      )[messageType];
      if (!handler) {
        return;
      }

      if (!isOriginAllowed(handler.origin, event.origin)) {
        return;
      }

      // request message에 대해서는 항상 response message를 보낸다.
      // (callback의 return 값이 없어도 response message를 보낸다.)
      const response = await handler.callback(payload, {
        id,
        origin: event.origin,
        source: event.source,
      });
      const message: MessageResponse = {
        type: "response",
        parentId: id,
        messageType,
        payload: response.payload,
      };
      // srcdoc iframe의 origin은 "null"(opaque origin)이므로 postMessage의
      // targetOrigin으로 사용할 수 없다. 이 경우 "*"로 대체한다.
      const responseOrigin = event.origin === "null" ? "*" : event.origin;
      try {
        event.source?.postMessage(message, {
          targetOrigin: responseOrigin,
          transfer: response.transfer,
        });
      } catch (error) {
        if (!data.stream) throw error;
        event.source?.postMessage(
          {
            ...message,
            payload: serializeStreamError(error),
          },
          { targetOrigin: responseOrigin },
        );
      }
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
    this._register(messageType, {
      origin,
      callback: async (payload) => ({
        payload: await callback(payload),
        transfer: [],
      }),
    });
  }

  private _register(messageType: string, handler: RequestHandler) {
    if (this.requestHandlers[messageType]) {
      console.warn(`Handler for ${messageType} is already registered`);
    }
    this.requestHandlers[messageType] = handler;
  }

  unregister(messageType: string) {
    delete this.requestHandlers[messageType];
  }

  async send<T>(args: PostMessageManager.SendProps) {
    return this._send<T>(args);
  }

  private _send<T>(
    args: PostMessageManager.SendProps,
    id = uid(),
    stream?: true,
  ) {
    const {
      messageType,
      payload,
      target,
      targetOrigin,
      timeoutMs: timeoutMsArgs,
    } = args;

    // args로 timeoutMs를 설정하면 그 값을 사용하고, 없으면 기본값을 사용합니다.
    const timeoutMs = timeoutMsArgs ?? this.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timeout: no response for ${messageType} after ${timeoutMs}ms`,
          ),
        );
        delete this.responseHandlers[id];
      }, timeoutMs);

      const message: MessageRequest = {
        type: "request",
        id,
        payload,
        messageType,
        ...(stream ? { stream } : {}),
      };
      this.responseHandlers[id] = {
        type: "response",
        parentId: id,
        resolve,
        timer,
      };
      try {
        target.postMessage(message, targetOrigin);
      } catch (error) {
        clearTimeout(timer);
        delete this.responseHandlers[id];
        reject(error);
      }
    });
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
    this.streamHandlers[messageType] = {
      origin,
      callback: async (payload, context) => {
        const state: StreamRequestState = {
          cancelled: false,
          origin: context.origin,
          source: context.source,
        };
        this.streamRequestStates[context.id] = state;
        try {
          const source = await callback(payload);
          if (state.cancelled) {
            void source.cancel(state.reason).catch(() => undefined);
            return {
              payload: serializeStreamError(state.reason),
              transfer: [],
            };
          }
          const response = createStreamWire(source);
          return {
            payload: response,
            transfer: streamWireTransferList(response),
          };
        } catch (error) {
          return { payload: serializeStreamError(error), transfer: [] };
        } finally {
          delete this.streamRequestStates[context.id];
        }
      },
    };
  }

  unregisterStream(messageType: string): void {
    delete this.streamHandlers[messageType];
  }

  async stream<T>(
    args: PostMessageManager.StreamProps,
  ): Promise<ReadableStream<T>> {
    const { signal, ...sendArgs } = args;
    if (signal?.aborted) {
      throw signal.reason;
    }
    const requestId = uid();
    let rejectOpening: (reason: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectOpening = reject;
    });
    const onAbort = () => rejectOpening(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const response = this._send<unknown>(sendArgs, requestId, true);
    let wire: unknown;
    try {
      wire = await Promise.race([response, aborted]);
    } catch (reason) {
      const message: MessageStreamCancel = {
        type: "stream-cancel",
        parentId: requestId,
        reason,
      };
      try {
        sendArgs.target.postMessage(message, sendArgs.targetOrigin);
      } catch (error) {
        sendArgs.target.postMessage(
          { ...message, reason: error },
          sendArgs.targetOrigin,
        );
      }
      void response
        .then((lateWire) => readStreamWire<T>(lateWire).cancel(reason))
        .catch(() => undefined);
      throw reason;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    const source = readStreamWire<T>(wire);
    return signal
      ? source.pipeThrough(new TransformStream<T, T>(), { signal })
      : source;
  }

  requestHandlers: Record<string, RequestHandler>;
  responseHandlers: Record<string, ResponseHandler>;
  private streamRequestStates: Record<string, StreamRequestState>;
  private streamHandlers: Record<string, RequestHandler>;
  timeoutMs: number;
}
