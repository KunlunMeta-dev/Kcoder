//! Creation identity hashes validated public parameters without consulting live source grants.
use anyhow::{Result, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use zeroize::Zeroizing;

const MAX_INTENT_BYTES: usize = 1024 * 1024;
const MAX_INTENT_NODES: usize = 8192;

/// The caller supplies its complete validated public request, including initial
/// limits and explicit destination choices. Native source bindings are not public intent.
#[derive(Clone, PartialEq, Eq)]
pub struct BatchCreateIntent {
    request_id: String,
    digest: String,
}
impl std::fmt::Debug for BatchCreateIntent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BatchCreateIntent")
            .field("request_id", &self.request_id)
            .finish_non_exhaustive()
    }
}
impl BatchCreateIntent {
    pub fn new(request_id: &str, public_parameters: &impl Serialize) -> Result<Self> {
        ensure!(
            uuid::Uuid::parse_str(request_id).is_ok_and(|value| value.to_string() == request_id),
            "migration_invalid_request_reference"
        );
        let mut input = BoundedBytes(Zeroizing::new(Vec::new()));
        serde_json::to_writer(&mut input, public_parameters)
            .map_err(|_| anyhow::anyhow!("migration_batch_create_intent_invalid"))?;
        let value: serde_json::Value = serde_json::from_slice(&input.0)
            .map_err(|_| anyhow::anyhow!("migration_batch_create_intent_invalid"))?;
        ensure!(value.is_object(), "migration_batch_create_intent_invalid");
        let mut hash = HashWriter(Sha256::new());
        hash.0.update(b"kcoder.migration.batch-create.intent/1\0");
        canonical(&value, &mut hash, 0, &mut 0)?;
        Ok(Self {
            request_id: request_id.into(),
            digest: format!("{:x}", hash.0.finalize()),
        })
    }
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub(crate) fn digest(&self) -> &str {
        &self.digest
    }
    pub(super) fn from_original(request_id: &str, digest: &str) -> Result<Self> {
        super::model::uuid(request_id)?;
        super::model::digest(digest)?;
        Ok(Self {
            request_id: request_id.into(),
            digest: digest.into(),
        })
    }
}

fn canonical(
    value: &serde_json::Value,
    writer: &mut HashWriter,
    depth: usize,
    nodes: &mut usize,
) -> Result<()> {
    *nodes += 1;
    ensure!(
        depth <= 16 && *nodes <= MAX_INTENT_NODES,
        "migration_batch_create_intent_invalid"
    );
    match value {
        serde_json::Value::Object(map) => {
            writer.write_all(b"{")?;
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index != 0 {
                    writer.write_all(b",")?;
                }
                serde_json::to_writer(&mut *writer, key)?;
                writer.write_all(b":")?;
                canonical(value, writer, depth + 1, nodes)?;
            }
            writer.write_all(b"}")?;
        }
        serde_json::Value::Array(items) => {
            writer.write_all(b"[")?;
            for (index, value) in items.iter().enumerate() {
                if index != 0 {
                    writer.write_all(b",")?;
                }
                canonical(value, writer, depth + 1, nodes)?;
            }
            writer.write_all(b"]")?;
        }
        value => serde_json::to_writer(writer, value)?,
    }
    Ok(())
}
struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
struct BoundedBytes(Zeroizing<Vec<u8>>);
impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_INTENT_BYTES {
            return Err(std::io::Error::other(
                "public creation intent exceeds bound",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
