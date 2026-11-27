// A transport-only bridge. OpenSSH, not this process, authenticates and spawns the target.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const path = process.argv[2], info = await lstat(path);
assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < 32768 && info.uid === process.getuid());
const config = JSON.parse(await readFile(path, 'utf8'));
assert.match(config.id, /^[a-f0-9]{64}$/); assert.match(config.owner, /^[a-f0-9-]{36}$/);
assert.match(config.image, /^sha256:[a-f0-9]{64}$/); assert.ok(Number.isInteger(config.port) && config.port > 1024 && config.port < 65536);
const globals = ['--config', config.dockerConfig, '--host', 'unix:///var/run/docker.sock'];
const { stdout } = await promisify(execFile)('/usr/bin/docker', [...globals, 'inspect', config.id], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 10000, maxBuffer: 128 * 1024 });
const actual = JSON.parse(stdout)[0]; assert.equal(actual.Id, config.id); assert.equal(actual.Image, config.image); assert.equal(actual.Config.Labels['kcoder.test.peer-uid-container-owner'], config.owner); assert.equal(actual.HostConfig.NetworkMode, 'none'); assert.equal(actual.State.Running, true);
const child = spawn('/usr/bin/docker', [...globals, 'exec', '-i', config.id, '/usr/bin/python3', '-I', '-S', '-B', '/fixture/controller.py', 'proxy', config.owner, String(config.port)], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
child.once('error', () => { process.exitCode = 1; process.stdin.destroy(); });
child.once('close', code => { process.exitCode = code ?? 1; process.stdin.destroy(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
