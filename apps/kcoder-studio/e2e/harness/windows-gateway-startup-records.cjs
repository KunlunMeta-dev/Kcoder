const phases=new Set(['module_imports','office_resources','channel_resources','component_image','server_configuration','browser_sessions','account_credentials','resource_policy']);
function gatewayStartupRecords(output){
 const records=[];
 for(const line of output.split('\n')){
  try{
   const value=JSON.parse(line.replace(/^\[gateway\]\s*/,''));
   if(value.event==='gateway-startup'&&phases.has(value.phase)&&['started','completed','failed'].includes(value.status)&&Number.isFinite(value.elapsedMs)&&value.elapsedMs>=0&&value.elapsedMs<=3600000)
    records.push({phase:value.phase,status:value.status,elapsedMs:value.elapsedMs});
  }catch{}
 }
 return records.slice(-32);
}
function desktopSessionCookieMetadata(cookies) {
 const selected=(cookies||[]).filter(cookie=>cookie.name==='kcoder_studio_session');
 return {present:selected.length>0,count:selected.length,metadata:selected.map(cookie=>({
  domain:cookie.domain,path:cookie.path,httpOnly:cookie.httpOnly,secure:cookie.secure,
  session:cookie.session,sameSite:cookie.sameSite,
  expires:Number.isFinite(cookie.expires)&&cookie.expires>=0?cookie.expires:null,
 }))};
}
module.exports={gatewayStartupRecords,desktopSessionCookieMetadata};
