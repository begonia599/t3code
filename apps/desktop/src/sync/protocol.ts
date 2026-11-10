// @effect-diagnostics nodeBuiltinImport:off -- Native loopback framing.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

// Shared with native/sync-ssh-shim/main.go: uint8 kind + uint32 BE length.
// Payloads are <=64 KiB. EOF is empty; exit is a uint32 BE status in 0..255.
export const Frame = { stdin: 1, eof: 2, stdout: 3, stderr: 4, exit: 5, error: 6 } as const;
export const MAX_PAYLOAD = 64 * 1024;
export const MAX_HEADER = 16 * 1024;
export const RelayHeader = Schema.Struct({
  v: Schema.Literal(1),
  token: Schema.String,
  host: Schema.String,
  command: Schema.String,
});
export const decodeHeader = Schema.decodeUnknownSync(Schema.fromJsonString(RelayHeader), {
  onExcessProperty: "error",
});
export const encodeHeader = Schema.encodeSync(Schema.fromJsonString(RelayHeader));

// IDs are generated as UUIDs, but the contract also accepts imported nonempty
// strings. A 224-bit SHA-256 prefix keeps every alias a single DNS label (<63).
export const syncHost = (environmentId: string) =>
  `t3-${NodeCrypto.createHash("sha256").update(environmentId).digest("hex").slice(0, 56)}`;

export function frame(kind: number, payload: Uint8Array = Buffer.alloc(0)) {
  if (payload.byteLength > MAX_PAYLOAD) throw new Error("Relay frame too large");
  const bytes = Buffer.allocUnsafe(5 + payload.byteLength);
  bytes[0] = kind;
  bytes.writeUInt32BE(payload.byteLength, 1);
  bytes.set(payload, 5);
  return bytes;
}

/** Incremental parsing keeps only a partial frame, including under fragmented TCP delivery. */
export class FrameReader {
  private pending = Buffer.alloc(0);
  *push(chunk: Buffer): Generator<{ kind: number; payload: Buffer }> {
    let bytes = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    while (bytes.length >= 5) {
      const size = bytes.readUInt32BE(1);
      if (size > MAX_PAYLOAD) throw new Error("Relay frame too large");
      if (bytes.length < size + 5) break;
      yield { kind: bytes[0]!, payload: bytes.subarray(5, size + 5) };
      bytes = bytes.subarray(size + 5);
    }
    this.pending = Buffer.from(bytes);
  }
}
