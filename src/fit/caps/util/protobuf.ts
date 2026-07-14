/**
 * A deliberately tiny protobuf wire-format reader.
 *
 * fit-cli only needs to decode one message — PerformerCapsFetchResponse — whose
 * fields are repeated enums (varints) and strings. Pulling in protobufjs or
 * @grpc/proto-loader would mean either vendoring the whole .proto import graph or
 * loading it from a checkout at run time, and neither survives `bun build --compile`
 * cleanly. Decoding the handful of fields we care about by hand is smaller, has no
 * dependencies, and works identically in the compiled binary.
 *
 * See `performer-caps-rpc.ts` for the message this feeds.
 */

/** A single field occurrence on the wire. */
export interface WireField {
  wireType: number;
  /** Varint fields yield a number; length-delimited fields yield their raw bytes. */
  value: number | Buffer;
}

const WIRETYPE_VARINT = 0;
const WIRETYPE_FIXED64 = 1;
const WIRETYPE_LENGTH_DELIMITED = 2;
const WIRETYPE_FIXED32 = 5;

/** Read a base-128 varint at `offset`, returning its value and the next offset. */
function readVarint(buf: Buffer, offset: number): { value: number; offset: number } {
  let result = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= buf.length) {
      throw new Error("Truncated varint: ran off the end of the buffer");
    }
    const byte = buf[i++];
    // Number is safe here: every field we read is a small enum or a length.
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) {
      throw new Error("Varint too long (more than 10 bytes)");
    }
  }
  return { value: result, offset: i };
}

/**
 * Decode a protobuf message into a map of field number → occurrences.
 *
 * Unknown fields are kept rather than rejected: the FIT protocol adds fields over
 * time and an older fit-cli must not fall over on a newer performer.
 */
export function decodeMessage(buf: Buffer): Map<number, WireField[]> {
  const fields = new Map<number, WireField[]>();
  let offset = 0;

  const push = (field: number, entry: WireField): void => {
    const existing = fields.get(field);
    if (existing) existing.push(entry);
    else fields.set(field, [entry]);
  };

  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    offset = key.offset;
    const fieldNumber = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (fieldNumber === 0) {
      throw new Error("Invalid protobuf: field number 0");
    }

    switch (wireType) {
      case WIRETYPE_VARINT: {
        const v = readVarint(buf, offset);
        offset = v.offset;
        push(fieldNumber, { wireType, value: v.value });
        break;
      }
      case WIRETYPE_LENGTH_DELIMITED: {
        const len = readVarint(buf, offset);
        offset = len.offset;
        const end = offset + len.value;
        if (end > buf.length) {
          throw new Error("Truncated length-delimited field");
        }
        push(fieldNumber, { wireType, value: buf.subarray(offset, end) });
        offset = end;
        break;
      }
      case WIRETYPE_FIXED64:
        offset += 8;
        break;
      case WIRETYPE_FIXED32:
        offset += 4;
        break;
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }

  return fields;
}

/** Read a sequence of varints packed into a single length-delimited field. */
function readPackedVarints(buf: Buffer): number[] {
  const values: number[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const v = readVarint(buf, offset);
    values.push(v.value);
    offset = v.offset;
  }
  return values;
}

/**
 * Read a `repeated` enum field.
 *
 * proto3 packs repeated scalars by default, but a performer may send them
 * unpacked, and both forms are valid on the wire — so accept either.
 */
export function readRepeatedEnum(fields: Map<number, WireField[]>, fieldNumber: number): number[] {
  const entries = fields.get(fieldNumber) ?? [];
  return entries.flatMap((entry) =>
    entry.wireType === WIRETYPE_LENGTH_DELIMITED
      ? readPackedVarints(entry.value as Buffer)
      : [entry.value as number],
  );
}

/** Read an optional string field. Returns undefined if absent or empty. */
export function readString(fields: Map<number, WireField[]>, fieldNumber: number): string | undefined {
  const entry = fields.get(fieldNumber)?.at(-1);
  if (!entry || entry.wireType !== WIRETYPE_LENGTH_DELIMITED) return undefined;
  const text = (entry.value as Buffer).toString("utf8");
  return text.length > 0 ? text : undefined;
}
