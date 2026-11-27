//! Local CLI wiring for the existing single offline storage phase driver.
use super::{
    storage_gateway_domains::preview_gateway_domains,
    storage_legacy::{copy_legacy_clients, validate_legacy_native_operation},
    storage_native_domains::NativeProfileDomainOwners,
    storage_profile::copy_and_relocate_profile,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    OsCredentialBackend, PrivateDirectory,
    imported_credentials::ImportedCredentialStore,
    profile_identity::ProfileIdentity,
    settings_templates::SettingsTemplateStore,
    storage::{
        BrowserCacheOperation, StorageCoordinator, StorageOperationOwner, browser_cache,
        inspect_storage_target, observe_published_storage_component, preview_storage_targets,
        storage_location_file,
    },
};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLayout, StorageMigrationPhase as Phase,
    StorageMigrationReceipt,
};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;

const RUNTIME_ENV: &str = "KCODER_STORAGE_OWNER_RUNTIME_V1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerRuntime {
    program: PathBuf,
    application_root: PathBuf,
    run_as_node: bool,
}
impl OwnerRuntime {
    fn capture() -> Result<Option<Self>> {
        let Some(value) = std::env::var_os(RUNTIME_ENV) else {
            return Ok(None);
        };
        let value = value.to_str().context("STORAGE_OWNER_RUNTIME_INVALID")?;
        ensure!(value.len() <= 65536, "STORAGE_OWNER_RUNTIME_INVALID");
        let runtime: Self = serde_json::from_str(value).context("STORAGE_OWNER_RUNTIME_INVALID")?;
        ensure!(
            runtime.application_root.is_absolute() && runtime.run_as_node,
            "STORAGE_OWNER_RUNTIME_INVALID"
        );
        kcoder_host_transport::process::verify_program_path(&runtime.program)
            .context("STORAGE_OWNER_RUNTIME_INVALID")?;
        // This is the host's fixed readable module, not a native executable.
        // Ordinary source/package file permissions must not reject the preview.
        let entry =
            std::fs::symlink_metadata(runtime.entry()).context("STORAGE_OWNER_RUNTIME_INVALID")?;
        ensure!(
            entry.is_file() && !entry.file_type().is_symlink(),
            "STORAGE_OWNER_RUNTIME_INVALID"
        );
        Ok(Some(runtime))
    }
    fn entry(&self) -> PathBuf {
        self.application_root
            .join("src/migrations/gateway-storage-domains.mjs")
    }
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .arg(self.entry())
            .env_clear()
            .env("ELECTRON_RUN_AS_NODE", "1");
        // Keep the original OS account/runtime paths, never model credentials,
        // arbitrary Node options, a renderer command, or the old Home context.
        for name in [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "PATH",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "KCODER_TARGET_DIR",
            "CARGO_TARGET_DIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
    }
}

pub(super) struct LocalStorageOperation<'a> {
    home: &'a Path,
    cache: BrowserCacheOperation<'a>,
    runtime: Option<OwnerRuntime>,
}
impl<'a> LocalStorageOperation<'a> {
    pub(super) fn new(home: &'a Path) -> Result<Self> {
        Ok(Self {
            home,
            cache: BrowserCacheOperation::new(home),
            runtime: OwnerRuntime::capture()?,
        })
    }
    fn verify_target(&self, receipt: &StorageMigrationReceipt) -> Result<()> {
        let plan = &receipt.plan;
        // The original executor still owns the exclusive leases. Its copier
        // and owner conversions already checked payloads; do not rescan them.
        let published = observe_published_storage_component(
            self.home,
            &plan.operation_id,
            STORAGE_PERSISTENT_ROOT_DOMAIN,
        )?;
        let source = PrivateDirectory::open_existing(&plan.from.data_root)?;
        ProfileIdentity::observe(&source)?.verify_relocation(
            &source,
            published.directory(),
            &plan.operation_id,
        )?;
        let original =
            NativeProfileDomainOwners::observe(&plan.from.data_root, "storage-relocation-v1")?;
        let current = NativeProfileDomainOwners::observe(
            published.destination_path(),
            "storage-relocation-v1",
        )?;
        ensure!(
            original.as_ref().map(NativeProfileDomainOwners::snapshot)
                == current.as_ref().map(NativeProfileDomainOwners::snapshot),
            "STORAGE_NATIVE_TARGET_IDENTITY_CHANGED"
        );
        if let Some(original) = &original {
            original.verify_placements(&published)?;
        }
        // Keep cold metadata validation until the real entry proves a reusable
        // in-process proof; a recovered operation has reacquired its leases.
        SettingsTemplateStore::open(published.destination_path())?.preview_relocation()?;
        ImportedCredentialStore::open(published.destination_path())?
            .preview_relocation(&OsCredentialBackend::new())?;
        match browser_cache::browser_cache_owner_receipt(receipt)? {
            Some(owner) => browser_cache::verify_browser_cache(plan, &owner)?,
            None => browser_cache::verify_no_browser_cache(plan)?,
        }
        published.verify()
    }
}

