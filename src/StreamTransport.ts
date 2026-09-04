const STREAM_WIRE_MARKER = "post-message-manager-stream-v1";

type SerializedError = {
  name: string;
  message: string;
};

type StreamFrame<T> =
  | { type: "chunk"; chunk: T }
  | { type: "error"; error: SerializedError };

type PortMessage<T> =
  | { type: "pull" }
  | { type: "chunk"; chunk: T }
  | { type: "close" }
  | { type: "error"; error: SerializedError }
  | { type: "cancel"; reason?: SerializedError };

export type StreamWire<T> =
  | {
      marker: typeof STREAM_WIRE_MARKER;
      transport: "native";
      stream: ReadableStream<StreamFrame<T>>;
    }
  | {
      marker: typeof STREAM_WIRE_MARKER;
      transport: "message-port";
      port: MessagePort;
    }
  | {
      marker: typeof STREAM_WIRE_MARKER;
      transport: "error";
      error: SerializedError;
    };

let nativeTransferSupport: boolean | undefined;

export function supportsNativeStreamTransfer(): boolean {
  if (nativeTransferSupport !== undefined) {
    return nativeTransferSupport;
  }

  if (
    typeof ReadableStream === "undefined" ||
    typeof MessageChannel === "undefined"
  ) {
    nativeTransferSupport = false;
    return nativeTransferSupport;
  }

  const channel = new MessageChannel();
  const stream = new ReadableStream();

  try {
    channel.port1.postMessage(stream, [stream]);
    nativeTransferSupport = true;
  } catch {
    nativeTransferSupport = false;
  } finally {
    channel.port1.close();
    channel.port2.close();
  }

  return nativeTransferSupport;
}

export function serializeStreamError(error: unknown): StreamWire<never> {
  return {
    marker: STREAM_WIRE_MARKER,
    transport: "error",
    error: serializeError(error),
  };
}

export function createStreamWire<T>(
  source: ReadableStream<T>,
  useNativeTransfer = supportsNativeStreamTransfer()
): StreamWire<T> {
  if (!(source instanceof ReadableStream)) {
    throw new TypeError("Stream handler must return a ReadableStream");
  }

  const framed = frameStream(source);
  if (useNativeTransfer) {
    return {
      marker: STREAM_WIRE_MARKER,
      transport: "native",
      stream: framed,
    };
  }

  return {
    marker: STREAM_WIRE_MARKER,
    transport: "message-port",
    port: createReadablePort(framed),
  };
}

export function streamWireTransferList(wire: unknown): Transferable[] {
  if (!isStreamWire(wire)) {
    return [];
  }
  if (wire.transport === "native") {
    return [wire.stream];
  }
  if (wire.transport === "message-port") {
    return [wire.port];
  }
  return [];
}

export function readStreamWire<T>(wire: unknown): ReadableStream<T> {
  if (!isStreamWire(wire)) {
    throw new TypeError("Invalid stream response");
  }
  if (wire.transport === "native") {
    return unframeStream(wire.stream as ReadableStream<StreamFrame<T>>);
  }
  if (wire.transport === "message-port") {
    return unframeStream(readFromPort<StreamFrame<T>>(wire.port));
  }

  throw reviveError(wire.error);
}

function frameStream<T>(source: ReadableStream<T>): ReadableStream<StreamFrame<T>> {
  const reader = source.getReader();
  return new ReadableStream<StreamFrame<T>>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
        } else {
          controller.enqueue({ type: "chunk", chunk: result.value });
        }
      } catch (error) {
        controller.enqueue({ type: "error", error: serializeError(error) });
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function unframeStream<T>(
  source: ReadableStream<StreamFrame<T>>
): ReadableStream<T> {
  const reader = source.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
        } else if (result.value.type === "chunk") {
          controller.enqueue(result.value.chunk);
        } else {
          const error = reviveError(result.value.error);
          await reader.cancel(error).catch(() => undefined);
          controller.error(error);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function createReadablePort<T>(source: ReadableStream<T>): MessagePort {
  const channel = new MessageChannel();
  const reader = source.getReader();
  let terminal = false;
  let reads = Promise.resolve();

  const close = () => {
    terminal = true;
    channel.port1.close();
  };
  const read = async () => {
    if (terminal) {
      return;
    }
    try {
      const result = await reader.read();
      if (result.done) {
        terminal = true;
        channel.port1.postMessage({ type: "close" } satisfies PortMessage<T>);
        close();
        return;
      }
      channel.port1.postMessage({
        type: "chunk",
        chunk: result.value,
      } satisfies PortMessage<T>);
    } catch (error) {
      terminal = true;
      channel.port1.postMessage({
        type: "error",
        error: serializeError(error),
      } satisfies PortMessage<T>);
      close();
    }
  };

  channel.port1.onmessage = (event: MessageEvent<PortMessage<T>>) => {
    if (event.data.type === "pull") {
      reads = reads.then(read);
      return;
    }
    if (event.data.type === "cancel" && !terminal) {
      terminal = true;
      void reader
        .cancel(
          event.data.reason === undefined
            ? undefined
            : reviveError(event.data.reason)
        )
        .catch(() => undefined)
        .finally(close);
    }
  };

  return channel.port2;
}

function readFromPort<T>(port: MessagePort): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      port.onmessage = (event: MessageEvent<PortMessage<T>>) => {
        if (event.data.type === "chunk") {
          controller.enqueue(event.data.chunk);
        } else if (event.data.type === "close") {
          controller.close();
          port.close();
        } else if (event.data.type === "error") {
          controller.error(reviveError(event.data.error));
          port.close();
        }
      };
    },
    pull() {
      port.postMessage({ type: "pull" } satisfies PortMessage<T>);
    },
    cancel(reason) {
      port.postMessage({
        type: "cancel",
        reason: reason === undefined ? undefined : serializeError(reason),
      } satisfies PortMessage<T>);
      port.close();
    },
  });
}

function serializeError(error: unknown): SerializedError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function reviveError(error: SerializedError): Error {
  const result = new Error(error.message);
  result.name = error.name;
  return result;
}

function isStreamWire(value: unknown): value is StreamWire<unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("marker" in value) ||
    value.marker !== STREAM_WIRE_MARKER ||
    !("transport" in value)
  ) {
    return false;
  }

  if (value.transport === "native") {
    return "stream" in value && value.stream instanceof ReadableStream;
  }
  if (value.transport === "message-port") {
    return "port" in value;
  }
  return (
    value.transport === "error" &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "name" in value.error &&
    typeof value.error.name === "string" &&
    "message" in value.error &&
    typeof value.error.message === "string"
  );
}
