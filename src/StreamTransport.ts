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
      transport: "error";
      error: SerializedError;
    };

export function serializeStreamError(error: unknown): StreamWire<never> {
  return {
    marker: STREAM_WIRE_MARKER,
    transport: "error",
    error: serializeError(error),
  };
}

export function createStreamWire<T>(
  source: ReadableStream<T>
): StreamWire<T> {
  if (!(source instanceof ReadableStream)) {
    throw new TypeError("Stream handler must return a ReadableStream");
  }

  return {
    marker: STREAM_WIRE_MARKER,
    transport: "native",
    stream: frameStream(source),
  };
}

export function streamWireTransferList(wire: unknown): Transferable[] {
  return isStreamWire(wire) && wire.transport === "native"
    ? [wire.stream]
    : [];
}

export function readStreamWire<T>(wire: unknown): ReadableStream<T> {
  if (!isStreamWire(wire)) {
    throw new TypeError("Invalid stream response");
  }
  if (wire.transport === "native") {
    return unframeStream(wire.stream as ReadableStream<StreamFrame<T>>);
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
