import channelPlatforms from './channel-platforms.json' with { type: 'json' };
import { requireValue } from './errors.mjs';
import { identifier } from './validation.mjs';

const APPLICATION_CONFIGURATION_SCHEMA=Object.freeze({type:'object',additionalProperties:false,required:['mcpServerName'],properties:{mcpServerName:{type:'string',minLength:1,maxLength:256},pluginId:{anyOf:[{type:'null'},{type:'string',minLength:1,maxLength:256}]}}});
const application=value=>Object.freeze({...value,configurationSchema:APPLICATION_CONFIGURATION_SCHEMA,credentialBoundary:'native_mcp_reference',capabilityEvidence:'catalog_declaration_only'});
export function validateApplicationConfiguration(value){
  requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>['mcpServerName','pluginId'].includes(key)),'INVALID_APPLICATION_CONFIGURATION','repair_configuration');
  identifier(value.mcpServerName,'application_source');
  requireValue(value.pluginId==null||typeof value.pluginId==='string'&&value.pluginId.length>0&&[...value.pluginId].length<=256,'INVALID_APPLICATION_CONFIGURATION','repair_configuration');
  return value;
}

// Platform SDK declarations do not imply end-to-end channel runtime support.
export const CHANNEL_CATALOG = Object.freeze(Object.entries(channelPlatforms).map(([kind, definition]) =>
  Object.freeze({ kind, ...definition })));
export const APPLICATION_CATALOG = Object.freeze([
  application({ kind: 'tencent_docs', category: 'document', nameKey: 'connectivity.application.tencent_docs', authKind: 'credential_or_oauth', resourceKinds: ['document', 'spreadsheet'], capabilities: ['document.read', 'document.create', 'table.read'], transport: 'registered_mcp', docs: 'https://docs.qq.com/open/' }),
  application({ kind: 'agent_mail', category: 'mail', nameKey: 'connectivity.application.agent_mail', authKind: 'credential', resourceKinds: ['mailbox'], capabilities: ['mail.list', 'mail.read', 'mail.send'], transport: 'registered_mcp', docs: 'https://docs.agentmail.to/api-reference' }),
  application({ kind: 'feishu_bitable', category: 'business_data', nameKey: 'connectivity.application.feishu_bitable', authKind: 'oauth', resourceKinds: ['base', 'table'], capabilities: ['table.read', 'table.query', 'table.export'], transport: 'registered_mcp', docs: 'https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview' }),
]);
export function catalogEntry(kind) {
  return [...CHANNEL_CATALOG, ...APPLICATION_CATALOG].find(entry => entry.kind === kind);
}
