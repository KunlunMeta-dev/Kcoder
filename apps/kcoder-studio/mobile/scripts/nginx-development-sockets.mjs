import assert from "node:assert/strict";

/** Complete an existing mounted Expo proxy without exposing root-level sockets. */
export function completeDevelopmentSockets(config, mount) {
  assert.match(mount, /^\/g\/[a-zA-Z0-9_-]+$/);
  const hotLocation = `location = ${mount}/hot {`;
  const start = config.indexOf(hotLocation);
  assert.ok(start >= 0, "Existing mounted hot proxy is required");
  const end = config.indexOf("}", start);
  assert.ok(end > start, "Existing hot proxy must have a closing brace");
  const block = config.slice(start, end + 1);
  assert.match(block, /proxy_pass http:\/\/127\.0\.0\.1:\d+\/hot;/);
  assert.match(block, /proxy_set_header Upgrade \$http_upgrade;/);
  const messageBlock = block.replace(`${mount}/hot`, `${mount}/message`).replace(/(proxy_pass http:\/\/127\.0\.0\.1:\d+)\/hot;/, "$1/message;");
  const hotFilter = `sub_filter 'window.location.host}/hot' 'window.location.host}${mount}/hot';`;
  const messageFilter = `sub_filter 'window.location.host}/message' 'window.location.host}${mount}/message';`;
  assert.ok(config.includes(hotFilter), "Existing mounted hot bundle rewrite is required");
  if (!config.includes(`location = ${mount}/message {`)) config = config.slice(0, end + 1) + "\n\n    " + messageBlock + config.slice(end + 1);
  else assert.ok(config.includes(messageBlock), "Existing message proxy differs; review it explicitly");
  if (!config.includes(messageFilter)) config = config.replace(hotFilter, `${hotFilter}\n      ${messageFilter}`);
  const favicon = `sub_filter 'href="/__kcoder_mobile_mount_v1__/' 'href="${mount}/mobile/';`;
  if (!config.includes(favicon)) config = config.replace(hotFilter, `${favicon}\n      ${hotFilter}`);
  return config;
}
