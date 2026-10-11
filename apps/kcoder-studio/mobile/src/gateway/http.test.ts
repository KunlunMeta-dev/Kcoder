import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeMobileSession,
  GatewaySessionExpiredError,
  gatewayRequest,
  revokeMobileSession,
} from "./http";
import type { GatewayProfile } from "./types";

const profile: GatewayProfile = {
  id: "gateway",
  label: "Gateway",
  baseUrl: "http://gateway.test",
  accessToken: "session-token",
  expiresAt: Date.now() + 60_000,
  rpcToken: "rpc",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Gateway HTTP session", () => {
  it("把服务端提前撤销的 401 标记为需要重新授权", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

    await expect(gatewayRequest(profile, "/api/servers")).rejects.toBeInstanceOf(
      GatewaySessionExpiredError,
    );
  });

  it("服务端接受登录请求后一直不响应时仍会在有限时间内结束连接尝试", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: RequestInit) => {
        const requestSignal = init?.signal ?? undefined;
        signal = requestSignal;
        if (!requestSignal)
          return Promise.reject(new Error("fetch missing AbortSignal"));
        return new Promise<Response>((_resolve, reject) => {
          requestSignal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
      }),
    );

    const connection = exchangeMobileSession(
      "https://gateway.test",
      "access-token",
    );
    const outcome = connection.then(
      () => ({ kind: "resolved" as const }),
      (error) => ({
        kind: "rejected" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    await Promise.resolve();
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(outcome).resolves.toEqual({
      kind: "rejected",
      message: "无法访问 Gateway，请检查地址、网络和防火墙设置",
    });
    expect(signal?.aborted).toBe(true);
  }, 10_000);

  it("成功响应头之后挂起的响应体也受同一请求期限约束", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: RequestInit) => {
        const requestSignal = init?.signal ?? undefined;
        signal = requestSignal;
        return Promise.resolve({
          ok: true,
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              if (!requestSignal) {
                reject(new Error("fetch missing AbortSignal"));
                return;
              }
              requestSignal.addEventListener(
                "abort",
                () =>
                  reject(
                    Object.assign(new Error("aborted"), {
                      name: "AbortError",
                    }),
                  ),
                { once: true },
              );
            }),
        } as Response);
      }),
    );

    const connection = exchangeMobileSession(
      "https://gateway.test",
      "access-token",
    );
    const outcome = connection.then(
      () => ({ kind: "resolved" as const }),
      (error) => ({
        kind: "rejected" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    await Promise.resolve();
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(outcome).resolves.toEqual({
      kind: "rejected",
      message: "无法访问 Gateway，请检查地址、网络和防火墙设置",
    });
    expect(signal?.aborted).toBe(true);
  }, 10_000);

  it("路由取消信号会中止移动会话交换", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        }),
      ),
    );
    const connection = exchangeMobileSession(
      "https://gateway.test",
      "access-token",
      undefined,
      controller.signal,
    );
    controller.abort();
    await expect(connection).rejects.toThrow("Gateway 连接已取消");
  });

  it("保留普通网络失败和 Gateway 登录 401 的错误语义", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(
      exchangeMobileSession("https://gateway.test", "access-token"),
    ).rejects.toThrow("无法访问 Gateway，请检查地址、网络和防火墙设置");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "访问令牌不正确。" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(
      exchangeMobileSession("https://gateway.test", "wrong-token"),
    ).rejects.toThrow("连接失败：访问令牌不正确。");
  });

  it("撤销会话遇到不响应的 Gateway 时会在五秒后中止请求", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: RequestInit) => {
        const requestSignal = init?.signal ?? undefined;
        signal = requestSignal;
        if (!requestSignal)
          return Promise.reject(new Error("fetch missing AbortSignal"));
        return new Promise<Response>((_resolve, reject) => {
          requestSignal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
      }),
    );

    const revocation = revokeMobileSession(profile);
    const rejected = expect(revocation).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }, 10_000);

  it("成功撤销和 401 响应都会清理撤销期限", async () => {
    vi.useFakeTimers();
    let successSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      successSignal = init?.signal;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await revokeMobileSession(profile);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gateway.test/api/mobile/session",
      expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) }),
    );
    expect(successSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    fetchMock.mockImplementationOnce(async () => new Response("", { status: 401 }));
    await expect(revokeMobileSession(profile)).rejects.toBeInstanceOf(
      GatewaySessionExpiredError,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("同域不同 Gateway 路由分别交换会话并保留各自的 HTTP 路径和令牌", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const requests: Array<{ url: string; token: string | null; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : "";
        requests.push({
          url,
          token: new Headers(init?.headers).get("authorization"),
          body,
        });
        if (url.endsWith("/api/mobile/session")) {
          const pairing = JSON.parse(body) as { token: string };
          return new Response(
            JSON.stringify({
              accessToken: `access-${pairing.token}`,
              rpcToken: `rpc-${pairing.token}`,
              expiresAt: 9_999_999_999_999,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ servers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const gatewayA = await exchangeMobileSession(
      "https://relay.example/g/a",
      "pair-a",
    );
    const gatewayB = await exchangeMobileSession(
      "https://relay.example/g/b",
      "pair-b",
    );
    await gatewayRequest(gatewayA, "/api/servers");
    await gatewayRequest(gatewayB, "/api/servers");

    expect(gatewayA.id).not.toBe(gatewayB.id);
    expect(gatewayA.label).toBe("Gateway a");
    expect(gatewayB.label).toBe("Gateway b");
    expect(gatewayA.baseUrl).toBe("https://relay.example/g/a");
    expect(gatewayB.baseUrl).toBe("https://relay.example/g/b");
    expect(gatewayA.accessToken).toBe("access-pair-a");
    expect(gatewayB.accessToken).toBe("access-pair-b");
    expect(gatewayA.rpcToken).toBe("rpc-pair-a");
    expect(gatewayB.rpcToken).toBe("rpc-pair-b");
    expect(requests.map(({ url }) => url)).toEqual([
      "https://relay.example/g/a/api/mobile/session",
      "https://relay.example/g/b/api/mobile/session",
      "https://relay.example/g/a/api/servers",
      "https://relay.example/g/b/api/servers",
    ]);
    expect(requests.slice(2).map(({ token }) => token)).toEqual([
      "Bearer access-pair-a",
      "Bearer access-pair-b",
    ]);
  });

  it("直连 Gateway 的默认名称仍显示 host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            accessToken: "access",
            rpcToken: "rpc",
            expiresAt: 9_999_999_999_999,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const directGateway = await exchangeMobileSession(
      "https://gateway.example:8443",
      "pair-token",
    );

    expect(directGateway.label).toBe("gateway.example:8443");
  });
});
