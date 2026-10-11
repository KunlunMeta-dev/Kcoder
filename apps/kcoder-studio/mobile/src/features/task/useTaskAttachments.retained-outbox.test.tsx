// Actual attachment hook, Composer, store, uploader, codec, profile fence and RPC.
// Effect-aware hook-host/serial Blob manifest/controlled socket; not mounted React,
// IndexedDB cross-tab, native filesystem, real Gateway or accepted-turn proof.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { useState, type ReactNode } from "react";
import type { AttachmentBytesBackend, AttachmentStoreChange } from "@/storage/staged-attachment-bytes";
import type { StagedAttachmentRecord } from "@/storage/staged-attachment-store";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
vi.hoisted(() => { Object.defineProperty(globalThis, "__DEV__", { value: false, configurable: true }); });
const fixture = vi.hoisted(() => ({ backend: null as AttachmentBytesBackend | null, host: {
  states: [] as unknown[], setters: [] as Array<((value: unknown) => void) | undefined>, refs: [] as Array<{current: unknown}>,
  memos: [] as Array<{value: unknown; deps: unknown[]} | undefined>, effects: [] as Array<{deps: unknown[]; cleanup?: () => void} | undefined>,
  pendingEffects: [] as Array<{index: number; effect: () => void | (() => void); deps: unknown[]; changed: boolean}>,
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
}}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = fixture.host.stateIndex++;
      if (!(index in fixture.host.states)) fixture.host.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      fixture.host.setters[index] ??= (update: unknown) => {
        fixture.host.states[index] = typeof update === "function" ? (update as (previous: unknown) => unknown)(fixture.host.states[index]) : update;
      };
      return [fixture.host.states[index], fixture.host.setters[index]];
    },
    useRef: (initial: unknown) => {
      const index = fixture.host.refIndex++;
      return fixture.host.refs[index] ??= { current: initial };
    },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const index = fixture.host.memoIndex++;
      const old = fixture.host.memos[index];
      if (old && deps.length === old.deps.length && deps.every((value, i) => Object.is(value, old.deps[i]))) return old.value;
      const value = factory(); fixture.host.memos[index] = { value, deps }; return value;
    },
    useCallback: (callback: (...args: any[]) => unknown, deps: unknown[]) => {
      const index = fixture.host.memoIndex++;
      const old = fixture.host.memos[index];
      if (old && deps.length === old.deps.length && deps.every((value, i) => Object.is(value, old.deps[i]))) return old.value;
      fixture.host.memos[index] = { value: callback, deps }; return callback;
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[] = []) => {
      const index = fixture.host.effectIndex++;
      const old = fixture.host.effects[index];
      const changed = !old || deps.length !== old.deps.length || !deps.every((value, i) => Object.is(value, old.deps[i]));
      fixture.host.pendingEffects.push({ index, effect, deps, changed });
    },
  };
});


