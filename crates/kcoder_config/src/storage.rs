//! Read-only location discovery. Migration and permission repair are separate operations.

mod active_operation;
pub mod browser_cache;
mod capacity;
mod component_publication;
mod context;
mod control;
mod inventory;
mod node_wire_path;
mod operation;
mod record;
mod resolve;
mod runtime;
mod source_retirement;
mod targets;
mod tree_copy;
mod writers;

#[cfg(test)]
mod control_tests;
#[cfg(test)]
mod operation_tests;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

pub use component_publication::{
    StorageComponentDirectory, StoragePublishedComponent, observe_published_storage_component,
};
pub use context::capture_storage_startup_context;
pub use control::{
    STORAGE_OFFLINE_CHILD_FRAME_LIMIT, StorageCoordinator, StorageOfflineChildFence,
    StorageOfflineChildFences, StorageSourceCleanupEntry, StorageSourceCleanupPreview,
    StorageSourceCleanupResult, StorageSourceCleanupStatus, StorageStartupLease,
    read_storage_migration, read_storage_offline_child_frame, read_storage_operation,
    write_storage_offline_child_frame,
};
pub use inventory::{StorageTreeEntry, StorageTreeEntryKind, StorageTreeInventory};
pub use kcoder_types::{
    StorageConsumer, StorageLocationRecord, StoragePaths, StorageStartupContext,
};
pub use node_wire_path::{node_storage_path, node_storage_relative_path};
pub use operation::{
    BrowserCacheOperation, STORAGE_OPERATION_ENTRY, StorageOperationOwner,
    execute_storage_operation, execute_storage_operation_with_owner, prepare_storage_plan,
    prepare_storage_plan_from_paths_with_owner, prepare_storage_plan_with_owner,
    verify_committed_storage_target, verify_committed_storage_target_with_owner,
};
pub use record::read_storage_location_record;
pub use resolve::{
    default_storage_location, resolve_storage_paths, storage_location_file,
    validate_storage_location_record,
};
pub use runtime::{
    StorageInstance, initialize_storage_diagnostic_runtime, initialize_storage_runtime,
    initialized_storage_paths, temporary_root_parent,
};
pub use source_retirement::{StorageRootRole, assert_storage_root_admitted};
pub use targets::{
    StorageTargetPath, StorageTargetPreview, inspect_storage_target, preview_storage_targets,
};
pub use tree_copy::{StorageTreeCopyBinding, StorageTreeCopyReceipt};
pub use writers::StorageProfileWriter;

const OVERRIDE_NAMES: &[&str] = &[
    "KCODER_CONFIG_DIR",
    "KCODER_HOME",
    "KCODER_CACHE_DIR",
    "KCODER_STUDIO_DATA_DIR",
    "KCODER_STUDIO_SERVERS_STORE",
    "KCODER_STUDIO_DESKTOP_USER_DATA_DIR",
];

#[derive(Debug, Default)]
pub struct StorageResolveInput {
    pub home: Option<PathBuf>,
    pub platform_config: Option<PathBuf>,
    pub env: BTreeMap<String, OsString>,
    pub record: Option<StorageLocationRecord>,
    pub consumer: StorageConsumer,
    pub development: bool,
    pub startup_context: Option<StorageStartupContext>,
}

impl StorageResolveInput {
    pub(super) fn validate_environment(&self, case_insensitive: bool) -> anyhow::Result<()> {
        if case_insensitive {
            for name in OVERRIDE_NAMES {
                let mut values = self
                    .env
                    .iter()
                    .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                    .map(|(_, value)| value);
                let first = values.next();
                anyhow::ensure!(
                    values.all(|value| Some(value) == first),
                    "STORAGE_ENV_CONFLICT"
                );
            }
        }
        Ok(())
    }

    pub(super) fn value(&self, name: &str) -> Option<&OsStr> {
        self.env
            .iter()
            .find(|(key, value)| {
                !value.is_empty()
                    && if cfg!(windows) {
                        key.eq_ignore_ascii_case(name)
                    } else {
                        key.as_str() == name
                    }
            })
            .map(|(_, value)| value.as_os_str())
    }

