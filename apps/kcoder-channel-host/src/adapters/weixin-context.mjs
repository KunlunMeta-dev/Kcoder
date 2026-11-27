/** Original per-message reply tokens have no documented fixed expiry. */
export function weixinContextTtl(value, ttlMs) {
  const reply=value&&['contextToken','toUserId'].every(key=>Object.hasOwn(value,key)&&typeof value[key]==='string'&&value[key].trim().length>0);
  return reply ? undefined : ttlMs;
}
