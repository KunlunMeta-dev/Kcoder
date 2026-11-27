//! Explicit instruction grants feed the ordinary immutable asset batch.
use super::*;
use kcoder_migration::{
    asset_sources::AssetBundleBinding,
    batch::BatchSource,
    instruction_sources::{InstructionSourceGrant, InstructionSourcePolicy},
    store::{
        BatchCaptureInput, BatchCreateIntent, BatchCreationStage as Stage,
        BatchCreationWorkerState as Worker,
    },
};
use kcoder_types::migration::MigrationSourceKind;
use serde_json::json;
#[path = "instructions/creation.rs"]
pub(super) mod creation;
#[path = "instructions/intent.rs"]
mod intent;
#[path = "instructions/saved.rs"]
mod saved;
#[path = "instructions/selection.rs"]
mod selection;
#[path = "instructions/source_format.rs"]
mod source_format;
pub(super) use saved::saved;

pub(super) fn create(guide: &Guide<'_>, args: &MigrationGuideArgs) -> Result<Option<MigrationJob>> {
    let request = guide.io.text(
        "instruction_request_id",
        "Original capture request UUID (leave blank to create; read existing requests first; incomplete capture requires separate explicit reauthorization)",
        None,
    )?;
    let request = if request.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        request
    };
    ensure!(
        uuid::Uuid::parse_str(&request).is_ok_and(|id| id.to_string() == request),
        "migration_invalid_request_reference"
    );
    let context = guide.fresh()?;
    let store = MigrationStore::open_or_create(&context.profile)?;
    let previous = match store.read_batch_creation(&request) {
        Ok(observation)
            if observation.stage == Stage::Capturing
                && observation.worker_state == Worker::Stopped =>
        {
            if !guide.io.yes("instruction_revalidate", "The original request is not fully archived. Explicitly reauthorize its original source and check the identical selection and target identity? Changes to content or mappings are rejected; no replacement request is created.")? {
                return creation::recover(guide,&request);
            }
            Some(observation)
        }
        Ok(_) => {
            ensure!(
                guide.initial_resources.is_none(),
                "migration_resource_limits_create_only"
            );
            return creation::recover(guide, &request);
        }
        Err(error) if error.to_string() == "migration_batch_creation_unavailable" => None,
        Err(error) => return Err(error),
    };
    let static_v2 = source_format::choose(guide, previous.is_some())?;
    let source = match args.source {
        Some(MigrationSourceArg::Codex) => MigrationSourceKind::Codex,
        Some(MigrationSourceArg::ClaudeCode) => MigrationSourceKind::ClaudeCode,
        None => loop {
            match guide
                .io
                .text(
                    "instruction_source",
                    "Source format: codex or claude-code. Only fixed static files are interpreted; source programs are not executed.",
                    None,
                )?
                .as_str()
            {
                "codex" => break MigrationSourceKind::Codex,
                "claude-code" => break MigrationSourceKind::ClaudeCode,
                _ => guide.io.notice(
                    "migration_guide_invalid_selection",
                    "Choose codex or claude-code.",
                )?,
            }
        },
    };
    guide.io.notice("migration_instruction_static_boundary", "Only known static instructions within explicitly authorized directories are inspected. Unauthorized parent directories are not read. This does not represent runtime env, CLI, managed configuration or dynamic shell loading. Unobserved ancestor chains and semantics remain pending, not global system instructions.")?;
    let root = PathBuf::from(guide.io.text(
        "instruction_root",
        "Explicitly authorized source root (absolute path; must already be trusted; parent directories are not automatically authorized)",
        None,
    )?);
    let cwd = PathBuf::from(guide.io.text(
        "instruction_cwd",
        "Source startup directory (must be inside that root; authorized separately from the target workspace)",
        root.to_str(),
    )?);
    ensure!(
        guide.io.yes(
            "instruction_source_consent",
            "Inspect this source root and startup directory for static instructions with read-only access? The source is not modified and its content is not executed."
        )?,
        "migration_instruction_not_selected"
    );
    let include_descendants = guide.io.yes("instruction_descendants", "Inspect descendant instructions within the authorized root? Their original on-read/on-cwd scope is preserved; descendant instructions do not become global instructions.")?;
    if static_v2 {
        source_format::confirm(guide)?;
    }
    let grant = InstructionSourceGrant::capture(&context.profile, &root, &cwd, source)?;
    let policy = InstructionSourcePolicy {
        include_descendants,
        ..Default::default()
    };
    let captured = if static_v2 {
        grant.capture_static_sources(&policy, true, |_| guide.io.active().is_ok())?
    } else {
        grant.capture_sources(&policy, |_| guide.io.active().is_ok())?
    };
    let snapshot = Arc::new(captured.for_creation(&request)?);
    let selected = selection::choose(guide, &snapshot)?;
    if selected.is_empty() {
        return Ok(None);
    }
    let subset = if snapshot.complete_launch_chain() {
        false
    } else {
        ensure!(guide.io.yes("instruction_incomplete_chain", "Ancestors outside the authorized root were not observed. This batch can only be saved as a pending snapshot and cannot currently be enabled as a complete instruction chain. Retain the originals and mappings anyway?")?, "migration_instruction_not_selected");
        true
    };
    let target = guide.fresh()?;
    let policy = intent::CapturePolicy {
        include_descendants,
        static_subset: subset,
        resource_limits: guide.initial_resources.clone().unwrap_or_default(),
    };
    let intent = intent::original(
        &request,
        &target,
        &snapshot,
        (&root, &cwd),
        &selected,
        &policy,
    )?;
    guide.io.state("instruction_capture", &json!({"requestId":request,"sourceFormat":snapshot.format_revision(),"targetWorkspace":target.cwd,"selectedItems":selected.len(),"completeLaunchChain":snapshot.complete_launch_chain(),"enabledAfterImport":false}))?;
    ensure!(
        guide.io.text(
            "instruction_capture_confirm",
            "Enter CAPTURE to archive selected sources and target mappings in one ordinary batch; this does not publish or enable content.",
            None
        )? == "CAPTURE",
        "migration_instruction_not_selected"
    );
    guide.fresh()?;
    let resolve = |check: &mut dyn FnMut(u64) -> bool| {
        ensure!(check(0), "migration_cancelled");
        let binding = AssetBundleBinding::capture_mapped_instructions(
            &target.profile,
            &target.cwd,
            snapshot,
            &selected,
            subset,
        )?;
        Ok(BatchCaptureInput {
            sources: vec![BatchSource::Assets(binding)],
            resource_limits: policy.resource_limits.clone(),
            project: None,
        })
    };
    let mut progress = |_, _| guide.io.active().is_ok();
    let result = if let Some(previous) = previous {
        store.lookup_batch_creation(&intent).and_then(|current| {
            let current =
                current.ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unavailable"))?;
            ensure!(
                current.stage == Stage::Capturing
                    && current.worker_state == Worker::Stopped
                    && current.control_revision == previous.control_revision,
                "migration_revision_conflict"
            );
            let revision = current
                .control_revision
                .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
            let resumed = store.resume_batch_creation(
                &intent,
                &uuid::Uuid::new_v4().to_string(),
                revision,
            )?;
            store.continue_batch_creation(
                &intent,
                resumed
                    .control_revision
                    .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?,
                resolve,
                &mut progress,
            )
        })
    } else {
        store.create_batch_scan_idempotent(&intent, resolve, &mut progress)
    };
    if let Err(error) = result {
        guide.io.notice(
            &safe_error(&error),
            "Capture was not treated as successful. Read only the same request and preserve confirmed progress.",
        )?;
    }
    creation::recover(guide, &request)
}
