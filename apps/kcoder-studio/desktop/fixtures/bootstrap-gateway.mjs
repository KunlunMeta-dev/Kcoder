// An owned loopback process; it never loads KCoder settings, SDKs or model code.
import { createServer } from 'node:http';
import { appendFile } from 'node:fs/promises';
if (process.env.KCODER_BOOTSTRAP_PID_FILE) await appendFile(process.env.KCODER_BOOTSTRAP_PID_FILE, `${process.pid}\n`, { mode: 0o600 });
console.log(`OWNED_BOOTSTRAP_PID=${process.pid}`);
if (process.env.KCODER_BOOTSTRAP_MODE === 'held') {
  setInterval(() => {}, 1000);
} else if (process.env.KCODER_BOOTSTRAP_MODE === 'bad-url') {
  console.log('KCoder Studio: http://127.0.0.1:99999');
  setInterval(() => {}, 1000);
} else if (process.env.KCODER_BOOTSTRAP_MODE === 'exit-token') {
  process.stderr.write(process.env.KCODER_STUDIO_AUTH_TOKEN + '\n');
  process.exitCode=1;
} else {
  if (process.env.KCODER_BOOTSTRAP_MODE === 'log-token') {
    const token = process.env.KCODER_STUDIO_AUTH_TOKEN, encoded = new URLSearchParams({ token }).toString().slice(6);
    process.stdout.write('owned-login?token=' + token.slice(0, 20));
    await new Promise(resolve => setTimeout(resolve, 5));
    process.stdout.write(token.slice(20) + '\n');
    process.stderr.write('owned-encoded?token=' + encoded + '\n');
  }
  const server = createServer((request, response) => {
    request.resume();
    const value = process.env.KCODER_BOOTSTRAP_MODE === 'bad-cookie' ? '%' : 'owned-session-value';
    response.writeHead(303, { location: '/', 'set-cookie': `kcoder_studio_session=${value}; Path=/; HttpOnly`, 'x-kcoder-session-ttl-ms': '12000' });
    response.end();
  });
  server.listen(Number(process.env.KCODER_STUDIO_PORT || 0), '127.0.0.1', () => {
    const banner=`KCoder Studio: http://127.0.0.1:${server.address().port}\n`;
    if(process.env.KCODER_BOOTSTRAP_MODE==='split-ready'){const end=banner.lastIndexOf(':')+2;process.stdout.write(banner.slice(0,end));setTimeout(()=>process.stdout.write(banner.slice(end)),25);}
    else process.stdout.write(banner);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
