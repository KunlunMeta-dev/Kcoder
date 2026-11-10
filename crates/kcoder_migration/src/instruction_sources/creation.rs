//! A new caller may bind ephemeral candidates to one original ordinary capture request.
use super::InstructionSourceSnapshot;
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};

impl InstructionSourceSnapshot {
    /// The original public intent must still bind semantic revision and destination proofs.
    /// This changes only unpublished candidate handles, never parser semantics or source bytes.
    pub fn for_creation(self, request_id: &str) -> Result<Self> {
        self.for_creation_checked(request_id, |_| true)
    }
    pub fn for_creation_checked(
        mut self,
        request_id: &str,
        check: impl FnMut(u64) -> bool,
    ) -> Result<Self> {
        ensure!(
            !self.is_received_instruction(),
            "migration_instruction_received_identity_fixed"
        );
        ensure!(
            uuid::Uuid::parse_str(request_id).is_ok_and(|id| id.to_string() == request_id),
            "migration_invalid_request_reference"
        );
        self.verify_source(check)?;
        let revision = self.semantic_revision()?;
        for candidate in &mut self.candidates {
            let mut hash = Sha256::new();
            hash.update(b"kcoder.migration.instructions.creation-candidate/1\0");
            hash.update(request_id.as_bytes());
            hash.update([0]);
            hash.update(revision.as_bytes());
            hash.update([0]);
            hash.update(candidate.relative_path.as_bytes());
            candidate.id = format!("instruction-{:x}", hash.finalize());
        }
        self.validate_payload()?;
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use crate::instruction_sources::{InstructionSourceGrant, InstructionSourcePolicy};
    use kcoder_config::PrivateDirectory;
    use kcoder_types::migration::MigrationSourceKind;
    #[test]
    fn a_reauthorized_unchanged_source_keeps_one_original_capture_recipe() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let source = root.path().join("source");
        PrivateDirectory::open_or_create(&profile).unwrap();
        std::fs::create_dir_all(source.join(".git")).unwrap();
        std::fs::write(source.join("AGENTS.md"), "Original owned ordinary guide.").unwrap();
        std::fs::write(
            profile.join("trusted-folders.json"),
            serde_json::json!({"trusted":[source],"never":[]}).to_string(),
        )
        .unwrap();
        let capture = || {
            InstructionSourceGrant::capture(&profile, &source, &source, MigrationSourceKind::Codex)
                .unwrap()
                .capture_sources(&InstructionSourcePolicy::default(), |_| true)
                .unwrap()
        };
        let first = capture();
        let again = capture();
        assert_ne!(first.summaries()[0].id, again.summaries()[0].id);
        let request = "5510042a-c490-4c42-9052-576505956400";
        let first = first.for_creation(request).unwrap();
        let again = again.for_creation(request).unwrap();
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&again).unwrap()
        );
        let different = capture()
            .for_creation("0cae8ff1-582c-433e-acfa-05b012ae19a3")
            .unwrap();
        assert_ne!(different.summaries()[0].id, first.summaries()[0].id);
        assert_eq!(
            *different
                .original_bytes(&different.summaries()[0].id)
                .unwrap(),
            *first.original_bytes(&first.summaries()[0].id).unwrap()
        );
        std::fs::write(source.join("AGENTS.md"), "Changed original guide.").unwrap();
        assert!(first.for_creation(request).is_err());
        let changed = capture().for_creation(request).unwrap();
        assert_ne!(changed.summaries()[0].id, again.summaries()[0].id);
        std::fs::rename(&source, source.with_extension("withheld")).unwrap();
        assert!(changed.for_creation(request).is_err());
    }
}
