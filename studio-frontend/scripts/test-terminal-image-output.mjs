import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({
  root,
  configFile: join(root, "vite.config.ts"),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

try {
  const { TerminalImageSizeNormalizer, createTerminalImageOutputNormalizer } = await vite.ssrLoadModule(
    "/src/components/studio/terminal-image-output.ts",
  );

  const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const piSequence = `\x1b]1337;File=inline=1;width=10;name=dGlueQ==:${payload}\x07`;
  const expected = `\x1b]1337;File=size=68;inline=1;width=10;name=dGlueQ==:${payload}\x07`;

  assert.equal(
    createTerminalImageOutputNormalizer(true),
    null,
    "tmux terminals must bypass image normalization",
  );
  assert.equal(
    createTerminalImageOutputNormalizer(undefined),
    null,
    "the default tmux backend must bypass image normalization",
  );
  assert.ok(
    createTerminalImageOutputNormalizer(false) instanceof TerminalImageSizeNormalizer,
    "plain PTY terminals must enable Pi image compatibility",
  );

  const complete = new TerminalImageSizeNormalizer();
  assert.equal(
    decoder.decode(concat(complete.push(`before${piSequence}after`))),
    `before${expected}after`,
    "Pi images without size must gain the decoded byte length",
  );

  const split = new TerminalImageSizeNormalizer();
  const splitOutput = [];
  for (const byte of encoder.encode(`前${piSequence}后`)) {
    splitOutput.push(...split.push(new Uint8Array([byte])));
  }
  assert.equal(
    decoder.decode(concat(splitOutput)),
    `前${expected}后`,
    "normalization must survive arbitrary WebSocket chunk boundaries",
  );

  const existingSize = `\x1b]1337;File=inline=1;size=68:${payload}\x07`;
  const compliant = new TerminalImageSizeNormalizer();
  assert.equal(
    decoder.decode(concat(compliant.push(existingSize))),
    existingSize,
    "compliant IIP sequences must remain byte-for-byte unchanged",
  );

  const compliantStreaming = new TerminalImageSizeNormalizer();
  const compliantHeader = "\x1b]1337;File=inline=1;size=68:";
  assert.equal(
    decoder.decode(concat(compliantStreaming.push(compliantHeader))),
    compliantHeader,
    "a compliant image header must stream immediately without buffering its payload",
  );
  assert.equal(
    decoder.decode(concat(compliantStreaming.push(`${payload}\x07tail`))),
    `${payload}\x07tail`,
    "a compliant image payload and following terminal text must keep streaming",
  );

  const stringTerminated = new TerminalImageSizeNormalizer();
  const stSequence = `\x1b]1337;File=inline=1:${payload}\x1b\\`;
  assert.equal(
    decoder.decode(concat(stringTerminated.push(stSequence))),
    `\x1b]1337;File=size=68;inline=1:${payload}\x1b\\`,
    "OSC sequences terminated with ST must also be normalized",
  );

  const splitStringTerminator = new TerminalImageSizeNormalizer();
  const splitStOutput = [
    ...splitStringTerminator.push(`\x1b]1337;File=inline=1:${payload}\x1b`),
    ...splitStringTerminator.push("\\tail"),
  ];
  assert.equal(
    decoder.decode(concat(splitStOutput)),
    `\x1b]1337;File=size=68;inline=1:${payload}\x1b\\tail`,
    "ST must be recognized when ESC and backslash arrive in separate frames",
  );

  const c1Terminated = new TerminalImageSizeNormalizer();
  const c1Prefix = encoder.encode(`\x1b]1337;File=inline=1:${payload}`);
  const c1Input = concat([c1Prefix, new Uint8Array([0x9c]), encoder.encode("tail")]);
  const c1Expected = concat([
    encoder.encode(`\x1b]1337;File=size=68;inline=1:${payload}`),
    new Uint8Array([0x9c]),
    encoder.encode("tail"),
  ]);
  assert.deepEqual(
    concat(c1Terminated.push(c1Input)),
    c1Expected,
    "the single-byte C1 ST terminator must not leave terminal output buffered",
  );

  const malformed = `\x1b]1337;File=inline=1:not-base64!\x07`;
  const malformedStream = new TerminalImageSizeNormalizer();
  assert.equal(
    decoder.decode(concat(malformedStream.push(malformed))),
    malformed,
    "malformed payloads must pass through for xterm to reject",
  );

  const ordinary = "\x1b[31m普通 ANSI 输出\x1b[0m\r\n\x1b]0;title\x07";
  const ordinaryStream = new TerminalImageSizeNormalizer();
  assert.equal(
    decoder.decode(concat(ordinaryStream.push(ordinary))),
    ordinary,
    "ordinary terminal output must remain unchanged",
  );

  const multiple = new TerminalImageSizeNormalizer();
  assert.equal(
    decoder.decode(concat(multiple.push(`${piSequence}between${piSequence}`))),
    `${expected}between${expected}`,
    "multiple images in one WebSocket frame must each be normalized",
  );

  const resetStream = new TerminalImageSizeNormalizer();
  assert.deepEqual(
    resetStream.push("\x1b]1337;File=inline=1:AAAA"),
    [],
    "an incomplete image must wait for its terminator",
  );
  resetStream.reset();
  assert.equal(
    decoder.decode(concat(resetStream.push("after reconnect"))),
    "after reconnect",
    "reset must discard an incomplete image before a reconnect",
  );

  const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const largePayload = base64Alphabet.repeat((1024 * 1024) / base64Alphabet.length);
  const largeSequence = encoder.encode(`\x1b]1337;File=inline=1:${largePayload}\x07`);
  const largeExpected = encoder.encode(`\x1b]1337;File=size=786432;inline=1:${largePayload}\x07`);
  const largeStream = new TerminalImageSizeNormalizer();
  const largeOutput = [];
  for (let offset = 0; offset < largeSequence.length; offset += 64 * 1024) {
    largeOutput.push(...largeStream.push(largeSequence.subarray(offset, offset + 64 * 1024)));
  }
  assert.deepEqual(
    concat(largeOutput),
    largeExpected,
    "large chunked images must preserve every payload byte while gaining size",
  );

  const oversizedStream = new TerminalImageSizeNormalizer();
  const oversizedPrefix = encoder.encode("\x1b]1337;File=inline=1:");
  const oversizedPayloadChunk = encoder.encode(base64Alphabet.repeat((1024 * 1024) / base64Alphabet.length));
  const oversizedFirstChunk = concat([oversizedPrefix, oversizedPayloadChunk]);
  const oversizedTail = encoder.encode("\x07after oversized image");
  const expectedHash = createHash("sha256");
  const actualHash = createHash("sha256");
  let flushedOversized = false;
  for (let index = 0; index < 49; index += 1) {
    const input = index === 0 ? oversizedFirstChunk : oversizedPayloadChunk;
    expectedHash.update(input);
    const emitted = oversizedStream.push(input);
    if (emitted.length > 0) flushedOversized = true;
    for (const chunk of emitted) actualHash.update(chunk);
  }
  expectedHash.update(oversizedTail);
  for (const chunk of oversizedStream.push(oversizedTail)) actualHash.update(chunk);
  assert.equal(flushedOversized, true, "an unterminated image must flush after the 48 MiB safety limit");
  assert.equal(
    actualHash.digest("hex"),
    expectedHash.digest("hex"),
    "oversized fallback must preserve the entire sequence and trailing text byte-for-byte",
  );

  console.log("terminal image output tests: PASS");
} finally {
  await vite.close();
}
