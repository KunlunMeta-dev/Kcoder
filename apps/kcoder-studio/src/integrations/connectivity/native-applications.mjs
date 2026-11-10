import { randomUUID } from 'node:crypto';
import { scopeKey } from '../../../../kcoder-channel-host/src/validation.mjs';
import { requireValue,ChannelError } from '../../../../kcoder-channel-host/src/errors.mjs';

function selector(connection){
  requireValue(['tencent_docs','agent_mail','feishu_bitable'].includes(connection?.kind),'APPLICATION_UNSUPPORTED');
  const name=connection.configuration?.mcpServerName,pluginId=connection.configuration?.pluginId;
  requireValue(typeof name==='string'&&name.length>0&&name.length<=256&&(pluginId===undefined||pluginId===null||typeof pluginId==='string'),'APPLICATION_SOURCE_NOT_CONFIGURED','repair_configuration');
  return {name,...(typeof pluginId==='string'?{pluginId}:{})};
}
function bindingKey(scope,connection){return JSON.stringify([scopeKey(scope),connection.id,connection.revision,selector(connection)]);}

/** Reuse the existing native MCP management/OAuth path; it owns every token and callback. */
export function createNativeApplicationProvider({getHostContext,requestPlugin,evaluateAction,readResources,now=()=>Date.now()}){
  requireValue(typeof getHostContext==='function'&&typeof requestPlugin==='function'&&typeof evaluateAction==='function','APPLICATION_HOST_PROVIDER_REQUIRED');
  const pending=new Map();
  async function context(scope){const current=await getHostContext();requireValue(current?.scope&&typeof current.nativeConnectionId==='string'&&scopeKey(current.scope)===scopeKey(scope),'APPLICATION_SCOPE_CHANGED','request_authorization');return {...current,scope:{...current.scope}};}
  async function authorize(scope,action,connection){
    const current=await context(scope);
    const policy=await evaluateAction(current,{action,resources:[{connectionId:connection.id,revision:connection.revision,source:selector(connection)}]});
    requireValue(policy?.status==='completed'&&policy?.result?.decision==='allow','APPLICATION_ACCESS_DENIED','request_authorization');return current;
  }
  async function call(current,method,params){
    const result=await requestPlugin(current,method,params);
    const latest=await context(current.scope);requireValue(latest.nativeConnectionId===current.nativeConnectionId,'APPLICATION_SCOPE_CHANGED','request_authorization');return result;
  }
  async function read(scope,connection){
    const current=await authorize(scope,'application.readConnection',connection),source=selector(connection);
    const result=await call(current,'mcp/list',{});
    const matches=(result?.servers??[]).filter(server=>server.name===source.name&&(server.pluginId??null)===(source.pluginId??null));
    requireValue(matches.length===1,'APPLICATION_SOURCE_UNAVAILABLE','repair_configuration');
    const server=matches[0];
    return {source,enabled:server.enabled!==false,authorization:server.authorization??'unavailable',lastConnectionAttempt:server.lastConnectionAttempt??null,lastConnectionFailure:server.lastConnectionFailure??null};
  }
  async function listSources(scope){
    const current=await context(scope),policy=await evaluateAction(current,{action:'application.listSources',resources:[]});requireValue(policy?.status==='completed'&&policy.result?.decision==='allow','APPLICATION_ACCESS_DENIED','request_authorization');
    const result=await call(current,'mcp/list',{});requireValue(Array.isArray(result?.servers),'APPLICATION_NATIVE_RECEIPT_INVALID');
    return {items:result.servers.slice(0,200).map(server=>({name:server.name,pluginId:server.pluginId??null,enabled:server.enabled!==false,authorization:server.authorization??'unavailable'})),truncated:result.servers.length>200};
  }
  async function setEnabled(scope,connection,enabled){
    requireValue(typeof enabled==='boolean','INVALID_ENABLED_STATE');
    const current=await authorize(scope,'application.setEnabled',connection);await read(scope,connection);
    const result=await call(current,'mcp/setEnabled',{...selector(connection),enabled});
    requireValue(result?.name===selector(connection).name&&result.enabled===enabled&&typeof result.appliesToNewConversations==='boolean','APPLICATION_NATIVE_RECEIPT_INVALID','reconcile_original');
    return result;
  }
  async function cancelEntry(value){
    value.cancelled=true;
    if(value.flowId)await requestPlugin(value.context,'mcp/cancel',{flowId:value.flowId});
  }
  async function authorizeConnection(scope,connection,operationId){
    const current=await authorize(scope,'application.authorize',connection);const key=bindingKey(scope,connection);
    for(const [id,value]of pending)if(value.expiresAt<=now()){pending.delete(id);await cancelEntry(value).catch(()=>{});}
    const previous=[...pending.values()].find(value=>value.key===key&&value.operationId===operationId);
    if(previous){if(previous.result)return previous.result;throw new ChannelError('APPLICATION_AUTHORIZATION_UNCONFIRMED','reconcile_original');}
    requireValue(pending.size<16,'APPLICATION_AUTHORIZATION_CAPACITY');
    const id=randomUUID(),value={id,key,operationId,context:current,scope:scopeKey(scope),connectionId:connection.id,connectionRevision:connection.revision,cancelled:false,expiresAt:now()+10*60*1000,flowId:null};pending.set(id,value);
    try{
      const result=await requestPlugin(current,'gateway/mcp/login',{server:selector(connection)});
      requireValue(typeof result?.flowId==='string'&&typeof result.authorizationUrl==='string','APPLICATION_AUTHORIZATION_RECEIPT_INVALID','reconcile_original');value.flowId=result.flowId;
      const latest=await context(scope);requireValue(latest.nativeConnectionId===current.nativeConnectionId,'APPLICATION_SCOPE_CHANGED','request_authorization');
      if(value.cancelled){await call(current,'mcp/cancel',{flowId:value.flowId}).catch(()=>{});throw new ChannelError('APPLICATION_AUTHORIZATION_CANCELLED');}
      const url=new URL(result.authorizationUrl);requireValue(url.protocol==='https:'&&!url.username&&!url.password,'APPLICATION_AUTHORIZATION_URL_INVALID');
      value.result={authorizationId:id,state:'waiting',authorizationUrl:url.href,expiresAt:new Date(value.expiresAt).toISOString()};return value.result;
    }catch(error){if(value.flowId&&!value.cancelled)await cancelEntry(value).catch(()=>{});throw error;}
  }
  async function cancelAuthorization(scope,connection,authorizationId,authorizationOperationId){
    await authorize(scope,'application.cancelAuthorization',connection);const value=authorizationId?pending.get(authorizationId):[...pending.values()].find(item=>item.scope===scopeKey(scope)&&item.connectionId===connection.id&&item.operationId===authorizationOperationId);
    requireValue(value&&value.scope===scopeKey(scope)&&value.connectionId===connection.id&&value.connectionRevision===connection.revision,'APPLICATION_AUTHORIZATION_NOT_FOUND');
    await cancelEntry(value);pending.delete(value.id);return {authorizationId:value.id,state:'cancelled'};
  }
  async function disconnect(scope,connection){
    const current=await authorize(scope,'application.disconnect',connection);
    for(const [id,value]of pending)if(value.scope===scopeKey(scope)&&value.connectionId===connection.id){await cancelEntry(value);pending.delete(id);}
    const result=await call(current,'mcp/logout',selector(connection));requireValue(result?.loggedOut===true,'APPLICATION_LOGOUT_UNCONFIRMED','reconcile_original');return {loggedOut:true,localCredentialsRemoved:true,providerRevocationRequested:false};
  }
  async function listResources(scope,connection,payload){
    const current=await authorize(scope,'application.listResources',connection);const status=await read(scope,connection);
    requireValue(status.enabled&&['authorized','configuredHeader','notApplicable'].includes(status.authorization),'APPLICATION_AUTHORIZATION_REQUIRED','request_authorization');
    requireValue(typeof readResources==='function','APPLICATION_RESOURCE_PROVIDER_UNAVAILABLE','repair_configuration');
    const result=await readResources(current,{connection,source:selector(connection),after:payload?.after??null,limit:Math.min(payload?.limit??10,10)});
    await context(scope);requireValue(Array.isArray(result?.items)&&result.items.length<=10,'APPLICATION_RESOURCE_RECEIPT_INVALID');return result;
  }
  return {read,listSources,setEnabled,authorize:authorizeConnection,cancelAuthorization,disconnect,listResources,async close(){const values=[...pending.values()];pending.clear();await Promise.allSettled(values.map(cancelEntry));}};
}
