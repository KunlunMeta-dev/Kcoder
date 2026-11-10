/** Official reply tokens remain valid until replaced or rejected by Weixin. */
export function weixinContextTtl(value, ttlMs) {
  return typeof value?.contextToken === 'string' && typeof value?.toUserId === 'string' ? undefined : ttlMs;
}
