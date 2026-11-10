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
        "原始捕获请求 UUID（留空新建；已有请求先回读，未完整捕获须另行明确重新授权）",
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
            if !guide.io.yes("instruction_revalidate", "原请求尚未完整封存。是否重新明确授权原来源并核对完全相同的选择与目标身份？改变内容或映射会被拒绝；不会创建替代请求。")? {
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
                    "来源格式：codex 或 claude-code。只解释固定静态文件，不执行来源程序。",
                    None,
                )?
                .as_str()
            {
                "codex" => break MigrationSourceKind::Codex,
                "claude-code" => break MigrationSourceKind::ClaudeCode,
                _ => guide.io.notice(
                    "migration_guide_invalid_selection",
                    "请选择 codex 或 claude-code。",
                )?,
            }
        },
    };
    guide.io.notice("migration_instruction_static_boundary", "仅检查明确授权目录内的已知静态指令。不会读取授权外父目录；不代表来源运行时的 env、CLI、managed 配置或 shell 动态加载。未覆盖的祖先链和语义保留为待处理，不提升为全局系统指令。")?;
    let root = PathBuf::from(guide.io.text(
        "instruction_root",
        "明确授权的来源根目录（绝对路径；必须已受信任，不会自动授权其父目录）",
        None,
    )?);
    let cwd = PathBuf::from(guide.io.text(
        "instruction_cwd",
        "来源启动目录（必须在上述根内；与目标工作区分别授权）",
        root.to_str(),
    )?);
    ensure!(
        guide.io.yes(
            "instruction_source_consent",
            "是否只读检查该来源根及启动目录的静态指令？不会修改来源或执行其中内容。"
        )?,
        "migration_instruction_not_selected"
    );
    let include_descendants = guide.io.yes("instruction_descendants", "是否检查授权根内子目录的指令？保留原 on-read/on-cwd 触发范围，不把子目录指令变为全局指令。")?;
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
        ensure!(guide.io.yes("instruction_incomplete_chain", "授权根外的祖先链未被观察。这批只能保存为待处理快照，当前不能按完整指令链启用。是否仍保留原件及映射？")?, "migration_instruction_not_selected");
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
            "输入 CAPTURE 确认将所选来源和目标映射封存为同一普通批次；不会发布或启用。",
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
            "未把捕获当作成功；只回读同一请求，保留已确认水位。",
        )?;
    }
    creation::recover(guide, &request)
}
