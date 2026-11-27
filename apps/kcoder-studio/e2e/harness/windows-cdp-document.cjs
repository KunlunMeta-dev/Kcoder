// Inspect DOM metadata without creating a script context on an empty document.
function isCommittedLoopbackDocument(frame, document) {
  let url;
  try { url = new URL(document?.documentURL); } catch { return false; }
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
    && frame?.url === document.documentURL && Boolean(frame.loaderId)
    && hasApplicationRoot(document);
}
function hasApplicationRoot(node) {
  const attributes = node?.attributes ?? [];
  if (node?.nodeType === 1 && attributes.some((value, index) => index % 2 === 0
    && value === 'id' && attributes[index + 1] === 'root')) return true;
  return node?.children?.some(hasApplicationRoot) === true;
}
function isCommittedStartupDocument(frame, document) {
  const meta=node=>{
    const attributes=node?.attributes??[];const values={};
    for(let index=0;index<attributes.length;index+=2)values[attributes[index]]=attributes[index+1];
    return (node?.nodeName==='META'&&values.name==='kcoder-desktop-startup'&&values.content==='restricted')||node?.children?.some(meta)===true;
  };
  return typeof document?.documentURL==='string'&&document.documentURL.startsWith('data:text/html')
    &&frame?.url===document.documentURL&&Boolean(frame.loaderId)&&meta(document);
}
function createCdpClient(url, { onEvent = () => {}, WebSocketType = WebSocket } = {}) {
  const socket = new WebSocketType(url), pending = new Map();
  let sequence = 0;
  const abort = () => { for (const [id, item] of pending) { clearTimeout(item.timer);item.reject(Error('Owned CDP connection closed'));pending.delete(id); } };
  socket.addEventListener('close', abort);socket.addEventListener('error', abort);
  socket.addEventListener('message', event => {
    const message=JSON.parse(event.data);
    if (!message.id) {onEvent(message);return;}
    const item=pending.get(message.id);if(!item)return;
    pending.delete(message.id);clearTimeout(item.timer);
    message.error?item.reject(Error(`CDP ${item.method} failed`)):item.resolve(message.result);
  });
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('CDP open timed out')),10000);
    socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP open failed'));},{once:true});
  });
  const request=(method,params={},timeout=method==='Runtime.evaluate'?30000:10000)=>new Promise((resolve,reject)=>{
    const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP ${method} timed out`));},timeout);
    pending.set(id,{method,resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
  return {socket,ready,request,abort,close(){abort();socket.close();}};
}
module.exports = { isCommittedLoopbackDocument, isCommittedStartupDocument, createCdpClient };
