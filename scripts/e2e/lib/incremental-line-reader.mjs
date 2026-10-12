import { createHash } from "node:crypto";
import fs from "node:fs";

function readSlice(filePath, start, length) {
  return readBufferSlice(filePath, start, length).toString("utf8");
}

function readBufferSlice(filePath, start, length) {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function resolveFileIdentity(stats) {
  if (stats.ino !== 0n) {
    return `${stats.dev}:${stats.ino}`;
  }
  return `birth:${stats.birthtimeNs}`;
}

function readTailFingerprint(filePath, stats, maxReadBytes) {
  const size = Number(stats.size);
  const length = Math.min(size, maxReadBytes);
  const start = Math.max(0, size - length);
  const buffer = readBufferSlice(filePath, start, length);
  const hash = createHash("sha256").update(buffer).digest("base64url");
  return `${start}:${buffer.byteLength}:${hash}`;
}

export function resolvePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createIncrementalLineReader(filePath, options = {}) {
  const maxReadBytes = resolvePositiveInteger(options.maxReadBytes, 256 * 1024);
  let fileIdentity;
  let contentFingerprint;
  let offset = 0;
  let pending = "";

  return {
    readLines() {
      if (!fs.existsSync(filePath)) {
        return { lines: [], reset: false };
      }

      const stats = fs.statSync(filePath, { bigint: true });
      if (!stats.isFile()) {
        return { lines: [], reset: false };
      }
      const size = Number(stats.size);

      let reset = false;
      const nextFileIdentity = resolveFileIdentity(stats);
      if (
        fileIdentity !== undefined &&
        nextFileIdentity !== undefined &&
        fileIdentity !== nextFileIdentity
      ) {
        offset = 0;
        pending = "";
        reset = true;
      }
      fileIdentity = nextFileIdentity;

      if (!reset && size === offset && contentFingerprint !== undefined) {
        const nextContentFingerprint = readTailFingerprint(filePath, stats, maxReadBytes);
        if (contentFingerprint !== nextContentFingerprint) {
          offset = 0;
          pending = "";
          reset = true;
        } else {
          return { lines: [], reset: false };
        }
      }

      if (size < offset) {
        offset = 0;
        pending = "";
        reset = true;
      }
      if (size === offset) {
        return { lines: [], reset };
      }

      let start = offset;
      let discardFirstLine = false;
      if (size - start > maxReadBytes) {
        start = size - maxReadBytes;
        pending = "";
        if (start > 0) {
          discardFirstLine = readSlice(filePath, start - 1, 1) !== "\n";
        }
      }

      const text = readSlice(filePath, start, size - start);
      offset = size;
      contentFingerprint = readTailFingerprint(filePath, stats, maxReadBytes);
      if (!text) {
        return { lines: [], reset };
      }

      let chunk = pending + text;
      if (discardFirstLine) {
        const newlineIndex = chunk.indexOf("\n");
        if (newlineIndex === -1) {
          pending = "";
          return { lines: [], reset };
        }
        chunk = chunk.slice(newlineIndex + 1);
      }

      const lines = chunk.split("\n");
      pending = lines.pop() ?? "";
      return { lines, reset };
    },
  };
}
