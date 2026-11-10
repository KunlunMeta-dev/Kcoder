import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/** This list and framing match kcoder_app_protocol/build.rs, which embeds the receipt at compile time. */
export function protocolSourceReceipt(root) {
  const files = ['Cargo.toml', 'Cargo.lock', 'crates/kcoder_app_protocol/Cargo.toml',
    'crates/kcoder_app_protocol/build.rs', 'crates/kcoder_types/Cargo.toml',
    'crates/kcoder_app_protocol/internal/channel_protocol/Cargo.toml',
    'crates/kcoder_types/internal/common_types/Cargo.toml',
    'crates/kcoder_types/internal/session_types/Cargo.toml',
    'crates/kcoder_types/internal/integration_types/Cargo.toml',
    'crates/kcoder_app_protocol/internal/integration_protocol/Cargo.toml',
    'crates/kcoder_app_protocol/examples/export_contracts.rs', 'scripts/contracts/source-receipt.mjs'];
  function walk(path, extension) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) walk(child, extension);
      else if (entry.isFile() && entry.name.endsWith(`.${extension}`) &&
        (extension === 'rs' || entry.name.startsWith('fixtures')))
        files.push(relative(root, child).split(sep).join('/'));
    }
  }
  walk(resolve(root, 'crates/kcoder_app_protocol/src'), 'rs');
  walk(resolve(root, 'crates/kcoder_app_protocol/examples'), 'rs');
  walk(resolve(root, 'crates/kcoder_types/src'), 'rs');
  walk(resolve(root, 'scripts/contracts'), 'json');
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const bytes = readFileSync(resolve(root, file));
    hash.update(file).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return `protocol-source/v1:${hash.digest('hex')}`;
}

export function validateExporterReceipt(exported, expectedReceipt, sourceFixtures) {
  const message = 'Rust exporter does not match current contract sources; rebuild the exporter before generation.';
  if (exported.sourceReceipt !== expectedReceipt) throw new Error(message);
  const returned = structuredClone(exported.fixtures);
  for (const cases of Object.values(returned ?? {}))
    for (const example of cases.valid ?? []) delete example.decoded;
  if (!isDeepStrictEqual(returned, sourceFixtures)) throw new Error(message);
}
