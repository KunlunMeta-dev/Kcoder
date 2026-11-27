use super::*;
use crate::{discovery::ConfigurationBinding, history_sources::HistorySourceBinding};
use kcoder_config::PrivateDirectory;
use kcoder_types::{external_history::*, migration::MigrationSourceKind as Kind};
use sha2::Digest;
use std::{
    ffi::OsStr,
    io::Write,
    path::{Path, PathBuf},
};

mod adoption;
mod asset_identity;
mod attempts;
mod bindings;
mod boundaries;
mod capsules;
mod definitions;
mod instruction_adoption;
mod instruction_seed;
mod instructions;
mod intents;
mod lease_contention;
mod memory;
mod plugins;
mod private_credentials;
mod projects;
mod received;
mod recovery;

struct Fixture {
    _root: tempfile::TempDir,
    source: SourceTransfers,
    target: IncomingTransfers,
    source_profile: PathBuf,
    target_profile: PathBuf,
    files: PathBuf,
    destination: TransferDestination,
    request: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let source_profile = root.path().join("source-profile");
        let target_profile = root.path().join("target-profile");
        let files = root.path().join("selected-source");
        PrivateDirectory::open_or_create(&files).unwrap();
        let source = SourceTransfers::open(&source_profile).unwrap();
        let target = IncomingTransfers::open(&target_profile).unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        let destination = target
            .issue_destination(&request, source.authority())
            .unwrap();
        Self {
            _root: root,
            source,
            target,
            source_profile,
            target_profile,
            files,
            destination,
            request,
        }
    }
    fn config(&self, kind: Kind) -> ConfigurationBinding {
        let (name, body) = match kind {
            Kind::ClaudeCode => (
                "settings.json",
                r#"{"model":"fixture-model","env":{"ANTHROPIC_API_KEY":"SYNTHETIC_PRIVATE_SOURCE_ONLY"},"unknown_future_setting":true}"#,
            ),
            Kind::Codex => (
                "config.toml",
                "model = \"fixture-model\"\nmodel_provider = \"fixture\"\n[model_providers.fixture]\nname = \"fixture\"\nbase_url = \"https://fixture.invalid/v1\"\nwire_api = \"responses\"\nenv_key = \"EXPLICIT_FIXTURE_KEY\"\n",
            ),
        };
        let path = self.files.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::write(
            self.files.join("auth.json"),
            "SYNTHETIC_OAUTH_MUST_NOT_TRANSFER",
        )
        .unwrap();
        ConfigurationBinding::capture_selected(&path, kind).unwrap()
    }
    fn history(&self) -> HistorySourceBinding {
        let file = self.files.join("history.jsonl");
        let mut bytes = serde_json::to_vec(&serde_json::json!({"type":"user","uuid":"first","message":{"role":"user","content":"x".repeat(400_000)}})).unwrap();
        bytes.push(b'\n');
        std::fs::write(&file, bytes).unwrap();
        HistorySourceBinding::capture(
            &self.files,
            Path::new("history.jsonl"),
            ExternalHistoryOrigin {
                source: Kind::ClaudeCode,
                source_instance: "owned-source-machine".into(),
                source_session_id: uuid::Uuid::new_v4().to_string(),
                source_artifact_id: None,
                source_format: "jsonl".into(),
                adapter_revision: "raw/1".into(),
                title: Some("Synthetic source history".into()),
                created_at: None,
                updated_at: None,
                project: None,
                archived: false,
                parent_session_id: None,
            },
            &mut |_, _| true,
        )
        .unwrap()
    }
    fn export(&self, selection: ExportSelection) -> TransferManifest {
        self.source
            .prepare(&self.request, &self.destination, vec![selection])
            .unwrap();
        self.source
            .capture(&self.request, &self.destination, |_| true)
            .unwrap()
    }
    fn copy(&self, manifest: &TransferManifest) -> TransferReceipt {
        self.target
            .begin(manifest, self.source.authority())
            .unwrap();
        for entry in &manifest.entries {
            for index in 0..entry.bytes.div_ceil(TRANSFER_CHUNK_BYTES as u64) as u32 {
                let chunk = self
                    .source
                    .chunk(
                        &self.request,
                        &self.destination,
                        &manifest.digest().unwrap(),
                        &entry.id,
                        index,
                    )
                    .unwrap();
                self.target
                    .write_part(self.source.authority(), &chunk)
                    .unwrap();
            }
        }
        self.target
            .finish(&self.request, self.source.authority(), |_| true)
            .unwrap()
    }
}

