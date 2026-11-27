//! Portable manifest validation for explicitly supplied inert migration backups.
use anyhow::{Result, ensure};
use kcoder_types::migration_source_upload::SourceUploadManifest;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write};

pub const SOURCE_UPLOAD_VERSION: u32 = 1;
pub const SOURCE_UPLOAD_MAX_FILES: usize = 1024;
pub const SOURCE_UPLOAD_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const SOURCE_UPLOAD_MANIFEST_MAX_BYTES: usize = 1024 * 1024;
pub const SOURCE_UPLOAD_MAX_PATH_BYTES: usize = 4096;
pub const SOURCE_UPLOAD_MAX_PATH_DEPTH: usize = 16;
pub const SOURCE_UPLOAD_MAX_COMPONENT_BYTES: usize = 255;

/// Validated metadata is private; file names and source metadata must not enter logs.
/// The content may still contain private values. Filename checks do not sanitize bodies.
pub struct ValidatedManifest {
    manifest: SourceUploadManifest,
    canonical: Vec<u8>,
    total_bytes: u64,
}

impl ValidatedManifest {
    pub fn manifest(&self) -> &SourceUploadManifest {
        &self.manifest
    }

    /// Compact JSON in the shared type's field order; the file array retains its order.
    pub fn canonical_json(&self) -> &[u8] {
        &self.canonical
    }

    pub fn sha256(&self) -> String {
        format!("{:x}", Sha256::digest(&self.canonical))
    }

    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }
}

pub fn parse_manifest(bytes: &[u8]) -> Result<ValidatedManifest> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= SOURCE_UPLOAD_MANIFEST_MAX_BYTES,
        "source_upload_manifest_budget"
    );
    // Never propagate untrusted field names or source excerpts from serde errors.
    let manifest = serde_json::from_slice(bytes)
        .map_err(|_| anyhow::anyhow!("source_upload_invalid_manifest"))?;
    validate_manifest(manifest)
}

pub fn validate_manifest(manifest: SourceUploadManifest) -> Result<ValidatedManifest> {
    ensure!(
        manifest.version == SOURCE_UPLOAD_VERSION,
        "source_upload_unsupported_version"
    );
    ensure!(
        !manifest.files.is_empty() && manifest.files.len() <= SOURCE_UPLOAD_MAX_FILES,
        "source_upload_file_count"
    );
    let mut total_bytes = 0u64;
    // Directory spellings are also fixed: A/one and a/two cannot merge two source roots.
    let mut nodes: BTreeMap<String, (String, bool)> = BTreeMap::new();
    for file in &manifest.files {
        validate_relative_path(&file.relative_path)?;
        ensure!(valid_sha256(&file.sha256), "source_upload_invalid_digest");
        total_bytes = total_bytes
            .checked_add(file.bytes)
            .ok_or_else(|| anyhow::anyhow!("source_upload_payload_budget"))?;
        ensure!(
            total_bytes <= SOURCE_UPLOAD_MAX_BYTES,
            "source_upload_payload_budget"
        );
        let parts = file.relative_path.split('/').collect::<Vec<_>>();
        let mut original = String::new();
        let mut folded = String::new();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                original.push('/');
                folded.push('/');
            }
            original.push_str(part);
            // Unicode uppercase is deliberately conservative, including multi-character folds.
            folded.push_str(&part.to_uppercase().to_lowercase());
            let is_file = index + 1 == parts.len();
            if let Some((spelling, existing_file)) = nodes.get(&folded) {
                ensure!(spelling == &original, "source_upload_path_alias");
                ensure!(!existing_file && !is_file, "source_upload_path_conflict");
            } else {
                nodes.insert(folded.clone(), (original.clone(), is_file));
            }
        }
    }
    let mut canonical = ManifestWriter(Vec::new());
    serde_json::to_writer(&mut canonical, &manifest)
        .map_err(|_| anyhow::anyhow!("source_upload_manifest_budget"))?;
    Ok(ValidatedManifest {
        manifest,
        canonical: canonical.0,
        total_bytes,
    })
}

pub fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// This policy permits configuration filenames; static-asset transfer's narrower
/// validator intentionally rejects those names and cannot be reused for backups.
pub fn validate_relative_path(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= SOURCE_UPLOAD_MAX_PATH_BYTES
            && value.split('/').count() <= SOURCE_UPLOAD_MAX_PATH_DEPTH,
        "source_upload_unsafe_path"
    );
    for part in value.split('/') {
        ensure!(
            !part.is_empty()
                && part.len() <= SOURCE_UPLOAD_MAX_COMPONENT_BYTES
                && !matches!(part, "." | "..")
                && !part.ends_with(['.', ' '])
                && !part
                    .chars()
                    .any(|ch| ch.is_control() || "\\:<>\"|?*".contains(ch)),
            "source_upload_unsafe_path"
        );
        let lower = part.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or("").trim_end_matches(' ');
        let serial_device = stem
            .strip_prefix("com")
            .or_else(|| stem.strip_prefix("lpt"))
            .is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            });
        ensure!(
            !matches!(
                stem,
                "con" | "prn" | "aux" | "nul" | "conin$" | "conout$" | "clock$"
            ) && !serial_device,
            "source_upload_unsafe_path"
        );
        ensure!(
            !lower.starts_with(".env")
                && !matches!(
                    lower.as_str(),
                    "auth.json"
                        | "auth.toml"
                        | "credentials.json"
                        | "credentials.toml"
                        | ".credentials.json"
                        | "oauth.json"
                        | "oauth_tokens.json"
                        | "token.json"
                        | "tokens.json"
                        | "refresh_token"
                        | "refresh-token"
                        | ".netrc"
                        | ".npmrc"
                        | "cookies"
                        | "cookies.sqlite"
                        | ".ssh"
                        | ".aws"
                        | ".git"
                        | "node_modules"
                        | ".venv"
                        | "__pycache__"
                        | "id_rsa"
                        | "id_ed25519"
                )
                && !lower.ends_with(".pem")
                && !lower.ends_with(".key"),
            "source_upload_excluded_file"
        );
    }
    Ok(())
}

struct ManifestWriter(Vec<u8>);
impl Write for ManifestWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > SOURCE_UPLOAD_MANIFEST_MAX_BYTES {
            return Err(std::io::Error::other("source_upload_manifest_budget"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
