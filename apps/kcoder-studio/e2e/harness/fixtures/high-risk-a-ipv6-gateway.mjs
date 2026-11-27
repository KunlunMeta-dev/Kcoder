import { createServer } from 'node:http';
const host = process.env.KCODER_STUDIO_HOST;
const server = createServer((_request, response) => response.end('owned IPv6 startup parser'));
server.listen(0, host, () => console.log(`KCoder Studio: http://[${host}]:${server.address().port}`));