vi.mock("react-native", () => ({ Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) }, Platform: { OS: "web" }, StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFillObject: {} }, ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View" }));
// Type-only named imports can preserve an empty runtime import under verbatimModuleSyntax.
// The actual hook uses only our explicit task stub; unrelated runtime/Expo entry is outside this contract.
vi.mock("@/runtime/task-runtime", () => ({}));
vi.mock("expo-sharing", () => ({ shareAsync: vi.fn(), isAvailableAsync: vi.fn(async () => false) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({top:0,bottom:0,left:0,right:0}) }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-image-manipulator", () => ({ manipulateAsync: vi.fn(), SaveFormat: { JPEG: "jpeg" } }));
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("expo-file-system/legacy", () => ({ EncodingType: { Base64: "base64" }, readAsStringAsync: vi.fn() }));
vi.mock("@/features/task/TaskAttachments", () => ({ StagedAttachmentChip: "StagedAttachmentChip" }));
vi.mock("lucide-react-native", () => ({ ArrowUp: "ArrowUp", Paperclip: "Paperclip", Square: "Square", X: "X" }));
vi.mock("@/features/task/attachmentPreparation", async importOriginal => ({ ...(await importOriginal<typeof import("@/features/task/attachmentPreparation")>()), webBlobBase64: async (blob: Blob) => Buffer.from(await blob.arrayBuffer()).toString("base64") }));
vi.mock("@/storage/staged-attachment-bytes.web", () => ({ createAttachmentBytesBackend: () => fixture.backend! }));
vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: async () => {} }));
import { GatewayRpcClient } from "@/gateway/rpc";
import { RETENTION_CAPABILITY } from "@/protocol/attachment-retention";
import { StagedAttachmentStore } from "@/storage/staged-attachment-store";
import { useTaskAttachments } from "@/features/task/useTaskAttachments";
import { TaskComposer } from "@/features/task/TaskComposer";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup(element: ReactNode): string };
const admission = { version: 1 as const, rootNamespace: "ui_review", admissionEpoch: 7 };
const profile: GatewayProfile = { id: "ui", label: "fixture", baseUrl: "https://fixture.invalid", accessToken: "synthetic", rpcToken: "synthetic", expiresAt: 9e12, authorizationGeneration: "auth-a", deviceId: "device-a" };
const server: KCoderServer = { id: "target", label: "fixture", description: "fixture", runtime: "kcoder", transport: "local", workspacePath: "/workspace" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return {promise, resolve}; }
class Manifest implements AttachmentBytesBackend {
 readonly kind = "web" as const; failRead = false; rows = new Map<string, StagedAttachmentRecord>(); bytes = new Map<string, Blob>(); tail = Promise.resolve();
 async transaction<T>(change: (rows: readonly unknown[]) => AttachmentStoreChange<T>): Promise<T> {
  const previous = this.tail; const hold = deferred<void>(); this.tail = hold.promise; await previous;
  try { if(this.failRead) throw new Error("controlled manifest read failure"); const c = change([...this.rows.values()].map(x => structuredClone(x)));
   for (const item of [...(c.putRows ?? []), ...(c.putRow ? [c.putRow] : [])]) this.rows.set(item.id, structuredClone(item.value) as StagedAttachmentRecord);
   if(c.putBytes) this.bytes.set(c.putBytes.id,c.putBytes.blob); if(c.deleteBytes) this.bytes.delete(c.deleteBytes); return c.value;
  } finally {hold.resolve();}
 }
 async source(id: string, size: number) { const blob=this.bytes.get(id); if(!blob||blob.size!==size) throw new Error("source missing"); return {size, async read(offset: number,length:number){return new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer());}}; }
}
type Frame = {id: number; method: string; params: Record<string, unknown>};
class Peer {
 cap = true; malformed = false; lost = false; frames: Frame[] = []; result: unknown; atSend?: () => void;
 send(socket: Socket, frame: Frame) {
  if(frame.method==="initialized") return;
  if(frame.method==="initialize") {queueMicrotask(()=>socket.reply(frame.id,{protocolVersion:frame.params.protocolVersion,capabilities:{experimental:{[RETENTION_CAPABILITY]:this.cap}},attachmentUploadAdmission:this.malformed?{}:admission}));return;}
  this.frames.push(frame); this.atSend?.();
  if(frame.method==="attachment/retention/upload/save") {
   const row=[...(fixture.backend as Manifest).rows.values()][0]!;
   this.result={clientOwnerRequestId:row.ownerRequest.clientOwnerRequestId,clientUploadId:row.clientUploadId,scopeId:"a".repeat(64),lookup:{outcome:"present",filename:row.filename,size:row.size,contentSha256:row.contentSha256,recovery:{...{rootNamespace:admission.rootNamespace,epoch:admission.admissionEpoch},state:"sealed",confirmedBytes:row.size,stageRef:{rootNamespace:admission.rootNamespace,epoch:7,ownerId:"owner",entryId:"entry",revision:1}}}};
  }
  if(this.lost){this.lost=false;queueMicrotask(()=>socket.error(frame.id));}else queueMicrotask(()=>socket.reply(frame.id,this.result));
 }
}
class Socket {
 static readonly OPEN=1; static peer: Peer; readyState=1;
 onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;
 constructor(){queueMicrotask(()=>this.onopen?.());} send(raw:string){Socket.peer.send(this,JSON.parse(raw) as Frame);}
 reply(id:number,result:unknown){this.onmessage?.({data:JSON.stringify({jsonrpc:"2.0",id,result})});}
 error(id:number){this.onmessage?.({data:JSON.stringify({jsonrpc:"2.0",id,error:{code:-32000,message:"controlled missing ACK"}})});}
 close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.();}
}
const clients: GatewayRpcClient[]=[];
function resetHost(){Object.assign(fixture.host,{states:[],setters:[],refs:[],memos:[],effects:[],pendingEffects:[],stateIndex:0,refIndex:0,memoIndex:0,effectIndex:0});}
function cleanup(){for(const e of fixture.host.effects)e?.cleanup?.();}
function render(context: Parameters<typeof useTaskAttachments>[0], effects=true){
 Object.assign(fixture.host,{stateIndex:0,refIndex:0,memoIndex:0,effectIndex:0,pendingEffects:[]});const [attachmentLoading,setAttachmentLoading]=useState(false); const [attachmentError,setAttachmentError]=useState<string|null>(null); const model=useTaskAttachments({...context,attachmentLoading,setAttachmentLoading,attachmentError,setAttachmentError});
 if(effects) for(const e of fixture.host.pendingEffects){if(!e.changed)continue;fixture.host.effects[e.index]?.cleanup?.();fixture.host.effects[e.index]={deps:e.deps,cleanup:e.effect()||undefined};}return model;
}
async function settle(){for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));}
beforeEach(()=>{resetHost();fixture.backend=new Manifest();installBrowserProfileFixture([profile]);});
afterEach(()=>{cleanup();for(const c of clients.splice(0))c.close();vi.unstubAllGlobals();});
async function setup(cap=true,malformed=false){const peer=new Peer();peer.cap=cap;peer.malformed=malformed;Socket.peer=peer;vi.stubGlobal("WebSocket",Socket as unknown as typeof WebSocket);const client=await GatewayRpcClient.connect({...profile},{...server},"/workspace");clients.push(client);
 const legacy:Frame[]=[];const attached:unknown[]=[];
 const context={profile:{...profile},server:{...server},snapshot:{cwd:"/workspace",threadId:"thread-a",connected:true},task:{client,isDisposed:()=>false,request:async(method:string,params:Record<string,unknown>)=>{legacy.push({id:0,method,params});return{path:"/legacy/file.bin"};}},demo:false,attachments:[],setAttachments:(update:(items:unknown[])=>unknown[])=>attached.push(...update([])),mountedRef:{current:true},setAttachmentSheet:vi.fn(),setAttachmentLoading:vi.fn(),attachmentBatchRunning:{current:false},setAttachmentError:vi.fn()} as unknown as Parameters<typeof useTaskAttachments>[0];
 return{context,peer,legacy,attached,backend:fixture.backend as Manifest};}
