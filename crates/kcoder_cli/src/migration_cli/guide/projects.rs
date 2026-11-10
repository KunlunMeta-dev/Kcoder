//! The local terminal owns one Native host; target catalogs and writes stay in that authority.
use super::*;
use crate::migration_cli::projects as review;
use kcoder_app_protocol::*;
use serde_json::{Value, json};

pub(super) struct Session<'a> {
    guide: &'a Guide<'a>,
    host: super::super::history::rpc::Client,
    targets: Option<String>,
}
impl<'a> Session<'a> {
    pub fn open(guide: &'a Guide<'a>) -> Result<Self> {
        let host = super::super::history::rpc::Client::start(&guide.fresh()?, guide.overlays)?;
        host.require_capability(CAPABILITY_MIGRATION_PROJECTS_V1)?;
        Ok(Self {
            guide,
            host,
            targets: None,
        })
    }
    pub fn choice(&mut self, job: &str, item: &str) -> Result<MigrationBatchChoice> {
        let mut targets = self.targets.take();
        let result = tokio::runtime::Handle::current().block_on(review::mapping(
            &self.guide.io,
            self,
            job,
            item,
            &mut targets,
        ));
        self.targets = targets;
        result
    }
    pub fn plan(&mut self, params: &MigrationBatchPlanParams) -> Result<MigrationJob> {
        let result: MigrationJobReadResult = tokio::runtime::Handle::current()
            .block_on(review::read(self, method::MIGRATION_BATCH_PLAN, params))?;
        ensure!(
            result.job.job_id == params.job_id,
            "migration_project_invalid_response"
        );
        self.guide.store()?.read(&params.job_id)
    }
}
impl review::Client for Session<'_> {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.guide.fresh()?;
        let result = self.host.call(method, params)?;
        self.guide.fresh()?;
        Ok(result)
    }
}
pub(super) fn create(guide: &Guide<'_>, args: &MigrationGuideArgs) -> Result<Option<MigrationJob>> {
    let source = match args.source {
        Some(MigrationSourceArg::ClaudeCode) => {
            kcoder_types::migration::MigrationSourceKind::ClaudeCode
        }
        Some(MigrationSourceArg::Codex) => kcoder_types::migration::MigrationSourceKind::Codex,
        None => match guide
            .io
            .text("source", "选择项目清单来源：claude-code 或 codex。", None)?
            .as_str()
        {
            "claude-code" => kcoder_types::migration::MigrationSourceKind::ClaudeCode,
            "codex" => kcoder_types::migration::MigrationSourceKind::Codex,
            _ => anyhow::bail!("migration_guide_invalid_source"),
        },
    };
    let directory = match &args.source_config_dir {
        Some(path) => super::super::absolute(path, Some(&guide.context.cwd))?
            .to_string_lossy()
            .into_owned(),
        None => guide.io.text(
            "project_source_directory",
            "明确填写本来源产品目录绝对路径；只读已知项目清单，不打开清单记载的项目路径。",
            None,
        )?,
    };
    ensure!(guide.io.yes("project_source_consent","确认只读取该产品目录中的已知项目清单？不扫描其他账户、不迁移认证或工作树，失败不退回默认home。")?,"migration_project_source_not_selected");
    let mut session = Session::open(guide)?;
    session
        .host
        .require_capability(CAPABILITY_MIGRATION_SOURCE_DIRECTORY_V1)?;
    let params:MigrationSourceDirectorySelectParams=serde_json::from_value(json!({"selectionId":uuid::Uuid::new_v4().to_string(),"source":source,"directory":directory})).map_err(|_|anyhow::anyhow!("migration_project_source_unavailable"))?;
    let result: MigrationSourceDirectoryResult =
        tokio::runtime::Handle::current().block_on(review::read(
            &mut session,
            method::MIGRATION_SOURCE_DIRECTORY_SELECT,
            &params,
        ))?;
    ensure!(
        result.selection_id == params.selection_id
            && result.source == source
            && result.remaining_ms > 0,
        "migration_project_invalid_response"
    );
    let selected = tokio::runtime::Handle::current().block_on(review::sources(
        &guide.io,
        &mut session,
        source,
        0,
    ))?;
    if selected.is_empty() {
        return Ok(None);
    }
    let result: MigrationJobReadResult =
        tokio::runtime::Handle::current().block_on(review::read(
            &mut session,
            method::MIGRATION_BATCH_SCAN,
            &MigrationBatchScanParams {
                source_ids: Vec::new(),
                history_sources: Vec::new(),
                plugin_sources: Vec::new(),
                project_sources: selected,
                resource_limits: guide.initial_resources.clone(),
            },
        ))?;
    Ok(Some(guide.store()?.read(&result.job.job_id)?))
}
pub(super) fn saved(guide: &Guide<'_>, job: &MigrationJob) -> Result<()> {
    let mut session = Session::open(guide)?;
    let mut index = 0;
    loop {
        let items = job
            .inventory
            .items
            .iter()
            .filter(|item| {
                item.preview.category == kcoder_types::migration::MigrationCategory::Project
            })
            .collect::<Vec<_>>();
        let rows = items
            .iter()
            .skip(index * 10)
            .take(10)
            .enumerate()
            .map(|(i, item)| json!({"number":i+1,"title":item.preview.source_name}))
            .collect::<Vec<_>>();
        let answer = guide.io.ask(
            "project_saved",
            "选择本页原项目编号查看出处/保存映射；next/prev/back。不会重新发现来源或重试变更。",
            json!({"page":index,"items":rows}),
            Some("back"),
        )?;
        match answer.as_str() {
            "back" => return Ok(()),
            "next" if (index + 1) * 10 < items.len() => index += 1,
            "prev" if index > 0 => index -= 1,
            _ => {
                if let Some(item) = answer
                    .parse::<usize>()
                    .ok()
                    .filter(|n| (1..=10).contains(n))
                    .and_then(|n| items.get(index * 10 + n - 1))
                {
                    tokio::runtime::Handle::current().block_on(review::report(
                        &guide.io,
                        &mut session,
                        &job.job_id,
                        &item.preview.id,
                    ))?;
                } else {
                    guide.io.notice(
                        "migration_project_invalid_selection",
                        "请选择原记录中的项目编号。",
                    )?;
                }
            }
        }
    }
}

