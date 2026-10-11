// Owned Gateway-only fault injection. Writes still commit; only their UI receipts
// are held. Page-read failures never replay a committed mutation.
import { Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function decodeUiReceiptFrame(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 2 ||
    bytes[0] !== 0x81 ||
    bytes[1] & 0x80
  )
    return null;
  let length = bytes[1] & 127,
    offset = 2;
  if (length === 126) {
    if (bytes.length < 4) return null;
    length = bytes.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (bytes.length < 10) return null;
    const wide = bytes.readBigUInt64BE(2);
    if (wide > 2097152n) return null;
    length = Number(wide);
    offset = 10;
  }
  if (bytes.length !== offset + length) return null;
  try {
    return JSON.parse(bytes.subarray(offset).toString("utf8"));
  } catch {
    return null;
  }
}

export function encodeUiReceiptFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x81;
  header[1] = body.length < 126 ? body.length : 126;
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

export function uiReceiptMatches(mode, result) {
  if (mode === "file-kind") {
    try {
      const directory =
        typeof result?.stdout === "string"
          ? JSON.parse(result.stdout)
          : result?.stdout;
      return (
        /(?:^|[\\/])nav-a$/.test(directory?.path ?? "") &&
        directory.entries?.some((entry) =>
          /(?:^|[\\/])owned-nav-A\.ts$/.test(entry.path),
        )
      );
    } catch {
      return false;
    }
  }
  if (mode === "node-save")
    return result?.nodes?.some((node) => node.prompt === "OWNED_SUBMITTED");
  if (mode === "page-A") return result?.draft?.title === "Owned A";
  if (mode === "citation") return result?.source?.title === "Owned source";
  if (mode === "node-timeout")
    return result?.nodes?.some((node) => node.prompt === "OWNED_TIMEOUT");
  if (mode === "citation-timeout")
    return result?.source?.title === "Owned source";
  if (mode === "mobile-rename")
    return result?.thread?.title?.startsWith("Owned mobile receipt");
  if (mode === "edit-read" || mode === "restore-read") return !!result?.draft;
  return false;
}

if (process.env.KCODER_E2E_UI_RECEIPT_FAULT === "1") {
  const directory = process.env.KCODER_E2E_UI_RECEIPT_DIRECTORY;
  const seen = new Set();
  const evidence = {};
  const record = () =>
    writeFileSync(
      join(directory, "ui-receipt-fault.json"),
      JSON.stringify(evidence),
      { mode: 0o600 },
    );
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (event, ...args) {
    if (event === "upgrade" && args[0]?.url?.startsWith("/rpc?")) {
      const socket = args[1],
        write = socket.write;
      const droppedModes = new Set();
      socket.write = function (bytes, ...rest) {
        const frame = decodeUiReceiptFrame(bytes);
        if (frame) {
          for (const dropped of droppedModes) {
            evidence[dropped].followingFrames++;
            record();
          }
        }
        let mode;
        try {
          mode = JSON.parse(
            readFileSync(join(directory, "ui-receipt-plan.json"), "utf8"),
          ).mode;
        } catch {
          /* Not armed. */
        }
        if (
          !frame?.id ||
          frame.error ||
          seen.has(mode) ||
          !uiReceiptMatches(mode, frame.result)
        )
          return write.call(this, bytes, ...rest);
        seen.add(mode);
        if (mode.endsWith("-timeout")) {
          evidence[mode] = {
            dropped: true,
            followingFrames: 0,
            socketClosed: false,
          };
          droppedModes.add(mode);
          socket.once("close", () => {
            evidence[mode].socketClosed = true;
            record();
          });
          record();
          // Permanently drop one genuine result, leaving the healthy socket
          // and every other request/notification untouched.
          return true;
        }
        if (mode.endsWith("-read")) {
          evidence[mode] = { readRejected: true };
          record();
          return write.call(
            this,
            encodeUiReceiptFrame({
              jsonrpc: "2.0",
              id: frame.id,
              error: {
                code: -32000,
                message: "Owned read temporarily unavailable",
              },
            }),
            ...rest,
          );
        }
        evidence[mode] = {
          held: true,
          released: false,
          timedOut: false,
          cancelled: false,
        };
        record();
        const deadline = Date.now() + 15000;
        const cancel = () => {
          clearInterval(timer);
          evidence[mode].cancelled = true;
          record();
        };
        const timer = setInterval(() => {
          const released = existsSync(
            join(directory, `ui-receipt-release-${mode}`),
          );
          if (!released && Date.now() < deadline) return;
          clearInterval(timer);
          socket.off("close", cancel);
          evidence[mode].timedOut = !released;
          if (!socket.destroyed) {
            write.call(socket, bytes, ...rest);
            evidence[mode].released = true;
          }
          record();
        }, 25);
        socket.once("close", cancel);
        return true;
      };
    }
    return emit.call(this, event, ...args);
  };
}
