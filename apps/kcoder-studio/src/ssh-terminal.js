import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import ssh2 from 'ssh2';
import { readBoundedRegularFile, SSH_CONNECTION_ID_PATTERN, strictObject } from './ssh-terminal-store.js';

const HANDSHAKE_TIMEOUT_MS = 15_000;
const INPUT_LIMIT = 64 * 1024;
const WRITE_BUFFER_LIMIT = 256 * 1024;
const OUTPUT_CHUNK_LIMIT = 16 * 1024;
const OUTPUT_RATE_LIMIT = 4 * 1024 * 1024;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
class SshPreflightError extends Error {}

function credential(value) {
  if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024 || value.includes('\0'))) throw new Error('SSH 凭据格式或长度无效');
  return value;
}

export function createSshTerminalSession({ store, send, clientFactory = () => new ssh2.Client(), handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS }) {
  let active = null;
  let disposed = false;

  function notify(method, params) {
    if (disposed) return false;
    try { return send({ jsonrpc: '2.0', method, params }) !== false; } catch { return false; }
  }

  function finish(state, { error, result, reason = 'SSH 连接已关闭', exitCode } = {}) {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(state.timer);
    if (active === state) active = null;
    try { state.channel?.destroy(); } catch { /* Cleanup must not expose transport errors. */ }
    try { state.client?.destroy(); } catch { /* Cleanup must remain idempotent. */ }
    if (state.connected) notify('ssh/exit', { reason, ...(Number.isInteger(exitCode) ? { exitCode } : {}) });
    if (!state.settled) {
      state.settled = true;
      if (result) state.resolve(result);
      else state.reject(new Error(error ?? reason));
    }
  }

  function output(state, decoder, chunk) {
    if (state.finished) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const now = Date.now();
    if (now - state.outputWindow >= 1000) { state.outputWindow = now; state.outputBytes = 0; }
    state.outputBytes += bytes.length;
    if (state.outputBytes > OUTPUT_RATE_LIMIT) return finish(state, { reason: 'SSH 输出超过速率限制，连接已关闭' });
    for (let offset = 0; offset < bytes.length && !state.finished; offset += OUTPUT_CHUNK_LIMIT) {
      const data = decoder.write(bytes.subarray(offset, offset + OUTPUT_CHUNK_LIMIT));
      if (data && !notify('ssh/output', { data })) finish(state, { reason: 'SSH 输出缓冲区已满，连接已关闭' });
    }
  }

  async function start(state, params) {
    const profile = (await store.list()).find(({ id }) => id === params.profileId);
    if (state.finished) return;
    if (!profile) throw new SshPreflightError('SSH 连接配置不存在');
    const authentication = {};
    // Discovery intentionally supplies no credentials and rejects in hostVerifier before user authentication.
    if (profile.hostFingerprint || params.acceptFingerprint) {
      if (profile.authMethod === 'password') {
        let password = params.password;
        if (!password && profile.passwordSaved) {
          try { password = await store.resolvePassword(profile); }
          catch { throw new SshPreflightError('无法读取已保存的 SSH 密码，请在设置中重新保存'); }
        }
        if (!password) throw new SshPreflightError('请输入 SSH 密码');
        authentication.password = password;
        authentication.authHandler = ['password'];
      } else if (profile.authMethod === 'key') {
        try { authentication.privateKey = await readBoundedRegularFile(profile.privateKeyPath, 1024 * 1024); }
        catch { throw new SshPreflightError('无法读取 Gateway 主机上的 SSH 私钥（必须为不超过 1 MiB 的普通文件）'); }
        authentication.passphrase = params.passphrase;
        authentication.authHandler = ['publickey'];
      } else {
        if (process.platform === 'win32') throw new SshPreflightError('Windows Gateway 暂不支持 SSH Agent，请使用密码或私钥');
        if (!process.env.SSH_AUTH_SOCK) throw new SshPreflightError('Gateway 未配置 SSH_AUTH_SOCK');
        authentication.agent = process.env.SSH_AUTH_SOCK;
        authentication.authHandler = ['agent'];
      }
    } else authentication.authHandler = [];
    if (state.finished) return;
    const client = clientFactory();
    state.client = client;
    client.on('error', () => finish(state, { error: 'SSH 连接失败，请检查网络、认证信息和服务器状态', reason: 'SSH 连接中断' }));
    client.on('close', () => finish(state));
    client.on('end', () => finish(state));
    client.once('ready', () => {
      if (state.finished) return;
      try {
        client.shell({ term: 'xterm-256color', rows: 24, cols: 80 }, (error, channel) => {
          if (state.finished) { channel?.destroy(); return; }
          if (error) return finish(state, { error: '无法启动 SSH 交互终端' });
          state.channel = channel;
          const stdout = new StringDecoder('utf8');
          const stderr = new StringDecoder('utf8');
          channel.on('data', (chunk) => output(state, stdout, chunk));
          channel.stderr?.on('data', (chunk) => output(state, stderr, chunk));
          channel.on('drain', () => { state.backpressured = false; });
          channel.on('error', () => finish(state, { reason: 'SSH 终端连接中断' }));
          channel.stderr?.on('error', () => finish(state, { reason: 'SSH 终端连接中断' }));
          channel.on('exit', (code) => { state.exitCode = code; });
          channel.on('close', () => {
            if (state.finished) return;
            const tail = stdout.end() + stderr.end();
            if (tail) notify('ssh/output', { data: tail });
            finish(state, { exitCode: state.exitCode });
          });
          clearTimeout(state.timer);
          state.connected = true;
          state.settled = true;
          state.resolve({ status: 'connected', title: profile.label });
        });
      } catch { finish(state, { error: '无法启动 SSH 交互终端' }); }
    });
    client.connect({
      host: profile.host, port: profile.port, username: profile.username,
      readyTimeout: HANDSHAKE_TIMEOUT_MS, keepaliveInterval: 15_000, keepaliveCountMax: 3,
      tryKeyboard: false, ...authentication,
      hostVerifier(key, callback) {
        if (state.finished) { callback(false); return; }
        const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
        if (profile.hostFingerprint && profile.hostFingerprint !== fingerprint) {
          finish(state, { error: 'SSH 主机指纹已变化，拒绝连接；请通过可信渠道核实服务器身份' });
          callback(false);
          return;
        }
        if (!profile.hostFingerprint && !params.acceptFingerprint) {
          finish(state, { result: { status: 'host-key-required', fingerprint, host: profile.host, port: profile.port } });
          callback(false);
          return;
        }
        if (params.acceptFingerprint && params.acceptFingerprint !== fingerprint) {
          finish(state, { error: 'SSH 主机指纹与确认值不一致，拒绝连接' });
          callback(false);
          return;
        }
        // Persist and recheck the current profile before authentication can leave the Gateway.
        store.pinFingerprint(profile, fingerprint).then(() => callback(!state.finished), () => {
          finish(state, { error: 'SSH 主机指纹保存失败或连接配置已变更，拒绝连接' });
          callback(false);
        });
      },
    });
  }

  return {
    async handle(method, params = {}) {
      if (disposed) throw new Error('SSH 会话已关闭');
      if (method === 'ssh/connect') {
        strictObject(params, ['profileId', 'password', 'passphrase', 'acceptFingerprint']);
        if (typeof params.profileId !== 'string' || !SSH_CONNECTION_ID_PATTERN.test(params.profileId)) throw new Error('SSH 连接 ID 无效');
        credential(params.password);
        credential(params.passphrase);
        if (params.acceptFingerprint !== undefined && !FINGERPRINT.test(params.acceptFingerprint)) throw new Error('SSH 主机指纹无效');
        if (active) throw new Error('当前窗口已有 SSH 连接，请先断开');
        const state = { finished: false, connected: false, settled: false, outputWindow: Date.now(), outputBytes: 0 };
        active = state;
        return new Promise((resolve, reject) => {
          state.resolve = resolve;
          state.reject = reject;
          state.timer = setTimeout(() => finish(state, { error: 'SSH 连接超时' }), handshakeTimeoutMs);
          start(state, { ...params }).catch((error) => {
            // Only locally authored validation errors may reach the client.
            const safe = error instanceof SshPreflightError;
            finish(state, { error: safe ? error.message : 'SSH 连接失败，请检查认证信息和服务器状态' });
          });
        });
      }
      if (method === 'ssh/close') {
        strictObject(params, []);
        if (active) finish(active);
        return { closed: true };
      }
      if (method !== 'ssh/write' && method !== 'ssh/resize') throw new Error('不支持的 SSH 方法');
      if (!active?.connected) throw new Error('SSH 终端尚未连接');
      const state = active;
      if (method === 'ssh/write') {
        strictObject(params, ['data']);
        if (typeof params.data !== 'string' || Buffer.byteLength(params.data) > INPUT_LIMIT) throw new Error('SSH 输入超过 64 KiB 限制');
        if (state.backpressured || state.channel.writableLength + Buffer.byteLength(params.data) > WRITE_BUFFER_LIMIT) throw new Error('SSH 写入繁忙，请稍后重试');
        try { state.backpressured = !state.channel.write(params.data); }
        catch { finish(state, { reason: 'SSH 写入失败' }); throw new Error('SSH 写入失败'); }
        return { written: true };
      }
      strictObject(params, ['rows', 'cols']);
      if (![params.rows, params.cols].every((value) => Number.isInteger(value) && value >= 1 && value <= 1000)) throw new Error('SSH 终端行列数必须介于 1 和 1000');
      try { state.channel.setWindow(params.rows, params.cols, 0, 0); }
      catch { finish(state, { reason: 'SSH 终端调整大小失败' }); throw new Error('SSH 终端调整大小失败'); }
      return { resized: true };
    },
    dispose() {
      disposed = true;
      if (active) finish(active);
    },
  };
}
