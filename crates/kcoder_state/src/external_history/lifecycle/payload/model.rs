use super::*;
use kcoder_config::PortableLeaseIdentity;
use serde::{Deserialize, Serialize};
pub(super) const MAX_NODES: usize = 14_098;
pub(super) const META: usize = 64 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::external_history::lifecycle) struct PayloadAnchor {
    pub directory: String,
    pub staging: String,
    pub published: bool,
    pub lease: PortableLeaseIdentity,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Header {
    pub version: u8,
    pub scope: String,
    pub archive: String,
    pub generation: String,
    pub directory: String,
    pub lease: PortableLeaseIdentity,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FileProof {
    pub name: String,
    pub identity: PortableLeaseIdentity,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Node {
    pub version: u8,
    pub scope: String,
    pub archive: String,
    pub generation: String,
    pub path: String,
    pub directory: String,
    pub staging: String,
    pub published: bool,
    pub lease: PortableLeaseIdentity,
    pub controls: std::collections::BTreeMap<String, PortableLeaseIdentity>,
    pub files: std::collections::BTreeMap<String, Vec<FileProof>>,
    #[serde(default)]
    pub restored_metadata: Vec<FileProof>,
    pub seal: Option<String>,
    pub sequence: u64,
}
pub(super) fn valid_path(path: &str) -> Result<()> {
    let mut parts = path.split('/');
    let family = parts
        .next()
        .context("external_history_payload_invalid_path")?;
    ensure!(
        matches!(family, "attachments-v1" | "local-attachments-v1"),
        "external_history_payload_invalid_path"
    );
    if let Some(child) = parts.next() {
        let valid = if family == "attachments-v1" {
            valid_hash(child)
        } else {
            uuid::Uuid::parse_str(child).is_ok_and(|id| id.to_string() == child)
        };
        ensure!(
            valid && parts.next().is_none(),
            "external_history_payload_invalid_path"
        );
    }
    Ok(())
}
pub(super) fn controls(path: &str) -> &'static [&'static str] {
    match path {
        "attachments-v1" => &["budget.lock"],
        "local-attachments-v1" => &["catalog.lock"],
        _ if path.starts_with("attachments-v1/") => &["writer.lock"],
        _ => &["writer.lock", "control.lock"],
    }
}
pub(super) fn allowed(path: &str, name: &str) -> bool {
    controls(path).contains(&name)
        || match path {
            "attachments-v1" | "local-attachments-v1" => false,
            _ if path.starts_with("attachments-v1/") => {
                matches!(name, "binding.json" | "payload.bin" | "receipt.json")
            }
            _ => matches!(name, "intent.json" | "control.json" | "state.json"),
        }
}
impl Node {
    pub fn validate(&self, header: &Header, path: &str) -> Result<()> {
        valid_path(path)?;
        ensure!(
            self.version == 1
                && self.scope == header.scope
                && self.archive == header.archive
                && self.generation == header.generation
                && self.path == path
                && self.directory.len() <= 256
                && self
                    .staging
                    .strip_prefix("payload-birth-")
                    .is_some_and(
                        |id| uuid::Uuid::parse_str(id).is_ok_and(|idv| idv.to_string() == id)
                    )
                && self.controls.len() == controls(path).len()
                && controls(path)
                    .iter()
                    .all(|name| self.controls.contains_key(*name))
                && self.files.len() <= 5
                && self.restored_metadata.len() <= 32,
            "external_history_payload_changed"
        );
        for (name, proofs) in &self.files {
            ensure!(
                allowed(path, name) && !proofs.is_empty() && proofs.len() <= 2,
                "external_history_payload_changed"
            );
            for proof in proofs {
                ensure!(
                    proof.name == *name && proof.bytes <= 256 * 1024 * 1024,
                    "external_history_payload_budget_exceeded"
                );
                ensure!(
                    valid_hash(&proof.sha256),
                    "external_history_payload_changed"
                );
            }
        }
        if let Some(seal) = &self.seal {
            ensure!(valid_hash(seal), "external_history_payload_changed");
        }
        Ok(())
    }
}
