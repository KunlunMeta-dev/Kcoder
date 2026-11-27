import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export function imagePasteKeyForPlatform(platform) {
  return platform === 'win32' ? 'Alt+V' : 'Control+Alt+V';
}

export async function createImagePasteFixture(runDir) {
  const fixturePath = path.join(runDir, 'clipboard-image-fixture.png');
  const bytes = Buffer.from(FIXTURE_PNG_BASE64, 'base64');
  await writeFile(fixturePath, bytes, { mode: 0o600 });
  await chmod(fixturePath, 0o600);
  return {
    path: fixturePath,
    byteLength: bytes.length,
  };
}
