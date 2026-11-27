import { createInterface } from "node:readline";
import { closeSync } from "node:fs";

// Local protocol fixture only: it never starts SSH, Windows tools, or network listeners.
const [mode, value = ""] = process.argv.slice(2);
if (mode === "output") {
  process.stdout.end(value);
} else if (mode === "exit") {
  process.exit(23);
} else if (mode === "signal") {
  process.kill(process.pid, "SIGTERM");
} else if (mode === "output-limit") {
  setInterval(() => {}, 1000);
  process.stdout.write("x".repeat(2 * 1024 * 1024 + 65536));
} else if (mode === "closed-stdin") {
  setInterval(() => {}, 1000);
  closeSync(0);
  process.stdout.write("stdin-closed\n");
} else if (mode === "hold") {
  setInterval(() => {}, 1000);
} else if (mode === "forward") {
  setInterval(() => {}, 1000);
  process.stderr.write("Allocated port 49777 for remote forward\n");
} else if (mode === "controller") {
  setInterval(() => {}, 1000);
  const reader = createInterface({ input: process.stdin });
  const reply = (request, result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  process.stdout.write(JSON.stringify({ ready: true }) + "\n");
  reader.on("line", line => {
    const request = JSON.parse(line);
    if (request.action === "verify_binary") { reply(request, { sha256: request.sha256, bytes: 16 }); return; }
    if (request.action === "cleanup") {
      process.stdout.write(JSON.stringify({ id: request.id, result: { cleaned: true } }) + "\n", () => process.exit(0));
      return;
    }
    const fault = request.settings?.transportFault;
    if (fault === "defer") return;
    if (fault === "exit") { process.exit(23); return; }
    if (fault === "signal") { process.kill(process.pid, "SIGTERM"); return; }
    if (fault === "invalid-json") { process.stdout.write("invalid-json\n"); return; }
    if (fault === "output-close") { process.stdout.end(); return; }
    if (fault === "closed-stdin") {
      reader.close();
      process.stdin.pause();
      closeSync(0);
      reply(request, { armed: true });
      return;
    }
    reply(request, { configured: true });
  });
} else {
  throw new Error("Unsupported local transport fixture mode");
}
