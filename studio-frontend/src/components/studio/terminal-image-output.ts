const ITERM_FILE_PREFIX = new TextEncoder().encode("\x1b]1337;File=");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BEL = 0x07;
const ESC = 0x1b;
const C1_ST = 0x9c;
const ST_BACKSLASH = 0x5c;
const COLON = 0x3a;
const MAX_PENDING_BYTES = 48 * 1024 * 1024;

type ImageState = "header" | "payload" | "passthrough" | null;

interface OscTerminator {
  end: number;
  length: number;
}

export class TerminalImageSizeNormalizer {
  private prefixTail = new Uint8Array(0);
  private imageState: ImageState = null;
  private imageChunks: Uint8Array[] = [];
  private imageByteLength = 0;
  private imageTrailingEsc = false;

  push(input: string | Uint8Array): Uint8Array[] {
    const chunk = typeof input === "string" ? encoder.encode(input) : input;
    if (chunk.length === 0) return [];

    const data = this.imageState === null && this.prefixTail.length > 0
      ? concatBytes(this.prefixTail, chunk)
      : chunk;
    this.prefixTail = new Uint8Array(0);

    const output: Uint8Array[] = [];
    let offset = 0;

    while (offset < data.length) {
      if (this.imageState === "passthrough") {
        const terminator = findOscTerminator(data, offset, this.imageTrailingEsc);
        if (!terminator) {
          output.push(data.subarray(offset));
          this.imageTrailingEsc = data[data.length - 1] === ESC;
          break;
        }
        output.push(data.subarray(offset, terminator.end));
        this.clearImageState();
        offset = terminator.end;
        continue;
      }

      if (this.imageState === "header") {
        const colon = indexOfByte(data, COLON, offset, data.length);
        const terminator = findOscTerminator(data, offset, this.imageTrailingEsc);
        if (terminator && (colon < 0 || terminator.end <= colon)) {
          this.appendImageChunk(data.subarray(offset, terminator.end));
          output.push(...this.imageChunks);
          this.clearImageState();
          offset = terminator.end;
          continue;
        }
        if (colon < 0) {
          this.appendImageChunk(data.subarray(offset));
          this.flushOversizedImage(output);
          break;
        }

        this.appendImageChunk(data.subarray(offset, colon + 1));
        if (imageHeaderHasSize(this.imageChunks)) {
          output.push(...this.imageChunks);
          this.imageChunks = [];
          this.imageByteLength = 0;
          this.imageState = "passthrough";
        } else {
          this.imageState = "payload";
        }
        this.imageTrailingEsc = false;
        offset = colon + 1;
        continue;
      }

      if (this.imageState === "payload") {
        const terminator = findOscTerminator(data, offset, this.imageTrailingEsc);
        if (!terminator) {
          this.appendImageChunk(data.subarray(offset));
          this.flushOversizedImage(output);
          break;
        }

        this.appendImageChunk(data.subarray(offset, terminator.end));
        const sequence = concatMany(this.imageChunks);
        output.push(addMissingSize(sequence, terminator.length));
        this.clearImageState();
        offset = terminator.end;
        continue;
      }

      const imageStart = indexOfBytes(data, ITERM_FILE_PREFIX, offset);
      if (imageStart < 0) {
        const retained = partialPrefixLength(data, offset, ITERM_FILE_PREFIX);
        const outputEnd = data.length - retained;
        if (outputEnd > offset) output.push(data.subarray(offset, outputEnd));
        if (retained > 0) this.prefixTail = data.slice(outputEnd);
        break;
      }

      if (imageStart > offset) output.push(data.subarray(offset, imageStart));
      this.imageState = "header";
      offset = imageStart;
    }

    return output;
  }

  reset(): void {
    this.prefixTail = new Uint8Array(0);
    this.clearImageState();
  }

  private appendImageChunk(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.imageChunks.push(chunk);
    this.imageByteLength += chunk.length;
    this.imageTrailingEsc = chunk[chunk.length - 1] === ESC;
  }

