import type { RemoteOperationControlMethod, RemoteOperationControlParams, RemoteOperationControlReply } from '../generated/contracts.integrations-remotes.js';
export function isRemoteOperationControlMethod(value: unknown): value is RemoteOperationControlMethod;
export function isRemoteOperationControlParams(value: unknown): value is RemoteOperationControlParams;
export function isRemoteOperationControlReply(value: unknown): value is RemoteOperationControlReply;
import type { RemoteOperationListParams, RemoteOperationListReply } from '../generated/contracts.integrations-remotes.js';
export function isRemoteOperationListParams(value: unknown): value is RemoteOperationListParams;
export function isRemoteOperationListReply(value: unknown): value is RemoteOperationListReply;
