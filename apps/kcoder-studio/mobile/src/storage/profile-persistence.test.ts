import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { beforeEach, expect, it, vi } from "vitest";
import { loadProfiles, migrateLegacyWebProfiles, persistProfiles, PROFILE_INDEX_KEY, LEGACY_WEB_PROFILE_KEY, profileStoreTestHelpers } from "./profile-store";
import { setSecureValue, deleteSecureValue } from "./secure";
const values=vi.hoisted(()=>new Map<string,string>());
vi.mock("./secure",()=>({getSecureValue:vi.fn(async(key:string)=>values.get(key)??null),setSecureValue:vi.fn(async(key:string,value:string)=>{values.set(key,value)}),deleteSecureValue:vi.fn(async(key:string)=>{values.delete(key)})}));
const a={id:"a",label:"A",baseUrl:"https://a.example",accessToken:"token-a",rpcToken:"rpc-a",expiresAt:1000};
const b={...a,id:"b",label:"B",baseUrl:"https://b.example",accessToken:"token-b",rpcToken:"rpc-b"};
beforeEach(()=>{installBrowserProfileFixture([]);values.clear();vi.clearAllMocks();vi.mocked(setSecureValue).mockImplementation(async(key,value)=>{values.set(key,value)});vi.mocked(deleteSecureValue).mockImplementation(async key=>{values.delete(key)})});
it("preserves the previously committed credentials if index persistence fails",async()=>{
 await persistProfiles([a],a.id);
 vi.mocked(setSecureValue).mockImplementation(async(key,value)=>{if(key===PROFILE_INDEX_KEY)throw Error("storage full");values.set(key,value)});
 await expect(persistProfiles([b],b.id)).rejects.toThrow("storage full");
 expect((await loadProfiles()).profiles).toEqual([a]);
});

it("credential rotation cannot overwrite the old credential before index commit",async()=>{
 await persistProfiles([a],a.id);
 vi.mocked(setSecureValue).mockImplementation(async(key,value)=>{if(key===PROFILE_INDEX_KEY)throw Error("locked");values.set(key,value)});
 await expect(persistProfiles([{...a,accessToken:"new-token"}],a.id)).rejects.toThrow();
 expect((await loadProfiles()).profiles[0].accessToken).toBe("token-a");
});
it("cleanup failure after commit does not report the committed profile as failed",async()=>{
 await persistProfiles([a],a.id);
 vi.mocked(deleteSecureValue).mockRejectedValue(new Error("cleanup unavailable"));
 await expect(persistProfiles([b],b.id)).resolves.toBeUndefined();
 expect((await loadProfiles()).profiles).toEqual([b]);
});
it("one malformed legacy secret does not erase other profiles",async()=>{
 const metadata=[a,b].map(({accessToken,rpcToken,...profile})=>profile);
 values.set(PROFILE_INDEX_KEY,JSON.stringify({profiles:metadata,activeId:"a"}));
 values.set(profileStoreTestHelpers.profileSecretKey("a"),"{");
 values.set(profileStoreTestHelpers.profileSecretKey("b"),JSON.stringify({accessToken:b.accessToken,rpcToken:b.rpcToken}));
 const restored=await loadProfiles();
 expect(restored.profiles.find(p=>p.id==='b')).toEqual(b);
 expect(restored.profiles.find(p=>p.id==='a')).toMatchObject({baseUrl:a.baseUrl,expiresAt:0,accessToken:''});
});
it("preserves an explicit null activeId for saved but unactivated profiles",async()=>{
 await persistProfiles([a],null);
 expect(JSON.parse(values.get(PROFILE_INDEX_KEY)!).activeId).toBeNull();
 await expect(loadProfiles()).resolves.toMatchObject({profiles:[a],activeId:null});
});
it("falls back to the first profile for an absent or invalid legacy activeId",async()=>{
 await persistProfiles([a],a.id);
 const index=JSON.parse(values.get(PROFILE_INDEX_KEY)!);
 delete index.activeId;
 values.set(PROFILE_INDEX_KEY,JSON.stringify(index));
 await expect(loadProfiles()).resolves.toMatchObject({activeId:"a"});
 values.set(PROFILE_INDEX_KEY,JSON.stringify({...index,activeId:"missing"}));
 await expect(loadProfiles()).resolves.toMatchObject({activeId:"a"});
});
it("preserves explicit null activeId while migrating the legacy Web profile index",async()=>{
 values.set(LEGACY_WEB_PROFILE_KEY,JSON.stringify({profiles:[a],activeId:null}));
 await expect(migrateLegacyWebProfiles()).resolves.toMatchObject({profiles:[a],activeId:null});
 await expect(loadProfiles()).resolves.toMatchObject({profiles:[a],activeId:null});
});
it("persists same-origin Gateway routes with independent profile ids and credentials",async()=>{
 const gatewayA={...a,id:"relay-a",label:"Relay A",baseUrl:"https://relay.example/g/a",accessToken:"access-a",rpcToken:"rpc-a"};
 const gatewayB={...a,id:"relay-b",label:"Relay B",baseUrl:"https://relay.example/g/b",accessToken:"access-b",rpcToken:"rpc-b"};
 await persistProfiles([gatewayA,gatewayB],gatewayB.id);

 const restored=await loadProfiles();
 expect(restored.profiles).toEqual([gatewayA,gatewayB]);
 expect(restored.activeId).toBe(gatewayB.id);
 const index=JSON.parse(values.get(PROFILE_INDEX_KEY)!);
 expect(index.profiles.map((profile:{id:string;baseUrl:string})=>[profile.id,profile.baseUrl])).toEqual([
  [gatewayA.id,gatewayA.baseUrl],
  [gatewayB.id,gatewayB.baseUrl],
 ]);
 expect(index.profiles[0].secretKey).not.toBe(index.profiles[1].secretKey);
});

beforeEach(() => installBrowserProfileFixture([]));
