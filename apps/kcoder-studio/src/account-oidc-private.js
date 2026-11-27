// Native-issued resume authority is private transport data, never an RPC DTO.
export function privateOidcResume(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'clientBinding,handle,secret' ||
      !/^[0-9a-f]{64}$/.test(value.handle) || !/^[0-9a-f]{64}$/.test(value.secret) ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(value.clientBinding)) throw new Error('OIDC native authority unavailable');
  return Object.freeze({ handle: value.handle, secret: value.secret, clientBinding: value.clientBinding });
}