#[test]
fn both_configuration_formats_transfer_existing_inventory_without_authentication_originals() {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new();
        let binding = f.config(kind);
        let original = binding.inventory().unwrap();
        let manifest = f.export(ExportSelection::Configuration(binding.clone()));
        assert_eq!(manifest.entries.len(), 1);
        let receipt = f.copy(&manifest);
        let inventory = f
            .target
            .configuration_inventory(
                &f.request,
                f.source.authority(),
                &manifest.entries[0].id,
                &receipt,
            )
            .unwrap();
        assert!(inventory == original);
        if kind == Kind::ClaudeCode {
            assert!(
                inventory.issues.iter().any(|issue| issue.code
                    == kcoder_types::migration::MigrationIssueCode::UnsupportedField)
            );
            assert!(
                inventory.issues.iter().any(|issue| issue.code
                    == kcoder_types::migration::MigrationIssueCode::SecretExcluded)
            );
        }
        assert!(
            matches!(&manifest.entries[0].content, TransferContent::ConfigurationInventory { source_scope, .. } if source_scope == "user")
        );
        let encoded = serde_json::to_string(&inventory).unwrap();
        assert!(
            !encoded.contains("SYNTHETIC_PRIVATE_SOURCE_ONLY")
                && !encoded.contains("SYNTHETIC_OAUTH_MUST_NOT_TRANSFER")
        );
        assert!(
            std::fs::read_to_string(f.files.join("auth.json"))
                .unwrap()
                .contains("SYNTHETIC_OAUTH")
        );
        assert!(!f.target_profile.join("settings.json").exists());
        std::fs::remove_dir_all(&f.files).unwrap();
        // An unknown prepare/finish acknowledgement is reconciled from the same accepted job.
        f.source
            .prepare(
                &f.request,
                &f.destination,
                vec![ExportSelection::Configuration(binding)],
            )
            .unwrap();
        assert!(
            f.source
                .capture(&f.request, &f.destination, |_| true)
                .unwrap()
                == manifest
        );
        let reopened = IncomingTransfers::open(&f.target_profile).unwrap();
        assert_eq!(
            reopened.receipt(&f.request, f.source.authority()).unwrap(),
            Some(receipt)
        );
    }
}

#[test]
fn transferred_history_reuses_original_raw_archive_and_never_an_attachment_supplement() {
    let f = Fixture::new();
    let binding = f.history();
    let expected = binding.snapshot().clone();
    let manifest = f.export(ExportSelection::CapturedHistory(binding));
    let receipt = f.copy(&manifest);
    std::fs::remove_dir_all(&f.files).unwrap();
    let received = f
        .target
        .history_binding(
            &f.request,
            f.source.authority(),
            &manifest.entries[0].id,
            &receipt,
            |_| true,
        )
        .unwrap();
    let mut namespaced = expected.clone();
    namespaced.origin.source_instance = super::model::digest(&(
        "source-transfer.history-origin/1",
        f.source.authority(),
        &expected.origin.source_instance,
    ))
    .unwrap();
    assert!(received.snapshot() == &namespaced);
    assert_ne!(
        received.snapshot().origin.source_instance,
        expected.origin.source_instance
    );
    let archive =
        kcoder_state::external_history::ExternalHistoryStore::open(&f.target_profile).unwrap();
    let committed = received
        .archive(&archive, &uuid::Uuid::new_v4().to_string(), &mut |_| true)
        .unwrap();
    assert_eq!(committed.receipt.source_sha256, expected.source_sha256);
    assert_eq!(committed.receipt.record_count, 1);
    assert!(!f.target_profile.join("sessions").exists());
}

