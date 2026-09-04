import { RemoteWritableStream, fromReadablePort } from "remote-web-streams";

const STREAM_WIRE_MARKER = "post-message-manager-stream-v1";

type SerializedError = {
  name: string;
  message: string;
};

type StreamFrame<T> =
  | { type: "chunk"; chunk: T }
  | { type: "error"; error: SerializedError };

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
    error:
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "Error", message: String(error) },
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

  const { writable, readablePort } =
    new RemoteWritableStream<StreamFrame<T>>();
  void framed.pipeTo(writable).catch(() => undefined);

  return {
    marker: STREAM_WIRE_MARKER,
    transport: "message-port",
    port: readablePort,
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
    return unframeStream(fromReadablePort<StreamFrame<T>>(wire.port));
  }

  const error = new Error(wire.error.message);
  error.name = wire.error.name;
  throw error;
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
