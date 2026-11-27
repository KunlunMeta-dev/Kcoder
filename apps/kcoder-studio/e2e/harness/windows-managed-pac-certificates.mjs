import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { requireExecutable, waitFor } from './run-context.mjs';
import { WINDOWS_MANAGED_PAC_HOST, windowsManagedPacPayload } from './windows-managed-pac-fixture.mjs';

/** Linux preparation only. Transfer these inputs solely into the new SID's private state. */
export async function prepareWindowsManagedPacCertificates(context) {
  assert.equal(process.platform, 'linux', 'Owned certificate generation uses the approved Linux OpenSSL host');
  const fixtureId = randomUUID(), prefix = `managed-pac/${fixtureId}`;
  await mkdir(context.pathInState(prefix), { recursive: true, mode: 0o700 });
  const path = name => context.pathInState(`${prefix}/${name}`);
  const caPath = path('ca.pem'), caKeyPath = path('ca-key.pem'), keyPath = path('leaf-key.pem'), csrPath = path('leaf.csr'), certificatePath = path('leaf.pem');
  const openssl = await requireExecutable(process.env.KCODER_E2E_OPENSSL_BIN || '/usr/bin/openssl', 'OpenSSL for private managed PAC input');
  const command = async (label, args) => {
    const child = context.spawnOwned(`${label}-${fixtureId}`, openssl, args);
    await waitFor(() => child.exitCode !== null ? { code: child.exitCode } : null, 15000, label, 30, context.abortSignal);
    assert.equal(child.exitCode, 0, 'Owned fixture certificate generation must succeed');
  };
  await command('managed-pac-ca', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=KCoder owned managed PAC CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKeyPath, '-out', caPath]);
  await command('managed-pac-leaf', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${WINDOWS_MANAGED_PAC_HOST}`, '-addext', `subjectAltName=DNS:${WINDOWS_MANAGED_PAC_HOST}`, '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth', '-keyout', keyPath, '-out', csrPath]);
  for (const key of [caKeyPath, keyPath]) {
    await chmod(key, 0o600);
    for (const line of (await readFile(key, 'utf8')).split(/\r?\n/)) if (line && !line.startsWith('-----')) context.registerSecret(line);
  }
  await command('managed-pac-sign', ['x509', '-req', '-in', csrPath, '-CA', caPath, '-CAkey', caKeyPath, '-set_serial', '1', '-days', '1', '-copy_extensions', 'copy', '-out', certificatePath]);
  const payload = windowsManagedPacPayload(fixtureId);
  const htmlArtifact = await context.writeArtifactJson('managed-pac-bing-html.json', payload);
  const caSha256 = createHash('sha256').update(await readFile(caPath)).digest('hex'), certificateSha256 = createHash('sha256').update(await readFile(certificatePath)).digest('hex');
  await context.writeArtifactJson('managed-pac-certificate-identity.json', { fixtureId, tlsHost: WINDOWS_MANAGED_PAC_HOST, caSha256, certificateSha256, privateKeysRetainedInArtifacts: false, certificateStoreWrites: 0 });
  return { fixtureId, caPath, certificatePath, keyPath, caSha256, certificateSha256, htmlArtifact };
}