#[test]
fn lost_part_receipt_recovers_only_an_identical_owned_prefix_without_rewriting() {
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::CapturedHistory(f.history()));
    f.target.begin(&manifest, f.source.authority()).unwrap();
    let entry = &manifest.entries[0];
    let chunk = f
        .source
        .chunk(
            &f.request,
            &f.destination,
            &manifest.digest().unwrap(),
            &entry.id,
            0,
        )
        .unwrap();
    let path = f
        .target_profile
        .join("migrations/source-transfer/incoming")
        .join(&f.request);
    let directory = PrivateDirectory::open_existing(&path).unwrap();
    let mut file = directory
        .open_read_write_file(OsStr::new(&super::source::payload_name(entry)), false)
        .unwrap();
    file.write_all(&chunk.bytes()[..8192]).unwrap();
    file.sync_all().unwrap();
    drop(file);
    assert_eq!(
        f.target
            .part_receipt(&f.request, f.source.authority(), &entry.id)
            .unwrap()
            .accepted_parts,
        0
    );
    let first = f.target.write_part(f.source.authority(), &chunk).unwrap();
    let repeated = f.target.write_part(f.source.authority(), &chunk).unwrap();
    assert_eq!(first, repeated);
    assert_eq!(first.accepted_parts, 1);
    let wrong = TransferChunk::received(
        f.request.clone(),
        manifest.digest().unwrap(),
        entry.id.clone(),
        0,
        format!(
            "{:x}",
            sha2::Sha256::digest(vec![b'y'; TRANSFER_CHUNK_BYTES])
        ),
        vec![b'y'; TRANSFER_CHUNK_BYTES],
    )
    .unwrap();
    assert!(f.target.write_part(f.source.authority(), &wrong).is_err());
    f.copy(&manifest);
}

