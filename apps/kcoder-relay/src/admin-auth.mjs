import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const scrypt = promisify(derive);
export const MIN_PASSWORD_LENGTH = 15;
export function meetsPasswordPolicy(password, username) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const trimmed = password.trim();
  return [...trimmed].length >= MIN_PASSWORD_LENGTH &&
    trimmed.toLowerCase() !== username?.toLowerCase() && !/^(.)\1+$/su.test(trimmed);
}

export function validAdminPasswordHash(value) {
  return typeof value === 'string' && /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(value);
}
export { hashAccountPassword as hashAdminPassword };
export async function hashAccountPassword(password) {
  if (!meetsPasswordPolicy(password)) throw Error('Password does not meet the Relay password policy');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await scrypt(password, salt, 32)).toString('hex')}`;
}
export async function verifyAdminPassword(password, hash) {
  if (!validAdminPasswordHash(hash) || typeof password !== 'string' || password.length > 256) return false;
  const [, salt, expected] = hash.split('$');
  return timingSafeEqual(await scrypt(password, salt, 32), Buffer.from(expected, 'hex'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 258) throw Error('Password input is too long'); }
  console.log(await hashAccountPassword(text.replace(/\r?\n$/, '')));
}
