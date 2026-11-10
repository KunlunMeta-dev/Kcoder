import https from 'node:https';

// This SDK has no HTTP injection port. Guard its transport in an owned child only;
// no shared Gateway HTTP globals, console output or credentials files are changed.
const request = https.request.bind(https);
https.request = (options, callback) => {
  if (!options || options.hostname !== 'q.qq.com' || options.method !== 'POST'
    || !['/lite/create_bind_task', '/lite/poll_bind_result'].includes(options.path)
    || options.port || options.agent || options.auth) throw new Error('QQ_QR_HOST_INVALID');
  const req = request({ ...options, timeout: 10000 }, response => {
    let bytes = 0;
    response.prependListener('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) { response.destroy(); req.destroy(); process.send?.({ state: 'unavailable' }); process.disconnect(); }
    });
    callback(response);
  });
  return req;
};

const controller = new AbortController();
const publish = value => { if (process.connected) process.send(value); };
process.once('disconnect', () => { controller.abort(); process.exit(0); });
try {
  const { startQrConnect } = await import('@tencent-connect/qqbot-connector');
  startQrConnect({
    onQrDisplayed: verificationUrl => publish({ state: 'waiting', verificationUrl }),
    onQrExpired() { publish({ state: 'expired' }); controller.abort(); },
    onSuccess: credentials => publish({ state: 'ready', credentials }),
    onFailure: () => { if (!controller.signal.aborted) publish({ state: 'unavailable' }); },
  }, { source: 'kcoder', signal: controller.signal, displayQrCodeToConsole: false });
} catch { publish({ state: 'unavailable' }); }
