const STREAM_ERROR = "post-message-manager-stream-error";

type SerializedError = {
  name: string;
  message: string;
};

type StreamErrorWire = {
  type: typeof STREAM_ERROR;
  error: SerializedError;
};

type StreamWire<T> = ReadableStream<T> | StreamErrorWire;

export function serializeStreamError(error: unknown): StreamErrorWire {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    type: STREAM_ERROR,
    error: { name: value.name, message: value.message },
  };
}

export function createStreamWire<T>(source: ReadableStream<T>): StreamWire<T> {
  if (!(source instanceof ReadableStream)) {
    throw new TypeError("registerStream callback must return a ReadableStream");
  }
  return source;
}

export function streamWireTransferList<T>(
  wire: StreamWire<T>
): Transferable[] {
  return wire instanceof ReadableStream ? [wire] : [];
}

export function readStreamWire<T>(wire: unknown): ReadableStream<T> {
  if (wire instanceof ReadableStream) {
    return wire;
  }
  if (isStreamErrorWire(wire)) {
    const error = new Error(wire.error.message);
    error.name = wire.error.name;
    throw error;
  }
  throw new TypeError("Invalid stream response");
}

function isStreamErrorWire(value: unknown): value is StreamErrorWire {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as StreamErrorWire).type === STREAM_ERROR
  );
}
