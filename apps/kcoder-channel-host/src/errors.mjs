export class ChannelError extends Error {
  constructor(code, recovery = 'none') {
    super(code);
    this.name = 'ChannelError';
    this.code = code;
    this.recovery = recovery;
  }
}
export function requireValue(condition, code, recovery = 'none') {
  if (!condition) throw new ChannelError(code, recovery);
}
export function publicError(error) {
  return error instanceof ChannelError
    ? { code: error.code, recovery: error.recovery, messageKey: 'connectivity.' + error.code.toLowerCase() }
    : { code: 'INTERNAL_ERROR', recovery: 'none', messageKey: 'connectivity.internal_error' };
}
