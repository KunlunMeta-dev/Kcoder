//! Terminal recovery uses the same durable operations and public projections as Studio.
use super::*;
use super::{context::Context, planning};
use crate::migration_view::{items_result, read_result};
use kcoder_config::{OsCredentialBackend, PrivateDirectory};
use kcoder_migration::{
    assets::AssetTarget,
    credentials::CredentialTarget,
    mcp::McpTarget,
    store::{BatchTargets, CredentialTargets},
};

pub(super) fn print(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

pub(super) fn run(
    action: &MigrationAction,
    cwd: Option<&Path>,
    overlays: &[PathBuf],
) -> Result<()> {
    match action {
        MigrationAction::BatchScan {
            source,
            source_home,
            source_config_dir,
            project,
            configuration_only,
            resources,
            target_profile,
        } => {
            let limits = resources.limits()?;
            let context = Context::open(target_profile, cwd, overlays)?;
            planning::scan(
                *source,
                source_home,
                source_config_dir.as_deref(),
                project.as_deref(),
                *configuration_only,
                limits,
                &context,
            )
        }
        MigrationAction::PlanBatch {
            target_profile,
            options,
        } => {
            let context = Context::open(target_profile, cwd, overlays)?;
            let params = planning::options(options, &context.cwd)?;
            planning::plan(&context, &params)
        }
        MigrationAction::Records {
            target_profile,
            cursor,
        } => {
            let profile = absolute(target_profile, cwd)?;
            PrivateDirectory::open_existing(&profile)?.verify_trusted_config_directory()?;
            let store = match MigrationStore::open_existing(&profile) {
                Ok(store) => store,
                Err(error)
                    if error.chain().any(|error| {
                        error
                            .downcast_ref::<std::io::Error>()
                            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                    }) =>
                {
                    return print(&serde_json::json!({"jobs":[], "nextCursor":null}));
                }
                Err(error) => return Err(error),
            };
            let (records, next_cursor) = store.records(cursor.as_deref())?;
            print(&crate::migration_view::records_result(records, next_cursor))
        }
        MigrationAction::Items {
            target_profile,
            job_id,
            page_index,
            include_templates,
        } => {
            let store = MigrationStore::open_existing(&absolute(target_profile, cwd)?)?;
            let job = store.read(job_id)?;
            let offset = page_index
                .checked_mul(10)
                .ok_or_else(|| anyhow::anyhow!("migration_invalid_cursor"))?;
            let cursor = format!("{}:{}:{offset}", job.job_id, job.sequence);
            let mut result = items_result(&job, Some(&cursor), None)?;
            if *include_templates {
                crate::migration_view::include_template_candidates(&job, &mut result);
            }
            print(&result)
        }
        MigrationAction::Cancel {
            target_profile,
            job_id,
            expected_sequence,
        } => {
            let store = MigrationStore::open_existing(&absolute(target_profile, cwd)?)?;
            print(&read_result(&store.cancel(job_id, *expected_sequence)?))
        }
        MigrationAction::ApplyBatch {
            target_profile,
            job_id,
            plan_id,
            request_id,
            expected_sequence,
        }
        | MigrationAction::ResumeBatch {
            target_profile,
            job_id,
            plan_id,
            request_id,
            expected_sequence,
        }
        | MigrationAction::RollbackBatch {
            target_profile,
            job_id,
            plan_id,
            request_id,
            expected_sequence,
        } => {
            let context = Context::open(target_profile, cwd, overlays)?;
            let store = MigrationStore::open_existing(&context.profile)?;
            let job = store.read(job_id)?;
            for action in &job
                .batch
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?
                .actions
            {
                if let kcoder_migration::batch::BatchActionKind::Settings { plan } = &action.action
                {
                    for step in &plan.steps {
                        match step {
                            kcoder_migration::batch::settings::SettingsStep::Provider(_) => {
                                super::settings_targets::writable(&context, &job, &["providers"])?
                            }
                            kcoder_migration::batch::settings::SettingsStep::Mcp(_) => {
                                super::settings_targets::writable(
                                    &context,
                                    &job,
                                    &["mcp_servers", "mcp_disabled_servers"],
                                )?
                            }
                        }
                    }
                }
            }
            with_targets(&context, &job, false, |targets| {
                let job = if matches!(action, MigrationAction::ResumeBatch { .. }) {
                    store.resume_batch(job_id, plan_id, request_id, *expected_sequence, targets)?
                } else {
                    store.run_batch(
                        job_id,
                        plan_id,
                        request_id,
                        *expected_sequence,
                        matches!(action, MigrationAction::RollbackBatch { .. }),
                        targets,
                    )?
                };
                print(&read_result(&job))
            })
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    }
}

pub(super) fn with_targets<T>(
    context: &Context,
    job: &kcoder_migration::store::MigrationJob,
    create: bool,
    operation: impl FnOnce(&BatchTargets<'_>) -> Result<T>,
) -> Result<T> {
    with_project_mcp_selection(context, job, create, None, operation)
}

pub(super) fn with_project_mcp_selection<T>(
    context: &Context,
    job: &kcoder_migration::store::MigrationJob,
    create: bool,
    selection: Option<&kcoder_app_protocol::MigrationProjectMcpInheritanceSelection>,
    operation: impl FnOnce(&BatchTargets<'_>) -> Result<T>,
) -> Result<T> {
    super::settings_targets::verify(context, job)?;
    let (provider, mut mcp) = if let Some(project) = job.project_target() {
        (
            ProviderTarget::open_project(&context.profile, project, create)?,
            McpTarget::open_project(&context.profile, project, create)?,
        )
    } else {
        (
            ProviderTarget::open(&context.profile)?,
            McpTarget::open(&context.profile)?,
        )
    };
    if let Some(selection) = selection {
        super::settings_targets::writable(context, job, &["mcp_servers", "mcp_disabled_servers"])?;
        mcp = mcp.with_project_mcp_catalog(kcoder_config::ProjectMcpCatalogSelection {
            names: selection.names.clone(),
            expected_revision: selection.expected_revision.clone(),
        })?;
    }
    let assets = AssetTarget::open(&context.profile)?;
    let credentials = CredentialTarget::open(&context.profile)?;
    let backend = OsCredentialBackend::new();
    let history = kcoder_migration::history_jobs::HistoryJobStore::open_existing(&context.profile)?;
    operation(&BatchTargets {
        history: history.as_ref(),
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: Some(CredentialTargets {
            target: &credentials,
            backend: &backend,
            policy: context.loaded.settings.credential_store,
        }),
    })
}
