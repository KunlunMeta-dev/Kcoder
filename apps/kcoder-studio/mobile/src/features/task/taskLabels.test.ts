import { MobileRpcError } from "@/gateway/rpc";
import { t } from "@/i18n";
import { describe, expect, it } from "vitest";
import { taskOpenError } from "./taskLabels";

const otherClient = () => t("task.this_task_is_running_in_another_client_stop");

describe("taskOpenError", () => {
  it.each([
    "thread is already active in another Gateway client",
    "session is already active in another app-server: /var/lib/kcoder/session.lock",
  ])("maps the confirmed cross-client ownership error: %s", message => {
    expect(taskOpenError(new MobileRpcError(message, -32023, "remote"))).toBe(otherClient());
  });

  it.each([
    "permission denied while checking the session lease at /workspace/.kcoder/session.lock",
    "failed to open session lease /workspace/.kcoder/session.lock: permission denied",
    "release of the session lease failed: lock owner changed",
    "temporary thread belongs to another Gateway client",
    "resource belongs to another Gateway client",
    "Acceptance recovery owner changed",
    "Project pin reconciliation failed after owner changed",
    "ordinary task resume failure",
  ])("preserves unrelated error semantics: %s", message => {
    expect(taskOpenError(new MobileRpcError(message, -32023, "remote"))).toBe(message);
  });

  it("keeps the existing Gateway authentication recovery message", () => {
    expect(taskOpenError(new MobileRpcError("Gateway authentication failed", 401, "remote")))
      .toBe(t("task.the_gateway_session_has_expired_reconnect_in_settings"));
  });
});
