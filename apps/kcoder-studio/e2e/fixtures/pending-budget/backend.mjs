import { createInterface } from "node:readline";
import { writeFile, unlink } from "node:fs/promises";
const held = [];
let released = false;
const resources = () => ({ processId: process.pid, instanceId: "owned-lifecycle", residentBytes: process.memoryUsage().rss, memorySource: "linux-vmrss", includesChildren: false });
const resource = process.argv[2];
const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === "attachment/delete") {
    await unlink(message.params.path);
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "fixture/cleaned", params: {} })}\n`,
    );
    return;
  }
  if (message.method === "server/resources/read" && released) { reply(message.id, resources()); return; }
  if (message.params?.control === "release") {
    released = true;
    for (const pending of held.splice(0)) {
      if (pending.method === "attachment/save") {
        await writeFile(resource, "owned late resource");
        reply(pending.id, { path: resource });
      } else reply(pending.id, pending.method === "server/resources/read" ? resources() : { healthy: true });
    }
    reply(message.id, { released: true });
    return;
  }
  if (message.params?.control === "healthy") {
    reply(message.id, { healthy: true });
    return;
  }
  held.push({ id: message.id, method: message.method });
});
if (process.argv[3] === "pause") {
  process.stdin.pause();
  setTimeout(() => process.stdin.resume(), 700);
}
