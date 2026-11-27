import { requireValue } from '../errors.mjs';

export function connectivitySettings(value={}){
  requireValue(value&&typeof value==='object'&&!Array.isArray(value),'INVALID_CONNECTIVITY_SETTINGS');
  const defaults={enabled:false,maxConnections:16,maxPendingEvents:1000,maxMetadataBytes:64*1024*1024,maxAttachmentBytes:100*1024*1024,replayRetentionMs:30*24*3600*1000};
  requireValue(Object.keys(value).every(key=>Object.hasOwn(defaults,key)),'INVALID_CONNECTIVITY_SETTINGS');
  const settings={...defaults,...value};requireValue(typeof settings.enabled==='boolean','INVALID_CONNECTIVITY_SETTINGS');
  for(const[key,low,high]of [['maxConnections',1,64],['maxPendingEvents',1,10000],['maxMetadataBytes',1024*1024,1024*1024*1024],['maxAttachmentBytes',1,100*1024*1024],['replayRetentionMs',24*3600*1000,365*24*3600*1000]])requireValue(Number.isSafeInteger(settings[key])&&settings[key]>=low&&settings[key]<=high,'INVALID_CONNECTIVITY_SETTINGS');
  return Object.freeze(settings);
}
