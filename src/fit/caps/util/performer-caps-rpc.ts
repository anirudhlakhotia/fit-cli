/**
 * The one gRPC call fit-cli makes: `performerCapsFetch` on `protocol.PerformerService`.
 *
 * The FIT test-driver (Java) is normally the only thing that speaks gRPC to a
 * performer. We need just this single unary RPC, whose request message is empty and
 * whose response is a few repeated enums plus a couple of strings — so rather than
 * take on @grpc/grpc-js and the .proto import graph, we frame the call by hand over
 * node:http2 and decode the reply with `protobuf.ts`.
 *
 * gRPC-over-HTTP/2 in one paragraph: POST to /<package>.<Service>/<method> with
 * content-type application/grpc; the body is a sequence of length-prefixed frames,
 * each being a 1-byte "compressed" flag then a 4-byte big-endian length then the
 * protobuf message; the call's real status arrives in the HTTP trailers as
 * `grpc-status` (0 = OK), not in the HTTP status code.
 */
import http2, { type IncomingHttpHeaders, type IncomingHttpStatusHeader } from "node:http2";
import { decodeMessage, readRepeatedEnum, readString } from "./protobuf.js";

/** gRPC status codes we care about. https://grpc.github.io/grpc/core/md_doc_statuscodes.html */
export const GRPC_STATUS_OK = 0;
export const GRPC_STATUS_UNIMPLEMENTED = 12;

const CAPS_FETCH_PATH = "/protocol.PerformerService/performerCapsFetch";

/** How long to wait for a performer to answer before giving up on it. */
export const CAPS_FETCH_TIMEOUT_MS = 30_000;

/**
 * A decoded PerformerCapsFetchResponse.
 *
 * Caps are raw enum numbers — the three enums are independent and all start at 0, so
 * they must be kept apart and only ever resolved to names against their own group.
 */
export interface PerformerCaps {
  /** `transactions.Caps` — field 1. */
  transactionCaps: number[];
  /** `sdk.Caps` — field 8. */
  sdkCaps: number[];
  /** `performer.Caps` — field 7. */
  performerCaps: number[];
  /** `shared.API` — field 6. Empty means the performer supports only API.DEFAULT. */
  supportedApis: number[];
  /** e.g. "java-sdk" */
  userAgent?: string;
  /** The SDK/library version under test, e.g. "3.5.0". */
  libraryVersion?: string;
  /** Only set for transactions-capable performers, e.g. "2.0". */
  transactionsProtocolVersion?: string;
}

/** Field numbers from performer.caps.proto's PerformerCapsFetchResponse. */
const FIELD_TRANSACTION_CAPS = 1;
const FIELD_USER_AGENT = 2;
const FIELD_TRANSACTIONS_PROTOCOL_VERSION = 3;
const FIELD_LIBRARY_VERSION = 4;
const FIELD_SUPPORTED_APIS = 6;
const FIELD_PERFORMER_CAPS = 7;
const FIELD_SDK_CAPS = 8;

/** Thrown when the performer answers, but with a non-OK gRPC status. */
export class GrpcStatusError extends Error {
  constructor(
    readonly status: number,
    readonly grpcMessage: string | undefined,
  ) {
    super(`gRPC call failed with status ${status}${grpcMessage ? `: ${grpcMessage}` : ""}`);
    this.name = "GrpcStatusError";
  }

  /**
   * True if the performer simply hasn't implemented performerCapsFetch. That's a
   * meaningful answer ("this SDK is too old"), not a fit-cli failure.
   */
  get isUnimplemented(): boolean {
    return this.status === GRPC_STATUS_UNIMPLEMENTED;
  }
}

/** Wrap a protobuf message in a gRPC length-prefixed frame. */
export function encodeGrpcFrame(message: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt8(0, 0); // not compressed
  frame.writeUInt32BE(message.length, 1);
  Buffer.from(message).copy(frame, 5);
  return frame;
}

/**
 * Pull the single protobuf message out of a gRPC response body.
 *
 * We never set grpc-accept-encoding, so a performer must not compress; a set
 * compressed-flag means we've misread the stream and should say so loudly rather
 * than hand garbage to the decoder.
 */