const asset=()=>({uri:"blob:fixture",name:"file.bin",mimeType:"application/octet-stream",blob:new Blob(["bytes"]),size:5});
it.each([{cap:false,malformed:false}])("keeps actual legacy upload for unavailable negotiated admission ($cap/$malformed)",async({cap,malformed})=>{const f=await setup(cap,malformed);const model=render(f.context);await model.stageOne(asset(),0);expect(f.legacy.map(x=>x.method)).toEqual(["attachment/save"]);expect(f.backend.rows.size).toBe(0);expect(f.attached).toHaveLength(1);});
it("actual picker flow checkpoints bytes and composer before RPC and renders recovery without legacy paths",async()=>{const f=await setup();let model=render(f.context);f.peer.atSend=()=>{const row=[...f.backend.rows.values()][0]!;expect(row.composer).toEqual({threadId:"thread-a",mimeType:"application/octet-stream"});expect(row.wire?.method).toBe("attachment/retention/upload/save");expect(f.backend.bytes.has(row.id)).toBe(true);};await model.stageOne(asset(),0);await settle();model=render(f.context);expect(model.retainedOutbox.rows).toHaveLength(1);expect(model.retainedOutbox.rows[0]!.phase).toBe("sealed");expect(f.legacy).toHaveLength(0);expect(f.attached).toHaveLength(0);const markup=renderToStaticMarkup(<TaskComposer model={{...model,failedSubmissions:[],snapshot:f.context.snapshot,input:"",canSend:false} as unknown as Parameters<typeof TaskComposer>[0]["model"]}/>);expect(markup.match(/(?:data-testid|testID)="retained-attachment-row"/g)).toHaveLength(1);});
it("lost upload ACK survives hook restart and only reads the original u1",async()=>{const f=await setup();f.peer.lost=true;let model=render(f.context);await expect(model.stageOne(asset(),0)).rejects.toThrow();const before=[...f.backend.rows.values()][0]!;expect(before.wire).toBeDefined();cleanup();resetHost();model=render(f.context);await settle();model=render(f.context);expect(model.retainedOutbox.rows[0]!.id).toBe(before.id);await model.retainedOutbox.resume(before.id);expect(f.peer.frames.map(x=>x.method)).toEqual(["attachment/retention/upload/save","attachment/retention/upload/read"]);expect(f.peer.frames.every(x=>x.params.clientUploadId===before.clientUploadId)).toBe(true);expect(f.backend.rows.size).toBe(1);expect(f.backend.bytes.has(before.id)).toBe(true);});
it("held picker cannot dispatch or publish into another thread before effects flush",async()=>{const f=await setup();const held=deferred<ReturnType<typeof asset>[]>();let model=render(f.context);const selection=model.runAttachmentSelection(()=>held.promise);const changed={...f.context,snapshot:{...f.context.snapshot,threadId:"thread-b"}};model=render(changed,false);expect(model.retainedOutbox.rows).toHaveLength(0);held.resolve([asset()]);await selection;expect(f.peer.frames).toHaveLength(0);expect(f.backend.rows.size).toBe(0);expect(f.context.setAttachmentError).not.toHaveBeenCalledWith(expect.any(String));});
it("same target raw-root switch synchronously hides old rows and rejects old action",async()=>{const f=await setup();let model=render(f.context);await model.stageOne(asset(),0);model=render(f.context);const old=model.retainedOutbox;const changed={...f.context,server:{...f.context.server!,workspacePath:"/other"}};model=render(changed,false);expect(model.retainedOutbox.rows).toEqual([]);await expect(old.resume([...f.backend.rows.keys()][0]!)).rejects.toThrow();expect(f.peer.frames).toHaveLength(1);});
it("composer thread and MIME are immutable and foreign-thread consumer bind cannot commit",async()=>{const f=await setup();const model=render(f.context);await model.stageOne(asset(),0);const row=[...f.backend.rows.values()][0]!;const store=new StagedAttachmentStore(f.backend);const scope={profile,server,workspacePath:"/workspace",isCurrent:()=>true};await expect(store.update(scope,row,x=>({...x,composer:{threadId:"other",mimeType:"text/plain"}}))).rejects.toThrow();await expect(store.prepareConsumerBatch(scope,[row],"other","message")).rejects.toThrow();expect(f.backend.rows.get(row.id)).toEqual(row);});
it("an unsent durable source is discoverable after restart and explicit UI discard sends zero RPC",async()=>{const f=await setup();const store=new StagedAttachmentStore(f.backend);const blob=asset().blob;const row=await store.prepare({profile,server,workspacePath:"/workspace",isCurrent:()=>true},admission,"file.bin",{size:blob.size,blob,async read(offset,length){return new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer());}},undefined,{threadId:"thread-a",mimeType:"application/octet-stream"});let model=render(f.context);await settle();model=render(f.context);expect(model.retainedOutbox.rows.map(x=>x.id)).toEqual([row.id]);await model.retainedOutbox.discard(row.id);expect(f.backend.bytes.size).toBe(0);expect(f.peer.frames).toHaveLength(0);expect(f.backend.rows.get(row.id)?.cleanup).toBe("finished");});

