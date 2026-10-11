/** Scoped workspace wire parsing. These values are fences, never caller authority. */
export const WORKSPACE_RECEIPTS_V2 = "workspaceOperationReceiptsV2";
export const WORKSPACE_SCOPE_V2 = "runtime.workspaces.operation/scopeV2";
export const WORKSPACE_READ_V2 = "runtime.workspaces.operation/readV2";
export type WorkspaceMutationMethodV2 = "runtime.workspaces.openV2" | "runtime.workspaces.prepareV2" | "runtime.worktrees.prepareV2";
export interface WorkspaceScopeV2 { version: 2; rootId: string; scopeId: string; familyId: string }
export interface WorkspaceReceiptV2 {
  clientRequestId: string; method: WorkspaceMutationMethodV2; paramsDigest: string;
  status: "ready" | "unknown"; workspacePath: string | null;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工作区回执协议无效；保留原操作 ID");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some(name => !names.includes(name))) throw new Error("工作区回执协议无效；保留原操作 ID");
}
function digest(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
export function workspaceScopeV2(value: unknown): WorkspaceScopeV2 {
  const row = object(value); fields(row, ["version", "rootId", "scopeId", "familyId"]);
  if (row.version !== 2 || !digest(row.rootId) || !digest(row.scopeId) || !digest(row.familyId)) throw new Error("目标未返回有效工作区身份");
  return { version: 2, rootId: row.rootId, scopeId: row.scopeId, familyId: row.familyId };
}
export function sameWorkspaceScopeV2(a: WorkspaceScopeV2, b: WorkspaceScopeV2): boolean { return a.rootId === b.rootId && a.scopeId === b.scopeId && a.familyId === b.familyId; }
export function workspaceReadV2(value: unknown, scope: WorkspaceScopeV2, id: string, method: WorkspaceMutationMethodV2, expectedDigest: string): WorkspaceReceiptV2 | null {
  const row = object(value); fields(row, ["scope", "receipt"]);
  if (!sameWorkspaceScopeV2(workspaceScopeV2(row.scope), scope)) throw new Error("工作区身份已变化；保留原操作 ID");
  if (row.receipt === null) return null;
  const receipt = object(row.receipt); fields(receipt, ["clientRequestId", "method", "paramsDigest", "status", "workspacePath"]);
  if (receipt.clientRequestId !== id || receipt.method !== method || receipt.paramsDigest !== expectedDigest ||
      (receipt.status !== "ready" && receipt.status !== "unknown") ||
      (receipt.status === "ready" ? typeof receipt.workspacePath !== "string" || !receipt.workspacePath.startsWith("/") || receipt.workspacePath.length > 4096 : receipt.workspacePath !== null))
    throw new Error("工作区回执与原操作不匹配；保留原操作 ID");
  return { clientRequestId: id, method, paramsDigest: expectedDigest, status: receipt.status, workspacePath: receipt.workspacePath as string | null };
}
export function workspaceMutationV2(value: unknown, scope: WorkspaceScopeV2, id: string, method: WorkspaceMutationMethodV2, expectedDigest: string): WorkspaceReceiptV2 {
  const row = object(value); fields(row, ["scope", "receipt", "result"]);
  const receipt = workspaceReadV2({ scope: row.scope, receipt: row.receipt }, scope, id, method, expectedDigest);
  const result = object(row.result);
  const mapping = result.mapping === undefined || result.mapping === null ? undefined : object(result.mapping);
  const path = method === "runtime.worktrees.prepareV2" ? result.path : method === "runtime.workspaces.prepareV2" ? mapping?.workspacePath : result.workspacePath;
  if (!receipt || receipt.status !== "ready" || receipt.workspacePath !== path || (method === "runtime.worktrees.prepareV2" && result.success !== true))
    throw new Error("工作区结果尚未确认；保留原操作 ID");
  return receipt;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** SHA-256 of the Rust serde JSON tuple, with sorted object fields. No native dependency. */
export function workspaceParamsDigestV2(method: WorkspaceMutationMethodV2, params: Record<string, unknown>): string {
  const text = JSON.stringify([method, canonical(params)]);
  if (text.length > 16384) throw new Error("工作区操作参数过大；不会派发");
  const bytes: number[] = [];
  for (const character of text) {
    const n = character.codePointAt(0)!;
    if (n < 128) bytes.push(n);
    else if (n < 2048) bytes.push(192 | n >> 6, 128 | n & 63);
    else if (n < 65536) bytes.push(224 | n >> 12, 128 | n >> 6 & 63, 128 | n & 63);
    else bytes.push(240 | n >> 18, 128 | n >> 12 & 63, 128 | n >> 6 & 63, 128 | n & 63);
  }
  const length = bytes.length * 8; bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : length >>> (i * 8) & 255);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (v: number, n: number) => v >>> n | v << (32 - n);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Array<number>(64);
    for (let i = 0; i < 16; i++) w[i] = bytes[offset+i*4] << 24 | bytes[offset+i*4+1] << 16 | bytes[offset+i*4+2] << 8 | bytes[offset+i*4+3];
    for (let i = 16; i < 64; i++) w[i] = (w[i-16] + (rotate(w[i-15],7)^rotate(w[i-15],18)^w[i-15]>>>3) + w[i-7] + (rotate(w[i-2],17)^rotate(w[i-2],19)^w[i-2]>>>10)) | 0;
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) { const t = (j+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0; const u = ((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))|0; j=g;g=f;f=e;e=(d+t)|0;d=c;c=b;b=a;a=(t+u)|0; }
    [a,b,c,d,e,f,g,j].forEach((v,i) => { h[i]=(h[i]+v)|0; });
  }
  return h.map(v => (v>>>0).toString(16).padStart(8,"0")).join("");
}
