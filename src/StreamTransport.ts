const STREAM_ERROR = "post-message-manager-stream-error";
const STREAM_PORT = "post-message-manager-stream-port";

type SerializedError = {
  name: string;
  message: string;
};

type StreamErrorWire = {
  type: typeof STREAM_ERROR;
  error: SerializedError;
};

type StreamPortWire = {
  type: typeof STREAM_PORT;
  port: MessagePort;
};

type PortMessage<T> =
  | { type: "pull" }
  | { type: "chunk"; value: T }
  | { type: "close" }
  | { type: "error"; error: SerializedError }
  | { type: "cancel" };

export type StreamWire<T> =
  | ReadableStream<T>
  | StreamErrorWire
  | StreamPortWire;

let nativeStreamTransferSupport: boolean | undefined;

export function supportsNativeStreamTransfer(): boolean {
  if (nativeStreamTransferSupport !== undefined) {
    return nativeStreamTransferSupport;
  }

  const channel = new MessageChannel();
  const stream = new ReadableStream();
  try {
    channel.port1.postMessage(stream, [stream]);
    nativeStreamTransferSupport = true;
  } catch {
    nativeStreamTransferSupport = false;
  } finally {
    channel.port1.close();
    channel.port2.close();
  }

  return nativeStreamTransferSupport;
}

export function serializeStreamError(error: unknown): StreamErrorWire {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    type: STREAM_ERROR,
    error: { name: value.name, message: value.message },
  };
}

export function createStreamWire<T>(
  source: ReadableStream<T>,
  useNative = supportsNativeStreamTransfer()
): StreamWire<T> {
  if (!(source instanceof ReadableStream)) {
    throw new TypeError("registerStream callback must return a ReadableStream");
  }

  if (useNative) {
    return source;
  }

  return {
    type: STREAM_PORT,
    port: createReadablePort(source),
  };
}

export function streamWireTransferList<T>(
  wire: StreamWire<T>
): Transferable[] {
  if (wire instanceof ReadableStream) {
    return [wire];
  }
  if (isStreamPortWire(wire)) {
    return [wire.port];
  }
  return [];
}

export function readStreamWire<T>(wire: unknown): ReadableStream<T> {
  if (wire instanceof ReadableStream) {
    return wire;
  }
  if (isStreamPortWire(wire)) {
    return readFromPort<T>(wire.port);
  }
  if (isStreamErrorWire(wire)) {
    throw reviveError(wire.error);
  }
  throw new TypeError("Invalid stream response");
}

function createReadablePort<T>(source: ReadableStream<T>): MessagePort {
  const channel = new MessageChannel();
  const reader = source.getReader();
  let terminal = false;
  let reading = false;

  const finish = () => {
    if (terminal) {
      return false;
    }
    terminal = true;
    channel.port1.close();
    return true;
  };

  const send = (message: PortMessage<T>) => {
    channel.port1.postMessage(message);
  };

  const sendError = (error: unknown) => {
    try {
      send({ type: "error", error: toSerializedError(error) });
    } finally {
      finish();
    }
  };

  channel.port1.onmessage = async (event: MessageEvent<PortMessage<T>>) => {
    if (terminal) {
      return;
    }

    if (event.data.type === "cancel") {
      if (finish()) {
        void reader.cancel().catch(() => undefined);
      }
      return;
    }

    if (event.data.type !== "pull" || reading) {
      return;
    }

    reading = true;
    try {
      const { done, value } = await reader.read();
      if (terminal) {
        return;
      }
      if (done) {
        send({ type: "close" });
        finish();
      } else {
        send({ type: "chunk", value });
      }
    } catch (error) {
      if (!terminal) {
        sendError(error);
      }
    } finally {
      reading = false;
    }
  };
  channel.port1.start();

  return channel.port2;
}

function readFromPort<T>(port: MessagePort): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      let terminal = false;
      const finish = () => {
        if (terminal) {
          return false;
        }
        terminal = true;
        port.close();
        return true;
      };

      port.onmessage = (event: MessageEvent<PortMessage<T>>) => {
        if (terminal) {
          return;
        }

        const message = event.data;
        if (message.type === "chunk") {
          controller.enqueue(message.value);
        } else if (message.type === "close") {
          if (finish()) {
            controller.close();
          }
        } else if (message.type === "error") {
          if (finish()) {
            controller.error(reviveError(message.error));
          }
        }
      };
      port.start();
    },
    pull() {
      port.postMessage({ type: "pull" } satisfies PortMessage<T>);
    },
    cancel() {
      port.postMessage({ type: "cancel" } satisfies PortMessage<T>);
      port.close();
    },
  });
}

function toSerializedError(error: unknown): SerializedError {
  const value = error instanceof Error ? error : new Error(String(error));
  return { name: value.name, message: value.message };
}

function reviveError(error: SerializedError): Error {
  const value = new Error(error.message);
  value.name = error.name;
  return value;
}

function isStreamErrorWire(value: unknown): value is StreamErrorWire {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as StreamErrorWire).type === STREAM_ERROR
  );
}

function isStreamPortWire(value: unknown): value is StreamPortWire {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as StreamPortWire).type === STREAM_PORT &&
    "port" in value
  );
}