it("advertised retention with malformed admission fails closed without legacy upload",async()=>{const f=await setup(true,true);const model=render(f.context);await expect(model.stageOne(asset(),0)).rejects.toThrow();expect(f.legacy).toHaveLength(0);expect(f.peer.frames).toHaveLength(0);expect(f.backend.rows.size).toBe(0);});

it("empty manifest read failure is visible in actual Composer rather than no attachments",async()=>{const f=await setup();f.backend.failRead=true;render(f.context);await settle();const model=render(f.context);expect(model.retainedOutbox.rows).toEqual([]);expect(model.retainedOutbox.error).toContain("无法核对");const markup=renderToStaticMarkup(<TaskComposer model={{...model,failedSubmissions:[],input:"",canSend:false} as unknown as Parameters<typeof TaskComposer>[0]["model"]}/>);expect(markup.match(/(?:data-testid|testID)="retained-attachment-error"/g)).toHaveLength(1);});
it("owner switch clears A loading and late A cannot release the actual B loading state",async()=>{const f=await setup();const a=deferred<ReturnType<typeof asset>[]>();let model=render(f.context);const aPromise=model.runAttachmentSelection(()=>a.promise);model=render(f.context);expect(model.attachmentLoading).toBe(true);const bContext={...f.context,snapshot:{...f.context.snapshot,threadId:"thread-b"}};model=render(bContext);model=render(bContext);expect(model.attachmentLoading).toBe(false);expect(f.context.attachmentBatchRunning.current).toBe(false);const b=deferred<ReturnType<typeof asset>[]>();const bPromise=model.runAttachmentSelection(()=>b.promise);model=render(bContext);expect(model.attachmentLoading).toBe(true);a.resolve([asset()]);await aPromise;model=render(bContext);expect(model.attachmentLoading).toBe(true);expect(f.context.attachmentBatchRunning.current).toBe(true);expect(f.peer.frames).toHaveLength(0);expect(f.backend.rows.size).toBe(0);b.resolve([]);await bPromise;model=render(bContext);expect(model.attachmentLoading).toBe(false);expect(f.context.attachmentBatchRunning.current).toBe(false);});
it("actual file picker handles malformed admission visibly without opening picker or falling back",async()=>{const f=await setup(true,true);let model=render(f.context);await expect(model.pickFile()).resolves.toBeUndefined();model=render(f.context);expect(model.attachmentError).toContain("附件状态尚未核对");expect(model.attachmentLoading).toBe(false);expect(f.legacy).toHaveLength(0);expect(f.peer.frames).toHaveLength(0);expect(f.backend.rows.size).toBe(0);});
