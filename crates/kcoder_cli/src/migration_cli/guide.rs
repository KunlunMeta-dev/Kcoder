//! A guided terminal client reuses native plans, checkpoints and receipts without model execution.
use super::{context::Context, *};
use crate::cli_args::MigrationGuideArgs;
use kcoder_config::PrivateDirectory;
use kcoder_migration::store::MigrationJob;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
#[path = "guide/create.rs"]
mod create;
#[path = "guide/definitions.rs"]
mod definitions;
#[path = "guide/entry.rs"]
mod entry;
#[path = "guide/history_sources.rs"]
mod history_sources;
#[path = "guide/instructions.rs"]
mod instructions;
#[path = "guide/io.rs"]
mod io;
#[path = "guide/layer_report.rs"]
mod layer_report;
#[path = "guide/memory.rs"]
mod memory;
#[path = "guide/operations.rs"]
mod operations;
#[path = "guide/plugin_sources.rs"]
mod plugin_sources;
#[path = "guide/progress.rs"]
mod progress;
#[path = "guide/project_mcp.rs"]
mod project_mcp;
#[path = "guide/projects.rs"]
mod projects;
#[path = "guide/selection.rs"]
mod selection;
#[path = "guide/settings_scope.rs"]
mod settings_scope;
#[path = "guide/source_views.rs"]
mod source_views;
#[path = "guide/view.rs"]
mod view;
pub(super) use io::GuideIo;
pub(super) use io::safe_error;

