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
        self.io.notice("migration_guide_local_only","Local migration does not request a model or run source CLIs, MCP or Hooks. Credentials require selecting existing sources with explicit consent; no prompt asks for the credential value.")?;
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
            self.io.notice("migration_guide_legacy_provider_record","This is a legacy single-connection record. Read it with status; explicitly use apply-provider or rollback-provider with the original planId and sequence. Old jobs are not converted or rebuilt.")?;
            return Ok(());
        }
        self.show(&job)?;
        loop {
            self.io.active()?;
            let planned = job.batch.as_ref().is_some_and(|b| b.plan_id.is_some());
            let answer = self.io.ask(
                "menu",
                "Select an operation; viewing does not submit. After exiting, use configure --job-id to reopen this record.",
                serde_json::json!([
                    {"value":"select","label":"Select, map and generate previews by page"},
                    {"value":"results","label":"Read authoritative state and paged results"},
                    {"value":"layers","label":"View the original record settings layer report"},
                    {"value":"projects","label":"View original project provenance and saved target mappings"},
                    {"value":"definitions","label":"Preview pending Agent/Hook definitions (without executing them)"},
                    {"value":"instructions","label":"Preview archived original instructions (without enabling them)"},
                    {"value":"apply","label":"Explicitly confirm the first submission"},
                    {"value":"resume","label":"Explicitly resume using the original receipt"},
                    {"value":"undo","label":"Review and explicitly undo"},
                    {"value":"quit","label":"Exit and retain the original record"}
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
                        "Unrecognized operation; the target was not changed.",
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
                        "The operation was not treated as successful. Read the same record first; do not allocate a new request to guess the result.",
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