export function decodeGrpcFrame(body: Buffer): Buffer {
  if (body.length < 5) {
    throw new Error(`gRPC response too short to be a frame (${body.length} bytes)`);
  }
  const compressed = body.readUInt8(0);
  if (compressed !== 0) {
    throw new Error("gRPC response is compressed, which fit-cli did not ask for and cannot decode");
  }
  const length = body.readUInt32BE(1);
  if (5 + length !== body.length) {
    throw new Error(`gRPC frame length mismatch: header says ${length} bytes, body has ${body.length - 5}`);
  }
  return body.subarray(5, 5 + length);
}

/** Decode the protobuf body of a PerformerCapsFetchResponse. */
export function decodePerformerCapsResponse(message: Buffer): PerformerCaps {
  const fields = decodeMessage(message);
  return {
    transactionCaps: readRepeatedEnum(fields, FIELD_TRANSACTION_CAPS),
    sdkCaps: readRepeatedEnum(fields, FIELD_SDK_CAPS),
    performerCaps: readRepeatedEnum(fields, FIELD_PERFORMER_CAPS),
    supportedApis: readRepeatedEnum(fields, FIELD_SUPPORTED_APIS),
    userAgent: readString(fields, FIELD_USER_AGENT),
    libraryVersion: readString(fields, FIELD_LIBRARY_VERSION),
    transactionsProtocolVersion: readString(fields, FIELD_TRANSACTIONS_PROTOCOL_VERSION),
  };
}

/**
 * Call performerCapsFetch against a performer listening on `host:port`.
 *
 * Rejects with {@link GrpcStatusError} if the performer answers with a non-OK gRPC
 * status (notably UNIMPLEMENTED, for performers predating this RPC), and with a
 * plain Error if it can't be reached at all.
 */
export function fetchPerformerCaps(
  host: string,
  port: number,
  timeoutMs: number = CAPS_FETCH_TIMEOUT_MS,
): Promise<PerformerCaps> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`http://${host}:${port}`);
    const chunks: Buffer[] = [];
    let trailerStatus: number | undefined;
    let trailerMessage: string | undefined;
    let settled = false;

    const finish = (err: Error | undefined, caps?: PerformerCaps): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      if (err) reject(err);
      else resolve(caps as PerformerCaps);
    };

    const timer = setTimeout(
      () => finish(new Error(`Timed out after ${timeoutMs}ms waiting for ${host}:${port} to answer performerCapsFetch`)),
      timeoutMs,
    );

    client.on("error", (err: Error) => finish(err));

    const request = client.request({
      ":method": "POST",
      ":path": CAPS_FETCH_PATH,
      "content-type": "application/grpc",
      // gRPC requires this; without it a compliant server may reject the call.
      te: "trailers",
    });

    request.on("error", (err: Error) => finish(err));

    /** gRPC's real status lives in the trailers — but an error can arrive "trailers-only", in the headers. */
    const readStatus = (headers: IncomingHttpHeaders & Partial<IncomingHttpStatusHeader>): void => {
      const status = headers["grpc-status"];
      if (status === undefined) return;
      trailerStatus = Number(status);
      const message = headers["grpc-message"];
      trailerMessage = typeof message === "string" ? message : undefined;
    };

    request.on("response", readStatus);
    request.on("trailers", readStatus);

    request.on("data", (chunk: Buffer) => chunks.push(chunk));

    request.on("end", () => {
      try {
        if (trailerStatus !== undefined && trailerStatus !== GRPC_STATUS_OK) {
          finish(new GrpcStatusError(trailerStatus, trailerMessage));
          return;
        }
        const body = Buffer.concat(chunks);
        if (body.length === 0) {
          finish(new Error("Performer returned an empty gRPC response with no status"));
          return;
        }
        finish(undefined, decodePerformerCapsResponse(decodeGrpcFrame(body)));
      } catch (err) {
        finish(err as Error);
      }
    });

    // PerformerCapsFetchRequest has no fields, so the message is zero bytes.
    request.end(encodeGrpcFrame(new Uint8Array(0)));
  });
}
