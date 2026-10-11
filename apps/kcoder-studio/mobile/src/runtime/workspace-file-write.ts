import { MobileRpcError } from "@/gateway/rpc";
import type { JsonRecord } from "@/gateway/rpc";

type FileIdentity = { parent: string; name: string; revision: string };
function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/**
 * CAS identifies a conditional desired-state write by path/base revision/content.
 * A lost ACK is reconciled with one complete disk read; this proves the desired
 * state at that revision, not which writer produced it or that the RPC was ACKed.
 * No write is replayed, and callers must reject late results after editor changes.
 */
export async function writeWorkspaceFileVerified(task: { request<T>(method: string, params: JsonRecord): Promise<T> }, file: FileIdentity, content: string): Promise<Record<string, unknown>> {
  try {
    const result = await task.request<{ stdout?: unknown }>("device/execute", {
      command_key: "workspace_write_text_file", path: file.parent,
      args: [file.name, file.revision], stdin: content, max_output_bytes: 1_048_576,
    });
    const output = fields(result.stdout);
    if (typeof output.revision === "string" && output.revision) return output;
    throw new MobileRpcError("文件写入确认无效", -1, "protocol");
  } catch (error) {
    if (!(error instanceof MobileRpcError) || error.reason === "remote" || error.delivery === "not-sent") throw error;
    try {
      const result = await task.request<{ stdout?: unknown }>("device/execute", {
        command_key: "workspace_read_text_file", path: file.parent, args: [file.name], max_output_bytes: 1_048_576,
      });
      const output = fields(result.stdout);
      if (output.truncated === false && output.editable === true && output.content === content && typeof output.revision === "string" && output.revision)
        return output;
      throw new Error("磁盘内容与本次编辑不一致，草稿已保留；请读回核对后再保存。");
    } catch (readError) {
      throw new Error(`保存结果待核对，草稿已保留：${readError instanceof Error ? readError.message : String(readError)}`);
    }
  }
}
