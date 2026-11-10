import { describe, expect, it, vi } from "vitest";
import { startWorkspaceBrowserSession, type WorkspaceBrowserClient } from "./browser-preflight";

type TestRequest = (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

function client(
  capabilities: Record<string, boolean>,
  request: TestRequest = vi.fn(async () => ({ session_id: "session-1" })),
): WorkspaceBrowserClient {
  return {
    getCapabilities: () => ({ experimental: capabilities }),
    request: request as unknown as WorkspaceBrowserClient["request"],
  };
}

const copy = {
  capabilityUnsupported: "browser sessions unsupported",
  preflightMethodUnsupported: "preflight unavailable",
  preflightUnavailable: "preflight reported unavailable",
  preflightWarning: (reason: string) => `readiness unconfirmed: ${reason}`,
  sessionIdMissing: "session id missing",
};

describe("workspace browser preflight", () => {
  it("blocks targets without browser session capability without sending a browser RPC", async () => {
    const request = vi.fn();
    await expect(startWorkspaceBrowserSession(client({}, request), "https://example.com", { width: 390, height: 640 }, copy))
      .rejects.toThrow("browser sessions unsupported");
    expect(request).not.toHaveBeenCalled();
  });

  it("runs preflight before one start and sends the caller viewport on the same client", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ available: true })
      .mockResolvedValueOnce({ session_id: "owned-session" });
    const rpc = client({ browserSessions: true, browserPreflight: true }, request);

    await expect(startWorkspaceBrowserSession(rpc, "https://example.com/path", { width: 428, height: 701 }, copy))
      .resolves.toEqual({ sessionId: "owned-session", preflightWarning: null });
    expect(request.mock.calls).toEqual([
      ["browser/preflight", {}],
      ["browser/start", { url: "https://example.com/path", width: 428, height: 701 }, 30_000],
    ]);
  });

  it("does not start when preflight reports unavailable", async () => {
    const request = vi.fn().mockResolvedValue({ available: false, reason: "Chromium missing" });
    await expect(startWorkspaceBrowserSession(
      client({ browserSessions: true, browserPreflight: true }, request),
      "https://example.com",
      { width: 390, height: 640 },
      copy,
    )).rejects.toThrow("Chromium missing");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("browser/preflight", {});
  });

  it("allows a manual start with a warning when preflight is absent or fails", async () => {
    const withoutPreflight = vi.fn().mockResolvedValue({ session_id: "session-1" });
    await expect(startWorkspaceBrowserSession(
      client({ browserSessions: true }, withoutPreflight),
      "https://example.com",
      { width: 390, height: 640 },
      copy,
    )).resolves.toEqual({ sessionId: "session-1", preflightWarning: "preflight unavailable" });

    const failedPreflight = vi.fn()
      .mockRejectedValueOnce(new Error("preflight RPC unsupported"))
      .mockResolvedValueOnce({ session_id: "session-2" });
    await expect(startWorkspaceBrowserSession(
      client({ browserSessions: true, browserPreflight: true }, failedPreflight),
      "https://example.com",
      { width: 390, height: 640 },
      copy,
    )).resolves.toEqual({ sessionId: "session-2", preflightWarning: "readiness unconfirmed: preflight RPC unsupported" });
    expect(failedPreflight).toHaveBeenCalledTimes(2);
  });

  it("reports a missing session id after preflight without hiding the failure", async () => {
    const request = vi.fn().mockResolvedValueOnce({ available: true }).mockResolvedValueOnce({});
    await expect(startWorkspaceBrowserSession(
      client({ browserSessions: true, browserPreflight: true }, request),
      "https://example.com",
      { width: 390, height: 640 },
      copy,
    )).rejects.toThrow("session id missing");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