  private flushOversizedImage(output: Uint8Array[]): void {
    if (this.imageByteLength <= MAX_PENDING_BYTES) return;
    // Preserve stream progress for malformed or oversized sequences. xterm's
    // own IIP parser and size limits remain the final safety boundary.
    output.push(...this.imageChunks);
    this.clearImageState();
  }

  private clearImageState(): void {
    this.imageState = null;
    this.imageChunks = [];
    this.imageByteLength = 0;
    this.imageTrailingEsc = false;
  }
}

export function createTerminalImageOutputNormalizer(useTmux: boolean | undefined): TerminalImageSizeNormalizer | null {
  return useTmux === false ? new TerminalImageSizeNormalizer() : null;
}

function imageHeaderHasSize(chunks: Uint8Array[]): boolean {
  const headerWithColon = concatMany(chunks);
  const headerStart = ITERM_FILE_PREFIX.length;
  const headerEnd = Math.max(headerStart, headerWithColon.length - 1);
  const header = decoder.decode(headerWithColon.subarray(headerStart, headerEnd));
  return /(?:^|;)size=\d+(?:;|$)/.test(header);
}

function addMissingSize(sequence: Uint8Array, terminatorLength: number): Uint8Array {
  const headerStart = ITERM_FILE_PREFIX.length;
  const sequenceContentEnd = sequence.length - terminatorLength;
  const colon = indexOfByte(sequence, COLON, headerStart, sequenceContentEnd);
  if (colon < 0) return sequence;

  const payload = sequence.subarray(colon + 1, sequenceContentEnd);
  const size = base64DecodedSize(payload);
  if (size === null || size === 0) return sequence;

  return concatMany([
    sequence.subarray(0, headerStart),
    encoder.encode(`size=${size};`),
    sequence.subarray(headerStart),
  ]);
}

function base64DecodedSize(payload: Uint8Array): number | null {
  if (payload.length % 4 === 1) return null;
  let padding = 0;
  if (payload.length > 0 && payload[payload.length - 1] === 0x3d) padding += 1;
  if (payload.length > 1 && payload[payload.length - 2] === 0x3d) padding += 1;

  for (let index = 0; index < payload.length; index += 1) {
    const byte = payload[index];
    const alphaNumeric = (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39);
    if (alphaNumeric || byte === 0x2b || byte === 0x2f) continue;
    if (byte === 0x3d && index >= payload.length - padding) continue;
    return null;
  }

  return Math.floor(payload.length * 3 / 4) - padding;
}

function findOscTerminator(data: Uint8Array, offset: number, previousEsc = false): OscTerminator | null {
  if (previousEsc && data[offset] === ST_BACKSLASH) {
    return { end: offset + 1, length: 2 };
  }
  for (let index = offset; index < data.length; index += 1) {
    if (data[index] === BEL || data[index] === C1_ST) {
      return { end: index + 1, length: 1 };
    }
    if (data[index] === ESC && data[index + 1] === ST_BACKSLASH) {
      return { end: index + 2, length: 2 };
    }
  }
  return null;
}

function partialPrefixLength(data: Uint8Array, offset: number, prefix: Uint8Array): number {
  const available = data.length - offset;
  const maxLength = Math.min(prefix.length - 1, available);
  for (let length = maxLength; length > 0; length -= 1) {
    const start = data.length - length;
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (data[start + index] !== prefix[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

function startsWith(data: Uint8Array, prefix: Uint8Array, offset: number): boolean {
  if (offset + prefix.length > data.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[offset + index] !== prefix[index]) return false;
  }
  return true;
}

function indexOfBytes(data: Uint8Array, needle: Uint8Array, offset: number): number {
  const lastStart = data.length - needle.length;
  for (let index = offset; index <= lastStart; index += 1) {
    if (startsWith(data, needle, index)) return index;
  }
  return -1;
}

function indexOfByte(data: Uint8Array, needle: number, offset: number, end: number): number {
  for (let index = offset; index < end; index += 1) {
    if (data[index] === needle) return index;
  }
  return -1;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

function concatMany(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}
