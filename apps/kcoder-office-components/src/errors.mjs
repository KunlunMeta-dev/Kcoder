export class OfficeError extends Error {
  constructor(code, messageKey, recovery = 'repair_configuration', options = {}) {
    super(messageKey, options);
    this.name = 'OfficeError';
    this.code = code;
    this.messageKey = messageKey;
    this.recovery = recovery;
  }
}

export function fail(code = 'OFFICE_INVALID_INPUT', key = 'office.invalidInput') {
  throw new OfficeError(code, key);
}
