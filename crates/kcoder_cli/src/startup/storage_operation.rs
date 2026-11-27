//! Local-host one-shot entry: no dotenv, settings initialization, model or business runtime.
use super::{
    storage_legacy::legacy_storage_paths_for_plan, storage_profile_operation::LocalStorageOperation,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::storage::{
    STORAGE_OPERATION_ENTRY, StorageCoordinator, current_storage_paths,
    execute_storage_operation_with_owner, prepare_storage_plan_from_paths_with_owner,
    read_storage_migration, read_storage_operation, verify_committed_storage_target_with_owner,
};
use kcoder_types::{StorageLaunchIntent, StorageMigrationPlan};
use serde::Deserialize;
use std::{
    ffi::OsString,
    io::{Read, Write},
    path::PathBuf,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanInput {
    operation_id: String,
    data_root: PathBuf,
    cache_root: PathBuf,
    launch_intent: StorageLaunchIntent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupConfirmation {
    confirmation: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialRoots {
    data_root: PathBuf,
    cache_root: PathBuf,
}

fn input<T: serde::de::DeserializeOwned>() -> Result<T> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 1024 * 1024,
        "STORAGE_OPERATION_INPUT_TOO_LARGE"
    );
    serde_json::from_slice(&bytes).context("STORAGE_OPERATION_INPUT_INVALID")
}

fn settle_handoff_stop(
    coordinator: &mut StorageCoordinator,
    id: &str,
    stopped: Result<()>,
) -> Result<()> {
    match stopped {
        Ok(_) => Ok(()),
        Err(error) => {
            if error.to_string() == "STORAGE_STOP_TIMEOUT" {
                // No copy has begun. The existing cancellation path checks the
                // original sources and refuses unknown control/publication state.
                // Other writers keep running; only an explicit retry reopens this ID.
                coordinator.cancel_before_copy(id)?;
                coordinator.defer_after_cleanup(id, "STORAGE_STOP_TIMEOUT")?;
            }
            Err(error)
        }
    }
}

fn run(args: &[OsString]) -> Result<()> {
    let mode = args
        .get(2)
        .and_then(|value| value.to_str())
        .context("STORAGE_OPERATION_INVALID")?;
    let home = dirs::home_dir().context("STORAGE_HOME_UNAVAILABLE")?;
    let mut owner = matches!(
        mode,
        "plan" | "execute" | "handoff" | "retry-handoff" | "resume" | "retry" | "verify"
    )
    .then(|| LocalStorageOperation::new(&home))
    .transpose()?;
    let output = match mode {
        "initialize" => {
            ensure!(args.len() == 3, "STORAGE_OPERATION_INVALID");
            let roots: InitialRoots = input()?;
            let from = current_storage_paths()?;
            let mut sources = super::storage_legacy::registered_legacy_sources(&home)?;
            // A valid older registration is an existing installation, even
            // when its disk or directory is currently unavailable.
            ensure!(sources.is_empty(), "STORAGE_INITIAL_SELECTION_HAS_DATA");
            sources.push(home.join(".config/kcoder-studio"));
            sources.push(
                dirs::config_dir()
                    .context("STORAGE_HOME_UNAVAILABLE")?
                    .join("kcoder-studio"),
            );
            serde_json::to_value(StorageCoordinator::acquire(&home)?.select_initial_roots(
                &from,
                &roots.data_root,
                &roots.cache_root,
                &sources,
            )?)?
        }
        "plan" => {
            ensure!(args.len() == 3, "STORAGE_OPERATION_INVALID");
            ensure!(
                !kcoder_config::storage::current_storage_paths()?.externally_configured,
                "STORAGE_EXTERNAL_INSTANCE_READ_ONLY"
            );
            let input: PlanInput = input()?;
            serde_json::to_value(prepare_storage_plan_from_paths_with_owner(
                &home,
                legacy_storage_paths_for_plan(&home, current_storage_paths()?)?,
                &input.data_root,
                &input.cache_root,
                &input.operation_id,
                input.launch_intent,
                owner.as_ref().context("STORAGE_OPERATION_INVALID")?,
            )?)?
        }
        "execute" | "handoff" | "retry-handoff" => {
            ensure!(args.len() == 3, "STORAGE_OPERATION_INVALID");
            ensure!(
                !kcoder_config::storage::current_storage_paths()?.externally_configured,
                "STORAGE_EXTERNAL_INSTANCE_READ_ONLY"
            );
            let plan: StorageMigrationPlan = input()?;
            let handoff = mode != "execute";
            let parent = handoff
                .then(super::storage_handoff_parent::HandoffParent::capture)
                .transpose()?;
            let relaunch = if handoff {
                super::storage_relaunch::DesktopRelaunch::capture(plan.launch_intent)?
            } else {
                None
            };
            let mut fresh = prepare_storage_plan_from_paths_with_owner(
                &home,
                legacy_storage_paths_for_plan(&home, current_storage_paths()?)?,
                &plan.target.data_root,
                &plan.target.cache_root,
                &plan.operation_id,
                plan.launch_intent,
                owner.as_ref().context("STORAGE_OPERATION_INVALID")?,
            )?
            .context("STORAGE_NO_OPERATION")?;
            // Sizes are advisory while logs can still change. All paths,
            // identities, domains and revisions remain exact.
            for (current, confirmed) in fresh.components.iter_mut().zip(&plan.components) {
                current.estimated_bytes = confirmed.estimated_bytes;
            }
            ensure!(fresh == plan, "STORAGE_PREVIEW_CHANGED");
            {
                let mut coordinator = StorageCoordinator::acquire(&home)?;
                let mut receipt = coordinator.begin(plan.clone())?;
                if mode == "retry-handoff" {
                    // Only this explicit retry reactivates the original receipt.
                    // It still waits for the actual desktop to exit before copying.
                    receipt = coordinator.retry_deferred(&plan.operation_id)?;
                }
                if handoff {
                    use kcoder_types::StorageMigrationPhase as Phase;
                    if receipt.phase == Phase::Planned {
                        coordinator.advance(&plan.operation_id, Phase::Planned, Phase::Stopping)?;
                    } else {
                        ensure!(
                            matches!(receipt.phase, Phase::Stopping | Phase::Stopped),
                            "STORAGE_PHASE_INVALID"
                        );
                    }
                    writeln!(
                        std::io::stdout(),
                        "{}",
                        serde_json::json!({
                            "operationId": plan.operation_id, "state": "ready"
                        })
                    )?;
                    std::io::stdout().flush()?;
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
                    let stopped = parent
                        .as_ref()
                        .context("STORAGE_HANDOFF_PARENT_UNAVAILABLE")?
                        .wait_exited(deadline.saturating_duration_since(std::time::Instant::now()))
                        .and_then(|()| {
                            coordinator
                                .wait_for_stopped(
                                    &plan.operation_id,
                                    deadline.saturating_duration_since(std::time::Instant::now()),
                                )
                                .map(|_| ())
                        });
                    settle_handoff_stop(&mut coordinator, &plan.operation_id, stopped)?;
                }
            }
            let completed = execute_storage_operation_with_owner(
                &home,
                &plan.operation_id,
                &std::env::current_exe()?,
                owner.as_mut().context("STORAGE_OPERATION_INVALID")?,
            )?;
            if let Some(relaunch) = relaunch {
                relaunch.start(&completed)?;
            }
            serde_json::to_value(completed)?
        }
        "resume" | "retry" | "verify" => {
            ensure!(args.len() == 4, "STORAGE_OPERATION_INVALID");
            let id = args[3].to_str().context("STORAGE_OPERATION_INVALID")?;
            if mode == "verify" {
                serde_json::to_value(verify_committed_storage_target_with_owner(
                    &home,
                    id,
                    owner.as_ref().context("STORAGE_OPERATION_INVALID")?,
                )?)?
            } else {
                ensure!(
                    !kcoder_config::storage::current_storage_paths()?.externally_configured,
                    "STORAGE_EXTERNAL_INSTANCE_READ_ONLY"
                );
                if mode == "retry" {
                    StorageCoordinator::acquire(&home)?.retry_deferred(id)?;
                }
                serde_json::to_value(execute_storage_operation_with_owner(
                    &home,
                    id,
                    &std::env::current_exe()?,
                    owner.as_mut().context("STORAGE_OPERATION_INVALID")?,
                )?)?
            }
        }
        "cancel" => {
            ensure!(args.len() == 4, "STORAGE_OPERATION_INVALID");
            ensure!(
                !current_storage_paths()?.externally_configured,
                "STORAGE_EXTERNAL_INSTANCE_READ_ONLY"
            );
            let id = args[3].to_str().context("STORAGE_OPERATION_INVALID")?;
            serde_json::to_value(StorageCoordinator::acquire(&home)?.cancel_operation(id)?)?
        }
        "status" => {
            ensure!((3..=4).contains(&args.len()), "STORAGE_OPERATION_INVALID");
            serde_json::to_value(if let Some(id) = args.get(3) {
                read_storage_operation(&home, id.to_str().context("STORAGE_OPERATION_INVALID")?)?
            } else {
                read_storage_migration(&home)?
            })?
        }
        "cleanup-preview" | "cleanup-confirm" => {
            ensure!(args.len() == 4, "STORAGE_OPERATION_INVALID");
            ensure!(
                !current_storage_paths()?.externally_configured,
                "STORAGE_EXTERNAL_INSTANCE_READ_ONLY"
            );
            let id = args[3].to_str().context("STORAGE_OPERATION_INVALID")?;
            let coordinator = StorageCoordinator::acquire(&home)?;
            if mode == "cleanup-preview" {
                serde_json::to_value(coordinator.preview_source_cleanup(id)?)?
            } else {
                let input: CleanupConfirmation = input()?;
                serde_json::to_value(coordinator.confirm_source_cleanup(id, &input.confirmation)?)?
            }
        }
        "startup" => {
            ensure!(args.len() == 3, "STORAGE_OPERATION_INVALID");
            serde_json::to_value(
                super::storage_legacy::migrate_legacy_storage_before_startup(false)?,
            )?
        }
        _ => anyhow::bail!("STORAGE_OPERATION_INVALID"),
    };
    match writeln!(std::io::stdout(), "{}", serde_json::to_string(&output)?) {
        Ok(()) => {}
        // The original UI can exit after readiness. Completion is authoritative
        // in the original operation, never inferred from this optional reply.
        Err(error) if mode == "handoff" && error.kind() == std::io::ErrorKind::BrokenPipe => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

#[cfg(test)]
#[path = "storage_operation_tests.rs"]
mod tests;

pub(in super::super) fn try_run_storage_operation(args: &[OsString]) -> Option<Result<()>> {
    args.get(1)
        .is_some_and(|value| value == STORAGE_OPERATION_ENTRY)
        .then(|| run(args))
}