pub(super) fn operate(
    guide: &Guide<'_>,
    job: &MigrationJob,
    plan: &str,
    request: &str,
    mode: kcoder_migration::batch::execution::BatchRunMode,
) -> Result<MigrationJob> {
    let mut session = Session::open(guide)?;
    let mode = match mode {
        kcoder_migration::batch::execution::BatchRunMode::Apply => MigrationBatchRunMode::Apply,
        kcoder_migration::batch::execution::BatchRunMode::Resume => MigrationBatchRunMode::Resume,
        kcoder_migration::batch::execution::BatchRunMode::Rollback => {
            MigrationBatchRunMode::Rollback
        }
    };
    tokio::runtime::Handle::current().block_on(async {
        let mut state: MigrationBatchStateResult = review::read(
            &mut session,
            method::MIGRATION_BATCH_RUN,
            &MigrationBatchRunParams {
                job_id: job.job_id.clone(),
                expected_sequence: job.sequence,
                plan_id: plan.into(),
                request_id: request.into(),
                mode,
            },
        )
        .await?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            ensure!(
                state.state.job.job_id == job.job_id,
                "migration_project_invalid_response"
            );
            guide.show(&guide.store()?.read(&job.job_id)?)?;
            if !state.worker_running {
                return guide.store()?.read(&job.job_id);
            }
            ensure!(
                std::time::Instant::now() < deadline,
                "migration_guide_operation_pending"
            );
            guide.io.active()?;
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            state = review::read(
                &mut session,
                method::MIGRATION_BATCH_READ,
                &MigrationOperationParams {
                    job_id: job.job_id.clone(),
                },
            )
            .await?;
        }
    })
}
