const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');

// Only the owner of the loopback CDP session injects this existing E2E gate.
async function startRuntimeAutomationControl(origin) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin) || new URL(origin).port === '')
    throw new Error('Runtime automation requires an explicit loopback Gateway origin');
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const server = http.createServer((request, response) => {
    request.resume();
    if (request.headers.origin !== origin) { response.writeHead(403); response.end(); return; }
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (request.method === 'OPTIONS') { response.writeHead(204, cors); response.end(); return; }
    const received = Buffer.from(request.headers.authorization || '');
    if (received.length !== authorization.length || !timingSafeEqual(received, authorization)) {
      response.writeHead(401, cors); response.end(); return;
    }
    response.writeHead(204, cors); response.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const config = JSON.stringify({ origin, controlUrl: `http://127.0.0.1:${server.address().port}`, token });
  return {
    // No new product global: the renderer's existing authenticated E2E gate owns the bridge.
    script: `if(window===window.top&&location.origin===${JSON.stringify(origin)})Object.defineProperty(window,'__KCODER_AI_VERIFY__',{value:Object.freeze({...${config},nativeIsolation:Promise.resolve([typeof window.require==='undefined',typeof window.process==='undefined'])})});`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
module.exports = { startRuntimeAutomationControl };
