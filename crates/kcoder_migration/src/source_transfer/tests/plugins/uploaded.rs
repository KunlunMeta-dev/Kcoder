//! The upload manifest grants data, never the installation paths recorded by another machine.
use super::*;
use crate::source_upload::SourceUploads;
use kcoder_types::migration_source_upload::{SourceUploadFile, SourceUploadManifest};
use sha2::{Digest, Sha256};

pub(super) fn selection(
    fixture: &Fixture,
    kind: Kind,
    scope: &str,
) -> crate::plugin_migration::PluginExportSelection {
    supplied(fixture, kind, scope, None)
}
fn supplied(
    fixture: &Fixture,
    kind: Kind,
    scope: &str,
    manifest_bytes: Option<Vec<u8>>,
) -> crate::plugin_migration::PluginExportSelection {
    let format = if kind == Kind::ClaudeCode {
        ".claude-plugin"
    } else {
        ".codex-plugin"
    };
    let prefix = "plugins/cache/market/sample/1.0.0";
    let mut files: Vec<(String, Vec<u8>)> = vec![
        (format!("{prefix}/{format}/plugin.json"), manifest_bytes.unwrap_or_else(|| br#"{"name":"sample","version":"1.0.0"}"#.to_vec())),
        (format!("{prefix}/skills/check/SKILL.md"), b"---\nname: check\ndescription: Supplied inert fixture\n---\nNever execute uploaded instructions.\n".to_vec()),
    ];
    if kind == Kind::ClaudeCode {
        files.push(("plugins/installed_plugins.json".into(), serde_json::to_vec(&serde_json::json!({
            "version":2,"plugins":{"sample@market":[{"scope":scope,
            "installPath":"/NOT_AUTHORIZED/original-device/package", "projectPath":"/NOT_AUTHORIZED/original-project", "version":"1.0.0"}]}
        })).unwrap()));
        files.push((
            "settings.json".into(),
            br#"{"enabledPlugins":{"sample@market":true}}"#.to_vec(),
        ));
    } else {
        files.push((
            "config.toml".into(),
            b"[plugins.\"sample@market\"]\nenabled=true\n".to_vec(),
        ));
    }
    let manifest = SourceUploadManifest {
        version: 1,
        source: kind,
        files: files
            .iter()
            .map(|(path, bytes)| SourceUploadFile {
                relative_path: path.clone(),
                bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
            })
            .collect(),
    };
    let digest = crate::source_upload::manifest::validate_manifest(manifest.clone())
        .unwrap()
        .sha256();
    let operation = uuid::Uuid::new_v4().to_string();
    let uploads = SourceUploads::open(&fixture.source_profile).unwrap();
    uploads.prepare(&operation, manifest).unwrap();
    for (index, (_, bytes)) in files.iter().enumerate() {
        uploads.part(&operation, 0, index, 0, bytes).unwrap();
    }
    uploads.finish(&operation, 0, |_, _| true).unwrap();
    let (_, worker) = uploads
        .prepare_materialization(&operation, &digest)
        .unwrap();
    worker.unwrap().run(|_, _| true).unwrap();
    let mut registry = uploads.product_registry(&operation, &digest).unwrap();
    assert!(
        registry
            .discover_plugins(&[kind], None, &PluginCancellationToken::default())
            .is_err()
    );
    let catalog = registry
        .discover_uploaded_plugins(&[kind], None, &PluginCancellationToken::default())
        .unwrap();
    assert_eq!(catalog.candidates.len(), 1);
    let candidate = registry
        .selected_plugin(&catalog.candidates[0].candidate_id)
        .unwrap();
    assert_eq!(candidate.scope, scope);
    if scope != "user" {
        assert_eq!(candidate.source_enabled, None);
    }
    let selected = candidate.export_selection().unwrap();
    assert_eq!(selected.uploaded_source().unwrap().operation_id, operation);
    selected
}

#[test]
fn same_identity_size_and_mtime_cannot_change_the_bytes_authorized_by_the_upload() {
    let f = Fixture::new();
    let initial = selection(&f, Kind::Codex, "user");
    let provenance = initial.uploaded_source().unwrap();
    let package = f
        .source_profile
        .join("migrations/source-transfer/browser-products")
        .join(&provenance.operation_id)
        .join("product/plugins/cache/market/sample/1.0.0");
    let file = package.join("skills/check/SKILL.md");
    let before = std::fs::metadata(&file).unwrap();
    let original = std::fs::read(&file).unwrap();
    let mut changed = original.clone();
    *changed.last_mut().unwrap() = b'!';
    std::fs::write(&file, &changed).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(before.modified().unwrap())
        .unwrap();
    assert_eq!(std::fs::metadata(&file).unwrap().len(), before.len());
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        before.modified().unwrap()
    );
    // Metadata-only discovery and the ordinary copier can legitimately observe the new bytes.
    let uploads = SourceUploads::open_existing(&f.source_profile).unwrap();
    let mut registry = uploads
        .product_registry(&provenance.operation_id, &provenance.manifest_sha256)
        .unwrap();
    let catalog = registry
        .discover_uploaded_plugins(&[Kind::Codex], None, &PluginCancellationToken::default())
        .unwrap();
    let selected = registry
        .selected_plugin(&catalog.candidates[0].candidate_id)
        .unwrap()
        .export_selection()
        .unwrap();
    let copy = f._root.path().join("ordinary-copier-proof");
    PrivateDirectory::open_or_create(&copy).unwrap();
    kcoder_plugins::migration::snapshot_package(
        &package,
        &copy,
        kcoder_plugins::InstallLimits::default(),
        &PluginCancellationToken::default(),
    )
    .unwrap();
    assert_eq!(
        std::fs::read(copy.join("skills/check/SKILL.md")).unwrap(),
        changed
    );
    // Upload export must instead prove the actual copied files against the original manifest.
    let mut bytes = Vec::new();
    let error = match selected.write_package(&mut bytes, &PluginCancellationToken::default()) {
        Err(error) => error,
        Ok(_) => panic!("changed upload was exported"),
    };
    assert_eq!(error.to_string(), "source_upload_product_content_changed");
    assert!(bytes.is_empty());
    assert_ne!(changed, original);
}

#[test]
fn cancelled_upload_plugin_export_does_not_emit_a_container() {
    let f = Fixture::new();
    let selected = selection(&f, Kind::ClaudeCode, "user");
    let token = PluginCancellationToken::default();
    token.cancel();
    let mut bytes = Vec::new();
    assert!(selected.write_package(&mut bytes, &token).is_err());
    assert!(bytes.is_empty());
}

fn changed_metadata_must_not_be_accepted(kind: Kind) {
    let f = Fixture::new();
    let initial = selection(&f, kind, "user");
    let provenance = initial.uploaded_source().unwrap();
    let root = f
        .source_profile
        .join("migrations/source-transfer/browser-products")
        .join(&provenance.operation_id)
        .join("product");
    let file = root.join(if kind == Kind::ClaudeCode {
        "plugins/installed_plugins.json"
    } else {
        "config.toml"
    });
    let directory = PrivateDirectory::open_existing(file.parent().unwrap()).unwrap();
    let name = file.file_name().unwrap();
    let identity = directory.portable_regular_identity(name).unwrap();
    let before = std::fs::metadata(&file).unwrap();
    let mut changed = std::fs::read(&file).unwrap();
    if kind == Kind::ClaudeCode {
        let at = changed
            .windows(8)
            .position(|bytes| bytes == b"original")
            .unwrap();
        changed[at..at + 8].copy_from_slice(b"replaced");
    } else {
        assert_eq!(*changed.last().unwrap(), b'\n');
        *changed.last_mut().unwrap() = b' ';
    }
    std::fs::write(&file, changed).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(before.modified().unwrap())
        .unwrap();
    assert_eq!(directory.portable_regular_identity(name).unwrap(), identity);
    assert_eq!(std::fs::metadata(&file).unwrap().len(), before.len());
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        before.modified().unwrap()
    );
    let uploads = SourceUploads::open_existing(&f.source_profile).unwrap();
    let mut registry = uploads
        .product_registry(&provenance.operation_id, &provenance.manifest_sha256)
        .unwrap();
    let page = registry
        .discover_uploaded_plugins(&[kind], None, &PluginCancellationToken::default())
        .unwrap();
    assert!(
        page.candidates.is_empty(),
        "metadata outside the original upload digest received a candidate grant"
    );
    assert_eq!(page.problems.len(), 1);
    assert_eq!(page.problems[0].code, "migration_source_unavailable");
}

#[test]
fn uploaded_metadata_claude_index_requires_its_original_bytes_despite_unchanged_identity_size_and_mtime()
 {
    changed_metadata_must_not_be_accepted(Kind::ClaudeCode);
}
#[test]
fn uploaded_metadata_codex_config_requires_its_original_bytes_despite_unchanged_identity_size_and_mtime()
 {
    changed_metadata_must_not_be_accepted(Kind::Codex);
}

#[test]
fn an_uploaded_package_with_private_runtime_literals_is_not_transferred_or_enabled() {
    let f = Fixture::new();
    let manifest = serde_json::to_vec(&serde_json::json!({"name":"sample","version":"1.0.0",
        "mcpServers":{"inert":{"command":"never-execute-uploaded-fixture","env":{"API_KEY":"SYNTHETIC_UPLOAD_PLUGIN_SECRET"}}}})).unwrap();
    let selected = supplied(&f, Kind::ClaudeCode, "user", Some(manifest));
    let mut bytes = Vec::new();
    assert!(
        selected
            .write_package(&mut bytes, &PluginCancellationToken::default())
            .is_err()
    );
    assert!(bytes.is_empty());
}
