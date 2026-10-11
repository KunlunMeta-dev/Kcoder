// Model-independent disk revision/transport ambiguity boundary.
import { expect, it, vi } from "vitest";
import { MobileRpcError } from "@/gateway/rpc";
import { writeWorkspaceFileVerified } from "./workspace-file-write";
const file = { parent: "/synthetic", name: "fixture.txt", revision: "before" };
it("reads a committed write after lost ACK and never replays the write", async () => {
  const request = vi.fn().mockRejectedValueOnce(new MobileRpcError("lost ACK")).mockResolvedValueOnce({ stdout: { editable: true, truncated: false, content: "synthetic", revision: "after" } });
  expect(await writeWorkspaceFileVerified({ request } as never, file, "synthetic")).toMatchObject({ revision: "after" });
  expect(request.mock.calls.map((call) => call[1].command_key)).toEqual(["workspace_write_text_file", "workspace_read_text_file"]);
});
it("keeps an unconfirmed changed disk version as unknown instead of declaring saved", async () => {
  const request = vi.fn().mockRejectedValueOnce(new MobileRpcError("lost ACK")).mockResolvedValueOnce({ stdout: { editable: true, truncated: false, content: "newer edit", revision: "after" } });
  await expect(writeWorkspaceFileVerified({ request } as never, file, "synthetic")).rejects.toThrow("保存结果待核对");
  expect(request).toHaveBeenCalledTimes(2);
});
it("propagates explicit CAS rejection without readback or a second write", async () => {
  const request = vi.fn().mockRejectedValue(new MobileRpcError("revision conflict", 409, "remote"));
  await expect(writeWorkspaceFileVerified({ request } as never, file, "synthetic")).rejects.toThrow("revision conflict");
  expect(request).toHaveBeenCalledOnce();
});
