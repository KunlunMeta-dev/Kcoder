//! Stable recipe identity excludes ephemeral candidate IDs while retaining observed scopes.
use super::{authority::SnapshotRoot, model::*};
use anyhow::{Result, ensure};
use kcoder_types::migration::MigrationSourceKind;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticCandidate<'a> {
    relative_path: &'a str,
    relative_scope: &'a str,
    role: InstructionRole,
    trigger: InstructionTrigger,
    disposition: InstructionDisposition,
    bytes: u64,
    rank: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason_code: Option<&'a str>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Recipe<'a> {
    version: u32,
    root: &'a SnapshotRoot,
    directories: &'a BTreeMap<String, DirectoryObservation>,
    observations: &'a BTreeMap<String, FileObservation>,
    markers: &'a BTreeMap<String, MarkerObservation>,
    candidates: Vec<SemanticCandidate<'a>>,
    complete_launch_chain: bool,
    dynamic_scope_present: bool,
}
impl InstructionSourceSnapshot {
    pub fn source(&self) -> MigrationSourceKind {
        self.root.source()
    }
    /// This identifies the captured static interpretation, not vendor runtime flags,
    /// live policy, target scope, or a grant to read any new source pathname.
    pub fn semantic_revision(&self) -> Result<String> {
        self.validate_payload()?;
        let recipe = Recipe {
            version: self.version,
            root: &self.root,
            directories: &self.directories,
            observations: &self.observations,
            markers: &self.markers,
            candidates: self
                .candidates
                .iter()
                .map(|source| SemanticCandidate {
                    relative_path: &source.relative_path,
                    relative_scope: &source.relative_scope,
                    role: source.role,
                    trigger: source.trigger,
                    disposition: source.disposition,
                    bytes: source.bytes,
                    rank: source.rank,
                    reason_code: source.reason_code.as_deref(),
                })
                .collect(),
            complete_launch_chain: self.complete_launch_chain,
            dynamic_scope_present: self.dynamic_scope_present,
        };
        let mut writer = HashWriter {
            hash: Sha256::new(),
            bytes: 0,
        };
        writer
            .hash
            .update(b"kcoder.migration.instruction-recipe/1\0");
        serde_json::to_writer(&mut writer, &recipe)
            .map_err(|_| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?;
        ensure!(writer.bytes > 0, "migration_instruction_snapshot_invalid");
        Ok(format!("{:x}", writer.hash.finalize()))
    }
}
struct HashWriter {
    hash: Sha256,
    bytes: usize,
}
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        // Existing bounded metadata may expand while JSON-escaped; the body is
        // represented by already-verified hashes rather than copied or re-encoded.
        if self.bytes.saturating_add(bytes.len()) > 64 * 1024 * 1024 {
            return Err(std::io::Error::other(
                "instruction recipe metadata exceeds budget",
            ));
        }
        self.hash.update(bytes);
        self.bytes += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruction_sources::{InstructionSourceGrant, InstructionSourcePolicy};
    use kcoder_config::PrivateDirectory;
    use std::{fs, path::PathBuf};
    struct Fixture {
        _root: tempfile::TempDir,
        profile: PathBuf,
        workspace: PathBuf,
    }
    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let workspace = root.path().join("workspace");
        PrivateDirectory::open_or_create(&profile).unwrap();
        fs::create_dir_all(workspace.join(".git")).unwrap();
        fs::write(
            workspace.join("AGENTS.md"),
            "Preserve the project examples.\n",
        )
        .unwrap();
        fs::write(
            profile.join("trusted-folders.json"),
            serde_json::to_vec(&serde_json::json!({"trusted":[workspace],"never":[]})).unwrap(),
        )
        .unwrap();
        Fixture {
            _root: root,
            profile,
            workspace,
        }
    }
    fn capture(f: &Fixture) -> InstructionSourceSnapshot {
        InstructionSourceGrant::capture(
            &f.profile,
            &f.workspace,
            &f.workspace,
            MigrationSourceKind::Codex,
        )
        .unwrap()
        .capture_sources(&InstructionSourcePolicy::default(), |_| true)
        .unwrap()
    }
    #[test]
    fn fresh_opaque_ids_do_not_change_the_same_static_recipe_identity() {
        let f = fixture();
        let first = capture(&f);
        let second = capture(&f);
        assert_ne!(first.summaries()[0].id, second.summaries()[0].id);
        assert_eq!(
            first.semantic_revision().unwrap(),
            second.semantic_revision().unwrap()
        );
        assert_eq!(first.source(), MigrationSourceKind::Codex);
        fs::write(
            f.workspace.join("AGENTS.override.md"),
            "An explicitly observed override.\n",
        )
        .unwrap();
        assert_ne!(
            first.semantic_revision().unwrap(),
            capture(&f).semantic_revision().unwrap()
        );
    }
    #[test]
    fn offline_identity_is_not_new_source_permission_or_refresh() {
        let f = fixture();
        let snapshot = capture(&f);
        let original = snapshot.semantic_revision().unwrap();
        fs::rename(
            f.workspace.join("AGENTS.md"),
            f.workspace.join("withheld.md"),
        )
        .unwrap();
        assert_eq!(snapshot.semantic_revision().unwrap(), original);
        assert!(snapshot.verify_source(|_| true).is_err());
    }
}
