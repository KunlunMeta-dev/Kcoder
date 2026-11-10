import { afterEach, describe, expect, it, vi } from "vitest";
import { initLocale, t } from "@/i18n";
import {
  exchangeMobileSession,
  GatewaySessionExpiredError,
  getServerStatusSnapshot,
  gatewayRequest,
  installGatewayAuthorizationDenialRecorder,
  listServerStatuses,
  listServers,
  revokeMobileDevice,
  revokeMobileSession,
} from "./http";
import { GatewayHttpError, gatewayHttpErrorPresentation } from "./http-errors";
import type { GatewayAuthorizationDenialWitness, GatewayProfile } from "./types";
import { ProfileCoordinator } from "@/state/profile-coordinator";

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
  removeDenialRecorder?.();
  removeDenialRecorder = undefined;
});

let removeDenialRecorder: (() => void) | undefined;

describe("Gateway HTTP session", () => {
  it("passes the caller cancellation signal through the normal server-list read", async () => {
    const controller = new AbortController();
    let dispatched!: () => void;
    const ready = new Promise<void>(resolve => { dispatched = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("http://gateway.test/api/servers");
      expect(init?.signal).toBe(controller.signal);
      dispatched();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("caller cancelled")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = listServers(profile, { signal: controller.signal });
    const result = expect(request).rejects.toThrow("caller cancelled");
    await ready; controller.abort(); await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps Gateway package, app-server and RPC protocol versions attributed to their exact status fields", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://gateway.test/api/servers/status");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-token");
      return new Response(JSON.stringify({
        gatewayRuntimeVersion: "0.4.0",
        statuses: [{ id: "isolated", status: "online", checkedAt: 123,
          appServerVersion: "1.2.3", protocolVersion: "2026-07-27",
          serverInfo: { version: "must-not-be-used" }, token: "must-not-be-forwarded" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getServerStatusSnapshot(profile)).resolves.toEqual({
      gatewayRuntimeVersion: "0.4.0",
      statuses: [{ id: "isolated", status: "online", checkedAt: 123,
        appServerVersion: "1.2.3", protocolVersion: "2026-07-27" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats missing or malformed version sources as unavailable and keeps old status errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      statuses: [{ id: "isolated", status: "offline", checkedAt: 456,
        error: "target unavailable", appServerVersion: "bad version", protocolVersion: "bad/protocol" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(getServerStatusSnapshot(profile)).resolves.toEqual({
      gatewayRuntimeVersion: null,
      statuses: [{ id: "isolated", status: "offline", checkedAt: 456,
        error: "target unavailable", appServerVersion: null, protocolVersion: null }],
    });
  });

  it("remains compatible with an older Gateway status response that has no version fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      statuses: [{ id: "legacy", status: "offline", error: "old Gateway error" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(listServerStatuses(profile)).resolves.toEqual([{
      id: "legacy", status: "offline", error: "old Gateway error",
      appServerVersion: null, protocolVersion: null,
    }]);
  });

  it("把服务端提前撤销的 401 标记为需要重新授权", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

    await expect(gatewayRequest(profile, "/api/servers")).rejects.toBeInstanceOf(
      GatewaySessionExpiredError,
    );
  });

  it("does not classify a deferred 401 for a stale access grant as current session expiry", async () => {
    const current: GatewayProfile = {
      ...profile,
      accessToken: "review-access-t1",
      refreshToken: "review-refresh-t1",
      authMode: "device",
      deviceId: "review-device",
      authorizationGeneration: "review-generation",
    };
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [current], activeId: current.id });
    let resolveResponse!: (response: Response) => void;
    let requestSent!: () => void;
    const response = new Promise<Response>(resolve => { resolveResponse = resolve; });
    const sent = new Promise<void>(resolve => { requestSent = resolve; });
    const recordDenial = vi.fn((witness: GatewayAuthorizationDenialWitness) => coordinator.recordAuthorizationDenial(witness, async () => {}));
    removeDenialRecorder = installGatewayAuthorizationDenialRecorder(recordDenial, witness => coordinator.isCurrentAuthorizationDenial(witness));
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer review-access-t1");
      requestSent();
      return response;
    }));

    const request = gatewayRequest(current, "/api/servers");
    await sent;
    await coordinator.updateCredentials(
      { ...current },
      { ...current, accessToken: "review-access-t2", refreshToken: "review-refresh-t2", expiresAt: Date.now() + 120_000 },
      async () => {},
    );
    resolveResponse(new Response("", { status: 401 }));

    const outcome = await request.then(
      () => ({ expired: false, rejected: false }),
      error => ({ expired: error instanceof GatewaySessionExpiredError, rejected: true }),
    );
    expect(outcome).toEqual({ expired: false, rejected: true });
    expect(current.accessToken).toBe("review-access-t2");
    expect(current).not.toHaveProperty("reauthorizationRequiredScope");
    expect(recordDenial).not.toHaveBeenCalled();
  });

  it("cancels a held HTTP response when the authorization mode changes", async () => {
    const current: GatewayProfile = {
      ...profile,
      authMode: "device",
      deviceId: "review-device",
      authorizationGeneration: "review-generation",
    };
    let resolveResponse!: (response: Response) => void;
    let requestSent!: () => void;
    const response = new Promise<Response>(resolve => { resolveResponse = resolve; });
    const sent = new Promise<void>(resolve => { requestSent = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => { requestSent(); return response; }));

    const request = gatewayRequest(current, "/api/servers");
    await sent;
    current.authMode = "legacy";
    resolveResponse(new Response(null, { status: 204 }));

    await expect(request).rejects.toThrow("授权范围已改变");
  });

  it("does not apply a held self-device revoke response to a replacement generation", async () => {
    const current: GatewayProfile = {
      ...profile,
      authMode: "device",
      deviceId: "review-device",
      authorizationGeneration: "generation-before-replacement",
    };
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [current], activeId: current.id });
    const recordDenial = vi.fn((witness: GatewayAuthorizationDenialWitness) => coordinator.recordAuthorizationDenial(witness, async () => {}));
    removeDenialRecorder = installGatewayAuthorizationDenialRecorder(recordDenial, witness => coordinator.isCurrentAuthorizationDenial(witness));
    let resolveResponse!: (response: Response) => void;
    let requestSent!: () => void;
    const response = new Promise<Response>(resolve => { resolveResponse = resolve; });
    const sent = new Promise<void>(resolve => { requestSent = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => { requestSent(); return response; }));

    const request = revokeMobileDevice(current, current.deviceId!);
    await sent;
    current.authorizationGeneration = "generation-after-replacement";
    resolveResponse(new Response(null, { status: 204 }));

    await expect(request).rejects.toThrow("授权范围已改变");
    expect(recordDenial).not.toHaveBeenCalled();
    expect(current).not.toHaveProperty("reauthorizationRequiredScope");
  });

  it("denies the current grant before the profile-index persistence promise settles", async () => {
    const current: GatewayProfile = {
      ...profile,
      accessToken: "review-terminal-access",
      refreshToken: "review-terminal-refresh",
      authMode: "device",
      deviceId: "review-device",
      authorizationGeneration: "review-generation",
    };
    const coordinator = new ProfileCoordinator();
    coordinator.hydrate({ profiles: [current], activeId: current.id });
    let finishPersist!: () => void;
    let persistStarted!: () => void;
    const persistWait = new Promise<void>(resolve => { finishPersist = resolve; });
    const started = new Promise<void>(resolve => { persistStarted = resolve; });
    removeDenialRecorder = installGatewayAuthorizationDenialRecorder(
      witness => coordinator.recordAuthorizationDenial(witness, async () => { persistStarted(); await persistWait; }),
      witness => coordinator.isCurrentAuthorizationDenial(witness),
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

    const request = gatewayRequest(current, "/api/servers");
    await started;
    expect(coordinator.isAuthorizationDenied(current)).toBe(true);
    finishPersist();
    await expect(request).rejects.toBeInstanceOf(GatewaySessionExpiredError);
    expect(current.reauthorizationRequiredScope).toBe(JSON.stringify([
      current.id, current.baseUrl, current.authMode, current.authorizationGeneration, current.deviceId,
    ]));
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
    ).rejects.toMatchObject({
      name: "GatewayHttpError",
      status: 401,
      category: "authentication",
      detail: "访问令牌不正确。",
    });
  });

  it.each([
    { status: 404, body: "<html><h1>Not found</h1><p>https://relay.invalid/g/private?token=secret</p></html>", type: "text/html", category: "not_found", messageKey: "connect.http_address_not_found" },
    { status: 404, body: "", type: "application/json", category: "not_found", messageKey: "connect.http_address_not_found" },
    { status: 502, body: "", type: "text/html", category: "gateway_unavailable", messageKey: "connect.http_gateway_unavailable" },
  ])("classifies non-JSON or empty HTTP $status responses without exposing their body", async ({ status, body, type, category, messageKey }) => {
    initLocale("en");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status,
      statusText: "",
      headers: { "content-type": type },
    })));

    const error = await exchangeMobileSession("https://gateway.test", "pairing-token").then(
      () => undefined,
      value => value,
    );

    expect(error).toBeInstanceOf(GatewayHttpError);
    expect(error).toMatchObject({ status, category });
    expect((error as Error).message).toBe(t(messageKey));
    expect((error as Error).message).not.toContain(String(status));
    expect((error as Error).message).not.toContain("Not found");
    expect((error as Error).message).not.toContain("relay.invalid");
    expect((error as Error).message).not.toContain("secret");
  });

  it("keeps a useful JSON rejection visible alongside localized recovery guidance and status", async () => {
    initLocale("en");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Device limit reached" }), {
      status: 403,
      statusText: "",
      headers: { "content-type": "application/json" },
    })));

    const error = await exchangeMobileSession("https://gateway.test", "pairing-token").then(
      () => undefined,
      value => value,
    );
    expect(error).toBeInstanceOf(GatewayHttpError);
    expect(error).toMatchObject({ status: 403, category: "authentication", detail: "Device limit reached" });
    expect((error as Error).message).toBe(`Device limit reached — ${t("connect.http_authentication_failed")}`);
    expect(gatewayHttpErrorPresentation(error)).toEqual({
      categoryKey: "connect.http_authentication_failed",
      status: 403,
      detail: "Device limit reached",
    });
  });

  it.each(["caller cancellation", "request timeout"] as const)("preserves %s while reading a non-success response body", async outcome => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let bodyRead!: () => void;
    const reading = new Promise<void>(resolve => { bodyRead = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestSignal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          bodyRead();
          requestSignal?.addEventListener("abort", () => {
            stream.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, { once: true });
        },
      });
      return new Response(body, { status: 404, headers: { "content-type": "application/json" } });
    }));

    const connection = exchangeMobileSession(
      "https://gateway.test",
      "pairing-token",
      undefined,
      outcome === "caller cancellation" ? caller.signal : undefined,
    );
    const rejected = expect(connection).rejects.toThrow(
      outcome === "caller cancellation"
        ? "Gateway 连接已取消"
        : "无法访问 Gateway，请检查地址、网络和防火墙设置",
    );
    await reading;
    if (outcome === "caller cancellation") caller.abort();
    else await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  }, 10_000);

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
    await vi.waitFor(() => expect(signal).toBeDefined());
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
