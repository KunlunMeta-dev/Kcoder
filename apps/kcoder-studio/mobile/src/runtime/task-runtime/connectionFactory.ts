import { GatewayRpcClient } from "@/gateway/rpc";
import { clearScopedReadCaches } from "../scoped-read-cache";
import { fileChangesFromValue } from "./normalizers";
import { type TaskClientConnector } from "./types";

export let taskClientConnector: TaskClientConnector = GatewayRpcClient.connect;

export const outgoingMessageNamespace = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

export let outgoingMessageSequence = 0;

export const taskRuntimeTestHelpers = {
  fileChangesFromValue,
  setConnector(connector: TaskClientConnector): void {
    taskClientConnector = connector;
  },
  resetConnector(): void {
    clearScopedReadCaches();
    taskClientConnector = GatewayRpcClient.connect;
  },
};

export function nextOutgoingMessageSequence() {
  return ++outgoingMessageSequence;
}