    pub(super) fn ignores_personal_selection(&self) -> bool {
        self.development
            || self.value("KCODER_CONFIG_DIR").is_some()
            || self.value("KCODER_HOME").is_some()
    }
}

/// Resolve this process without creating directories or changing permissions.
pub fn current_storage_paths() -> anyhow::Result<StoragePaths> {
    if let Some(paths) = initialized_storage_paths() {
        return Ok(paths.clone());
    }
    load_storage_paths(process_storage_input()?)
}

pub(super) fn process_storage_input() -> anyhow::Result<StorageResolveInput> {
    let mut input = StorageResolveInput {
        home: dirs::home_dir(),
        platform_config: dirs::config_dir(),
        env: BTreeMap::new(),
        startup_context: context::captured(),
        development: std::env::current_exe()
            .ok()
            .and_then(|path| path.file_stem().map(|value| value.to_owned()))
            .is_some_and(|stem| stem.eq_ignore_ascii_case("kcoder-dev")),
        ..Default::default()
    };
    for name in OVERRIDE_NAMES {
        if let Some(value) = std::env::var_os(name) {
            let value = if !value.is_empty()
                && matches!(
                    *name,
                    "KCODER_CONFIG_DIR"
                        | "KCODER_HOME"
                        | "KCODER_STUDIO_SERVERS_STORE"
                        | "KCODER_STUDIO_DESKTOP_USER_DATA_DIR"
                )
                && !std::path::Path::new(&value).is_absolute()
            {
                std::env::current_dir()?.join(value).into_os_string()
            } else {
                value
            };
            input.env.insert((*name).into(), value);
        }
    }
    // The existing libtest guard owns its own profile; never read the personal locator.
    if input.value("KCODER_CONFIG_DIR").is_none()
        && input.value("KCODER_HOME").is_none()
        && let Some(profile) = crate::loader::test_harness_profile::test_harness_profile()
    {
        input
            .env
            .insert("KCODER_CONFIG_DIR".into(), profile.as_os_str().to_owned());
    }
    Ok(input)
}

pub(super) fn load_storage_paths(input: StorageResolveInput) -> anyhow::Result<StoragePaths> {
    let (mut input, inherited_paths) = context::apply(input)?;
    if let Some(paths) = inherited_paths {
        return Ok(paths);
    }
    if !input.ignores_personal_selection()
        && let Some(home) = &input.home
    {
        input.record = read_storage_location_record(&storage_location_file(home))?;
    }
    project_deferred_legacy_paths(&input, resolve_storage_paths(&input)?)
}

/// Deferred legacy recovery keeps the original source roots authoritative until
/// the existing operation commits its target selection. This is a read-only
/// projection of the current, structurally validated operation receipt.
pub(super) fn project_deferred_legacy_paths(
    input: &StorageResolveInput,
    paths: StoragePaths,
) -> anyhow::Result<StoragePaths> {
    if input.ignores_personal_selection() {
        return Ok(paths);
    }
    let Some(home) = input.home.as_deref() else {
        return Ok(paths);
    };
    let Some(receipt) = read_storage_migration(home)? else {
        return Ok(paths);
    };
    if receipt.disposition != kcoder_types::StorageMigrationDisposition::Deferred
        || receipt.plan.from.layout != kcoder_types::StorageLayout::Legacy
    {
        return Ok(paths);
    }
    anyhow::ensure!(
        receipt.plan.original == input.record,
        "STORAGE_SELECTION_CHANGED"
    );
    anyhow::ensure!(
        paths.layout == kcoder_types::StorageLayout::Legacy && !paths.externally_configured,
        "STORAGE_SELECTION_CHANGED"
    );
    anyhow::ensure!(
        !receipt.plan.from.externally_configured
            && receipt.plan.from.selection_revision.is_none()
            && receipt.plan.from.operation_id.is_none(),
        "STORAGE_SELECTION_CHANGED"
    );
    Ok(receipt.plan.from)
}
