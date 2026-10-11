import { writeFileSync } from 'node:fs';
import { WorkspaceAppServerBroker } from '../../../src/workspace-app-server-broker.js';

// Schema metadata only. Neither file content, credentials nor complete RPC frames are retained.
const output = process.env.KCODER_E2E_NATIVE_ATTACHMENT_SCHEMA;
if (output) {
  const rows = [], original = WorkspaceAppServerBroker.prototype.writeRaw;
  WorkspaceAppServerBroker.prototype.writeRaw = function (raw, ...rest) {
    let frame; try { frame = JSON.parse(raw); } catch {}
    if (frame?.method === 'attachment/save' && rows.length < 16) {
      const params = frame.params;
      rows.push({ method: frame.method, paramsType: typeof params, filenameType: typeof params?.filename,
        contentBase64Type: typeof params?.content_base64, camelBase64Type: typeof params?.contentBase64,
        encodedCharacters: typeof params?.content_base64 === 'string' ? params.content_base64.length : null });
      writeFileSync(output, JSON.stringify(rows), { mode: 0o600 });
    }
    return original.call(this, raw, ...rest);
  };
}
