import { StringDecoder } from 'node:string_decoder';

/** Reassemble owned stderr bytes before removing the Gateway's per-chunk framing. */
export function nativePeerDiagnosticReader(accept){
 const decoder=new StringDecoder('utf8');let pending='';
 return chunk=>{
  pending=(pending+decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk))).slice(-8192);
  let boundary;
  while((boundary=pending.indexOf('\n'))>=0){
   const line=pending.slice(0,boundary).replaceAll('[app-server] ','');pending=pending.slice(boundary+1);
   try{
    const value=JSON.parse(line.slice(line.indexOf('{')));
    if(value.event==='native_channel_peer_control_unconfirmed'&&value.stage==='original_ui_call'&&/^[a-f0-9]{64}$/.test(value.reasonSha256))accept({stage:value.stage,reasonSha256:value.reasonSha256});
   }catch{}
  }
 };
}