impl StorageOperationOwner for LocalStorageOperation<'_> {
    fn validate(&self, receipt: &StorageMigrationReceipt) -> Result<()> {
        let plan = &receipt.plan;
        if plan.from.layout == StorageLayout::Legacy {
            validate_legacy_native_operation(self.home, receipt)?;
            if plan
                .components
                .iter()
                .any(|component| component.domain == "gateway")
                && receipt.phase == Phase::Planned
            {
                ensure!(
                    !preview_gateway_domains(receipt)? || self.runtime.is_some(),
                    "STORAGE_OWNER_RUNTIME_REQUIRED"
                );
            }
            if plan.from.data_root == plan.target.data_root {
                return Ok(());
            }
        }
        if plan.from.data_root == plan.target.data_root {
            return self.cache.validate(receipt);
        }
        let component = plan
            .components
            .first()
            .context("STORAGE_PROFILE_COMPONENT_INVALID")?;
        ensure!(
            (plan.from.layout == StorageLayout::Unified && plan.components.len() == 1
                || plan.from.layout == StorageLayout::Legacy)
                && !plan.from.externally_configured
                && component.domain == STORAGE_PERSISTENT_ROOT_DOMAIN
                && component.source == plan.from.data_root
                && component.destination == plan.target.data_root
                && plan.target_bindings.len() == 2,
            "STORAGE_PROFILE_COMPONENT_INVALID"
        );
        ensure!(
            PrivateDirectory::open_existing(&component.source)?.directory_identity()?
                == component.source_identity,
            "STORAGE_SOURCE_CHANGED"
        );
        for binding in &plan.target_bindings {
            ensure!(
                PrivateDirectory::open_existing(&binding.existing_ancestor)?
                    .directory_identity()?
                    == binding.ancestor_identity,
                "STORAGE_TARGET_CHANGED"
            );
        }
        if matches!(
            receipt.phase,
            Phase::Verifying | Phase::Prepared | Phase::Committed
        ) {
            return self.verify_target(receipt);
        }
        let native =
            NativeProfileDomainOwners::observe(&component.source, "storage-relocation-v1")?;
        let needs_gateway = (plan.from.layout != StorageLayout::Legacy
            || plan
                .components
                .iter()
                .any(|component| component.domain == "gateway"))
            && preview_gateway_domains(receipt)?;
        let needs_node = needs_gateway
            || native
                .as_ref()
                .is_some_and(NativeProfileDomainOwners::requires_owner_runtime);
        ensure!(
            !needs_node || self.runtime.is_some(),
            "STORAGE_OWNER_RUNTIME_REQUIRED"
        );
        SettingsTemplateStore::open(&component.source)?.preview_relocation()?;
        ImportedCredentialStore::open(&component.source)?
            .preview_relocation(&OsCredentialBackend::new())?;
        if receipt.phase == Phase::Planned {
            let source = inspect_storage_target(&component.source)?;
            let control = storage_location_file(self.home);
            let control =
                inspect_storage_target(control.parent().context("STORAGE_CONTROL_UNAVAILABLE")?)?;
            ensure!(
                !source.contains(&control),
                "STORAGE_COMPONENT_CONTROL_OVERLAP"
            );
            let mut protected = vec![
                std::env::current_exe()?
                    .parent()
                    .context("STORAGE_PROGRAM_UNAVAILABLE")?
                    .to_owned(),
            ];
            if let Some(runtime) = &self.runtime {
                protected.push(runtime.application_root.clone());
            }
            for path in &protected {
                ensure!(
                    !source.contains(&inspect_storage_target(path)?),
                    "STORAGE_SOURCE_CONTAINS_PROGRAM"
                );
            }
            preview_storage_targets(
                &plan.from,
                &plan.target.data_root,
                &plan.target.cache_root,
                &[],
                &protected,
            )?;
            browser_cache::preview_browser_cache(plan)?;
        }
        Ok(())
    }

    fn copy_and_relocate(&mut self, coordinator: &mut StorageCoordinator, id: &str) -> Result<()> {
        let receipt = coordinator
            .current()?
            .context("STORAGE_OPERATION_MISSING")?;
        if receipt.plan.from.layout == StorageLayout::Legacy {
            validate_legacy_native_operation(self.home, &receipt)?;
            if receipt.plan.from.data_root == receipt.plan.target.data_root {
                let mut command = self.runtime.as_ref().map(OwnerRuntime::command);
                return tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?
                    .block_on(copy_legacy_clients(
                        self.home,
                        coordinator,
                        id,
                        command.as_mut(),
                    ));
            }
        }
        if receipt.plan.from.data_root == receipt.plan.target.data_root {
            return self.cache.copy_and_relocate(coordinator, id);
        }
        let evidence = storage_location_file(self.home)
            .parent()
            .context("STORAGE_CONTROL_UNAVAILABLE")?
            .join("kcoder-storage-migrations")
            .join(id);
        let mut command = self.runtime.as_ref().map(OwnerRuntime::command);
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(copy_and_relocate_profile(
                coordinator,
                id,
                &OsCredentialBackend::new(),
                None,
                &evidence,
                command.as_mut(),
            ))?;
        if receipt.plan.from.layout == StorageLayout::Legacy {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(copy_legacy_clients(
                    self.home,
                    coordinator,
                    id,
                    command.as_mut(),
                ))?;
        }
        Ok(())
    }

    fn reconcile_failure(&mut self, coordinator: &mut StorageCoordinator, id: &str) -> Result<()> {
        let receipt = coordinator
            .current()?
            .context("STORAGE_OPERATION_MISSING")?;
        if receipt.plan.from.layout == StorageLayout::Legacy {
            // A failed stop or unknown effect remains the same active operation.
            return Ok(());
        }
        if receipt.plan.from.data_root == receipt.plan.target.data_root {
            return self.cache.reconcile_failure(coordinator, id);
        }
        // A partial publication or conversion remains the original active job.
        // Do not assert cleanup or switch back while its effect is unconfirmed.
        Ok(())
    }
}
