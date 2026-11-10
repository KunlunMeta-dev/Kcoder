const http = require("node:http");
const listen = http.Server.prototype.listen;
const port = Number(process.env.KCODER_CACHE_FIXTURE_METRO_PORT);
http.Server.prototype.listen = function (...args) {
  if (Number(args[0]) === port) args = [port, "127.0.0.1", ...args.slice(2)];
  else if (args[0] && typeof args[0] === "object" && Number(args[0].port) === port)
    args[0] = { ...args[0], host: "127.0.0.1" };
  return listen.apply(this, args);
};