struct Guide<'a> {
    context: Context,
    overlays: &'a [PathBuf],
    identity: String,
    io: GuideIo,
    cancelled: Arc<AtomicBool>,
    initial_resources: Option<kcoder_types::migration_resource::MigrationResourceLimits>,
}
impl Guide<'_> {
    fn fresh(&self) -> Result<Context> {
        self.io.active()?;
        let context = Context::open(
            &self.context.profile,
            Some(&self.context.cwd),
            self.overlays,
        )?;
        ensure!(
            context.profile == self.context.profile
                && context.cwd == self.context.cwd
                && PrivateDirectory::open_existing(&context.profile)?.directory_identity()?
                    == self.identity,
            "migration_guide_owner_changed"
        );
        Ok(context)
    }
    fn store(&self) -> Result<MigrationStore> {
        self.fresh()?;
        MigrationStore::open_existing(&self.context.profile)
    }
    fn show(&self, job: &MigrationJob) -> Result<()> {
        self.io.state("state", &view::summary(job))
    }
    fn execute(&mut self, args: &MigrationGuideArgs) -> Result<()> {
        self.io.notice("migration_guide_local_only","本地迁移不会请求模型或执行来源 CLI、MCP、Hook。凭证只选择已有来源并明确同意，任何提示都不要求填写密钥正文。")?;
        self.io.state("target",&serde_json::json!({"profileDirectory":self.context.profile,"workspaceDirectory":self.context.cwd}))?;
        let selected_entry = if let Some(id) = &args.job_id {
            entry::Entry::Existing(id.clone())
        } else if args.source.is_some()
            || args.source_home.is_some()
            || args.include_history
            || args.include_plugins
            || args.include_memory
            || args.include_definitions
            || args.target_scope.is_some()
            || !args.plugin_operations.is_empty()
        {
            entry::Entry::New {
                history: args.include_history,
                plugins: args.include_plugins,
                memory: args.include_memory,
                definitions: args.include_definitions,
            }
        } else {
            entry::choose(self)?
        };
        ensure!(
            self.initial_resources.is_none()
                || !matches!(
                    &selected_entry,
                    entry::Entry::Existing(_) | entry::Entry::Creation
                ),
            "migration_resource_limits_create_only"
        );
        let mut job = match selected_entry {
            entry::Entry::Existing(id) => self.store()?.read(&id)?,
            entry::Entry::ReadyPlugin(source) => {
                let scope = settings_scope::choose(self, args)?;
                settings_scope::save(self, vec![*source], scope)?
            }
            entry::Entry::Quit => return Ok(()),
            entry::Entry::Projects => match projects::create(self, args)? {
                Some(job) => job,
                None => return Ok(()),
            },
            entry::Entry::Instructions => match instructions::create(self, args)? {
                Some(job) => job,
                None => return Ok(()),
            },
            entry::Entry::Creation => match instructions::creation::open(self)? {
                Some(job) => job,
                None => return Ok(()),
            },
            entry::Entry::New {
                history,
                plugins,
                memory,
                definitions,
            } => create::run(self, args, history, plugins, memory, definitions)?,
        };
        if job.batch.is_none() {
            self.show(&job)?;
            self.io.notice("migration_guide_legacy_provider_record","这是早期单项连接记录。可用 status 阅读；按原 planId 与 sequence 显式使用 apply-provider 或 rollback-provider，不转换或重建旧作业。")?;
            return Ok(());
        }
        self.show(&job)?;
        loop {
            self.io.active()?;
            let planned = job.batch.as_ref().is_some_and(|b| b.plan_id.is_some());
            let answer = self.io.ask(
                "menu",
                "选择操作；查看不代表提交。退出后可用 configure --job-id 重新打开本记录。",
                serde_json::json!([
                    {"value":"select","label":"分页选择、映射与生成预览"},
                    {"value":"results","label":"回读权威状态与分页结果"},
                    {"value":"layers","label":"查看原记录的设置层次报告"},
                    {"value":"projects","label":"查看原项目出处和保存的目标映射"},
                    {"value":"definitions","label":"预览待处理的Agent/Hook定义（不会执行）"},
                    {"value":"instructions","label":"预览已封存指令原文（不会启用）"},
                    {"value":"apply","label":"明确确认首次提交"},
                    {"value":"resume","label":"按原回执明确恢复"},
                    {"value":"undo","label":"检查后明确撤销"},
                    {"value":"quit","label":"退出并保留原记录"}
                ]),
                Some(if planned { "results" } else { "select" }),
            )?;
            let outcome = match answer.as_str() {
                "quit" => {
                    self.show(&self.store()?.read(&job.job_id)?)?;
                    return Ok(());
                }
                "select" => selection::choose(self, &job).and_then(|params| {
                    if let Some(mut selected) = params {
                        if let Some(host) = selected.project_host.as_mut() {
                            host.plan(&selected.params).map(Some)
                        } else {
                            planning::prepare(&self.fresh()?, &selected.params).map(Some)
                        }
                    } else {
                        Ok(None)
                    }
                }),
                "results" => operations::results(self, &job).map(|_| None),
                "layers" => layer_report::saved(self, &job).map(|_| None),
                "projects" => projects::saved(self, &job).map(|_| None),
                "definitions" => definitions::saved(self, &job).map(|_| None),
                "instructions" => instructions::saved(self, &job).map(|_| None),
                "apply" | "resume" | "undo" => operations::operate(self, &job, &answer).map(Some),
                _ => {
                    self.io.notice(
                        "migration_guide_invalid_selection",
                        "未识别的操作，未修改目标。",
                    )?;
                    Ok(None)
                }
            };
            match outcome {
                Ok(Some(updated)) => job = updated,
                Ok(None) => {}
                Err(error) => {
                    // An error or lost acknowledgement is observation-only, never an implicit retry.
                    self.io.notice(
                        &safe_error(&error),
                        "操作未被当作成功；先回读同一记录，不分配新请求猜测结果。",
                    )?;
                    job = self.store()?.read(&job.job_id)?;
                    self.show(&job)?;
                    self.io.active()?;
                    continue;
                }
            }
            job = self.store()?.read(&job.job_id)?;
            self.show(&job)?;
        }
    }
}
pub(super) fn run(
    args: &MigrationGuideArgs,
    cwd: Option<&Path>,
    overlays: &[PathBuf],
) -> Result<()> {
    let initial_resources = args.resources.limits()?;
    let context = Context::open(&args.target_profile, cwd, overlays)?;
    let identity = PrivateDirectory::open_existing(&context.profile)?.directory_identity()?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(2)
        .enable_all()
        .build()?;
    let signal_cancel = cancelled.clone();
    let signal = runtime.spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancel.store(true, Ordering::Release);
        }
    });
    let result = runtime.block_on(async {
        tokio::task::block_in_place(|| {
            let io = GuideIo::open(args.jsonl, cancelled.clone())?;
            Guide {
                context,
                overlays,
                identity,
                io,
                cancelled,
                initial_resources,
            }
            .execute(args)
        })
    });
    signal.abort();
    result.map_err(|e| anyhow::anyhow!(safe_error(&e)))
}
