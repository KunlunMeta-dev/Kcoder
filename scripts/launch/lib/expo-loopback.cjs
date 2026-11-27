// Expo's --host localhost changes advertised URLs, but Metro still listens without a host.
const { Server } = require('node:http');

const port = Number(process.env.KCODER_WORKSPACE_EXPO_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Expo loopback port');

const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  const first = args[0];
  if (first && typeof first === 'object' && Number(first.port) === port) {
    args[0] = { ...first, host: '127.0.0.1' };
  } else if (Number(first) === port) {
    if (typeof args[1] === 'string' || args[1] === undefined || args[1] === null) {
      args[1] = '127.0.0.1';
    } else {
      args.splice(1, 0, '127.0.0.1');
    }
  }
  return listen.apply(this, args);
};