#[test]
fn cancellation_watermarks_survive_restart_and_old_resume_cannot_clear_new_cancellation() {
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::CapturedHistory(f.history()));
    f.target.begin(&manifest, f.source.authority()).unwrap();
    let first = f
        .target
        .cancel(
            &f.request,
            f.source.authority(),
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    assert!(first.cancelled);
    let chunk = f
        .source
        .chunk(
            &f.request,
            &f.destination,
            &manifest.digest().unwrap(),
            &manifest.entries[0].id,
            0,
        )
        .unwrap();
    assert!(f.target.write_part(f.source.authority(), &chunk).is_err());
    let reopened = IncomingTransfers::open(&f.target_profile).unwrap();
    let admission = reopened.admission_state(&f.request).unwrap().unwrap();
    reopened
        .resume_target(&f.request, f.source.authority(), &admission, Some(&first))
        .unwrap();
    let newer = reopened
        .cancel(
            &f.request,
            f.source.authority(),
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    assert!(newer.cancelled && newer.cancel_watermark > first.cancel_watermark);
    assert!(
        reopened
            .resume_target(&f.request, f.source.authority(), &admission, Some(&first))
            .is_err()
    );
    assert!(
        reopened
            .state(&f.request, f.source.authority())
            .unwrap()
            .cancelled
    );
}

#[test]
fn source_changes_and_another_native_account_or_target_grant_do_not_retarget_a_request() {
    let f = Fixture::new();
    let binding = f.config(Kind::ClaudeCode);
    f.source
        .prepare(
            &f.request,
            &f.destination,
            vec![ExportSelection::Configuration(binding)],
        )
        .unwrap();
    std::fs::write(f.files.join("settings.json"), r#"{"model":"changed"}"#).unwrap();
    assert!(
        f.source
            .capture(&f.request, &f.destination, |_| true)
            .is_err()
    );
    assert!(
        f.source
            .manifest(&f.request, &f.destination)
            .unwrap()
            .is_none()
    );
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::Configuration(f.config(Kind::Codex)));
    let peer = SourceTransfers::open(&f._root.path().join("another-native-profile")).unwrap();
    assert!(f.target.begin(&manifest, peer.authority()).is_err());
    let other = IncomingTransfers::open(&f._root.path().join("another-target")).unwrap();
    assert!(other.begin(&manifest, f.source.authority()).is_err());
    let mut changed = manifest.clone();
    changed.destination.scope = "0".repeat(64);
    assert!(f.target.begin(&changed, f.source.authority()).is_err());
    f.target.begin(&manifest, f.source.authority()).unwrap();
    changed = manifest.clone();
    changed.entries[0].sha256 = "0".repeat(64);
    assert!(f.target.begin(&changed, f.source.authority()).is_err());
    assert!(
        SourceTransfers::open(&f.source_profile)
            .unwrap()
            .authority()
            == f.source.authority()
    );
}

#[test]
fn source_cancellation_releases_its_writer_and_requires_explicit_same_job_resume() {
    let f = Fixture::new();
    let binding = f.history();
    f.source
        .prepare(
            &f.request,
            &f.destination,
            vec![ExportSelection::CapturedHistory(binding)],
        )
        .unwrap();
    let command = uuid::Uuid::new_v4().to_string();
    let mut requested = false;
    assert!(
        f.source
            .capture(&f.request, &f.destination, |bytes| {
                if bytes >= 65536 && !requested {
                    requested = true;
                    f.source
                        .cancel(&f.request, &f.destination, &command)
                        .unwrap();
                }
                true
            })
            .is_err()
    );
    let state = f.source.state(&f.request, &f.destination).unwrap();
    assert!(state.cancelled && !state.ready);
    assert!(
        f.source
            .capture(&f.request, &f.destination, |_| true)
            .is_err()
    );
    f.source
        .resume(
            &f.request,
            &f.destination,
            state.sequence,
            state.cancel_watermark,
        )
        .unwrap();
    assert_eq!(
        f.source
            .capture(&f.request, &f.destination, |_| true)
            .unwrap()
            .request_id,
        f.request
    );
}

#[test]
fn transfer_boundaries_reject_escaping_reserved_and_authentication_asset_names() {
    for name in [
        "../escape",
        "/root",
        "C:/absolute",
        "a\\b",
        "a/../b",
        "CON",
        "com1.txt",
        "a.",
        ".env",
        "auth.json",
        "oauth.json",
        "id_ed25519",
    ] {
        assert!(super::model::valid_relative(name).is_err());
    }
    assert!(super::model::valid_relative("资料/guide.md").is_ok());
}

#[test]
fn static_work_assets_keep_source_scope_and_bytes_without_installation_or_native_reference() {
    let f = Fixture::new();
    let file = f.files.join("CLAUDE.md");
    let body = "Synthetic imported instructions, never a current system permission.";
    std::fs::write(&file, body).unwrap();
    let binding = crate::asset_sources::AssetBundleBinding::capture(
        &file,
        Kind::ClaudeCode,
        kcoder_types::migration::MigrationCategory::Instructions,
        kcoder_config::imported_context::ImportedContextScope::Global,
        false,
    )
    .unwrap();
    let manifest = f.export(ExportSelection::Asset {
        binding,
        key: "CLAUDE.md".into(),
    });
    let receipt = f.copy(&manifest);
    let received = f
        .target
        .work_asset(
            &f.request,
            f.source.authority(),
            &manifest.entries[0].id,
            &receipt,
        )
        .unwrap();
    assert_eq!(received.asset.files.len(), 1);
    assert_eq!(received.asset.files[0].content, body.as_bytes());
    assert!(!received.asset.native_reference && !received.asset.files[0].executable);
    assert!(received.source_executable_files.is_empty());
    assert_eq!(std::fs::read_to_string(file).unwrap(), body);
    assert!(
        !f.target_profile.join("imported_context").exists()
            && !f.target_profile.join("skills").exists()
    );
}

mod private_credential_recovery;

mod private_credential_candidates;

mod private_credential_targets;

mod private_credential_source_observation;
