/** This is the pinned connector's request contract, not a sandbox for arbitrary code. */
export function qqRegistrationRequestOptions(options) {
  const allowed = new Set(['hostname', 'method', 'path', 'timeout', 'headers']);
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Object.keys(options).some(key => !allowed.has(key)) ||
      options.hostname !== 'q.qq.com' || options.method !== 'POST' ||
      !['/lite/create_bind_task', '/lite/poll_bind_result'].includes(options.path)) {
    throw new Error('QQ_QR_HOST_INVALID');
  }
  return { ...options, timeout: 10000 };
}
