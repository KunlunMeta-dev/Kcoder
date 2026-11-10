//! Harness-only fixture: publish a real legacy archive without altering the selected job.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    history_jobs::HistoryJobStore, history_normalization::LEGACY_HISTORY_NORMALIZATION_REVISION,
    history_sources::HistorySourceBinding,
};
use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::external_history::{HistoryImportJobView, HistoryImportStage};
use std::{ffi::OsStr, io::Read, path::Path};

pub(super) fn from_job(profile: &Path, source: &str) -> Result<HistoryImportJobView> {
    ensure!(
        profile.is_absolute(),
        "fixture profile must be explicit and absolute"
    );
    ensure!(
        uuid::Uuid::parse_str(source).is_ok_and(|id| id.to_string() == source),
        "invalid fixture source job"
    );
    let jobs = HistoryJobStore::open_existing(profile)?.context("owned history store missing")?;
    let original = jobs.read(source)?;
    ensure!(original.archived, "fixture source must already be archived");
    let directory = PrivateDirectory::open_existing(&profile.join("migrations/history"))?;
    directory.verify_private_directory()?;
    let name = format!("{source}.json");
    let original_bytes = read(&directory, &name)?;
    let template: serde_json::Value = serde_json::from_slice(&original_bytes)
        .map_err(|_| anyhow::anyhow!("invalid owned fixture source journal"))?;
    let binding: HistorySourceBinding = serde_json::from_value(
        template
            .get("binding")
            .context("fixture source binding missing")?
            .clone(),
    )
    .map_err(|_| anyhow::anyhow!("invalid owned fixture binding"))?;
    let owner = template
        .get("owner")
        .and_then(serde_json::Value::as_str)
        .context("fixture owner missing")?;
    let binding_sha = template
        .get("bindingSha256")
        .and_then(serde_json::Value::as_str)
        .context("fixture binding digest missing")?;
    let id = uuid::Uuid::new_v4().to_string();
    let archives =
        ExternalHistoryStore::open_existing(profile)?.context("owned archive store missing")?;
    // The compatibility method really uses legacy begin/binding1; changing only a v3
    // journal ID could never grant the new ID another operation's managed birth.
    let committed = binding.archive(&archives, &id, &mut |_| true)?;
    let view = HistoryImportJobView {
        job_id: id.clone(),
        sequence: 0,
        source: original.source,
        stage: HistoryImportStage::Failed,
        archive_id: Some(committed.receipt.archive_id),
        archived: true,
        normalization: None,
        failure_code: Some("history_normalization_legacy_fixture".into()),
        cancel_requested: false,
    };
    let saved = serde_json::json!({"version":1,"owner":owner,"binding":binding,
        "bindingSha256":binding_sha,"normalizationRevision":LEGACY_HISTORY_NORMALIZATION_REVISION,
        "archiveStageCompleted":true,"view":view});
    let bytes = serde_json::to_vec(&saved)?;
    ensure!(bytes.len() <= 128 * 1024, "fixture journal budget exceeded");
    // Old job writers held this existing step fence; an owned fixture must
    // reproduce it rather than make production recovery fabricate a missing lock.
    let _legacy_runner = directory
        .try_exclusive_lock(OsStr::new(&format!("{id}.run.lock")))?
        .context("owned legacy fixture step fence busy")?;
    directory.atomic_publish_from_reader(
        OsStr::new(&format!("{id}.json")),
        &mut &bytes[..],
        false,
        || Ok(None),
    )?;
    ensure!(
        read(&directory, &name)? == original_bytes,
        "original fixture journal changed"
    );
    let observed = jobs.read(&id)?;
    ensure!(observed == view, "legacy fixture failed canonical readback");
    Ok(observed)
}
fn read(directory: &PrivateDirectory, name: &str) -> Result<Vec<u8>> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(
        file.metadata()?.len() <= 128 * 1024,
        "fixture journal budget exceeded"
    );
    let mut bytes = Vec::new();
    file.take(128 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 128 * 1024, "fixture journal budget exceeded");
    Ok(bytes)
}
