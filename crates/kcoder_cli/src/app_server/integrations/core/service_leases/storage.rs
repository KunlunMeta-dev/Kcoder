//! Compose the original native domain guard with the State-owned service store.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_integration_storage::integrations::core::service_leases::IntegrationServiceLeaseStore;
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::core::NativeScopeHostResources;
use std::ffi::OsStr;

pub struct NativeServiceLeases {
    guard: NativeDomainGuard,
    store: IntegrationServiceLeaseStore,
}
impl NativeServiceLeases {
    pub fn load(native: &NativeIntegrationContext) -> Result<Option<Self>> {
        native.verify()?;
        let Some(guard) =
            NativeDomainGuard::observe(native.profile()?, native.scope(), NativeDomain::Services)?
        else {
            return Ok(None);
        };
        let directory = guard.directory(native.profile()?)?;
        let store = IntegrationServiceLeaseStore::open_in(
            &directory,
            OsStr::new("leases"),
            native.scope(),
        )?;
        let host = Self { guard, store };
        host.verify(native)?;
        Ok(Some(host))
    }
    /// An actual first-party infrastructure intent or completed service-consent
    /// checks may initialize storage. Storage existence grants no service lease.
    pub fn initialize(native: &NativeIntegrationContext, operation: &str) -> Result<Self> {
        if let Some(existing) = Self::load(native)? {
            return Ok(existing);
        }
        let (guard, store) = NativeDomainGuard::initialize(
            native.profile()?,
            native.scope(),
            NativeDomain::Services,
            operation,
            |directory| {
                IntegrationServiceLeaseStore::create_in(
                    directory,
                    OsStr::new("leases"),
                    native.scope(),
                )
            },
        )?;
        let host = Self { guard, store };
        host.verify(native)?;
        Ok(host)
    }
    pub fn verify(&self, native: &NativeIntegrationContext) -> Result<()> {
        native.verify()?;
        let directory = self.guard.directory(native.profile()?)?;
        let original: PrivateDirectory = directory
            .open_entry_handle(OsStr::new("leases"))?
            .open_child_directory()?;
        ensure!(
            original.directory_identity()? == self.store.directory_identity()?,
            "SERVICE_LEASE_STORE_CHANGED"
        );
        Ok(())
    }
    pub fn store(
        &self,
        native: &NativeIntegrationContext,
    ) -> Result<&IntegrationServiceLeaseStore> {
        self.verify(native)?;
        Ok(&self.store)
    }

    pub fn create_resource_copy(
        &self,
        native: &NativeIntegrationContext,
        lease_id: &str,
    ) -> Result<(PrivateDirectory, std::path::PathBuf)> {
        self.verify(native)?;
        let directory = self.guard.directory(native.profile()?)?;
        use sha2::{Digest, Sha256};
        let name = format!("resources-{:x}", Sha256::digest(lease_id.as_bytes()));
        let target = directory.create_private_child(OsStr::new(&name))?;
        let path = native
            .profile_path()?
            .join(self.guard.namespace_id())
            .join(&name);
        ensure!(
            PrivateDirectory::open_existing(&path)?.directory_identity()?
                == target.directory_identity()?,
            "SERVICE_RESOURCE_TARGET_CHANGED"
        );
        Ok((target, path))
    }

    /// A prepared descriptor is a cache locator, never deletion or execution authority.
    pub fn open_retained_channel_resources(
        &self,
        native: &NativeIntegrationContext,
        resources: &NativeScopeHostResources,
    ) -> Result<Option<(PrivateDirectory, std::path::PathBuf)>> {
        self.verify(native)?;
        let parent = native.profile_path()?.join(self.guard.namespace_id());
        let path = &resources.component_root;
        let name = path
            .file_name()
            .context("SERVICE_RESOURCE_TARGET_CHANGED")?;
        let suffix = name
            .to_str()
            .and_then(|name| name.strip_prefix("resources-"))
            .context("SERVICE_RESOURCE_TARGET_CHANGED")?;
        ensure!(
            path.parent() == Some(parent.as_path())
                && suffix.len() == 64
                && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "SERVICE_RESOURCE_TARGET_CHANGED"
        );
        let directory = self.guard.directory(native.profile()?)?;
        let entry = match directory.open_entry_handle(name) {
            Ok(entry) => entry,
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let target = entry.open_child_directory()?;
        target.verify_private_directory()?;
        ensure!(
            PrivateDirectory::open_existing(path)?.directory_identity()?
                == target.directory_identity()?,
            "SERVICE_RESOURCE_TARGET_CHANGED"
        );
        Ok(Some((target, path.clone())))
    }

    /// Reopen only the fixed original guard-relative copy; observation never creates it.
    pub fn open_resource_copy(
        &self,
        native: &NativeIntegrationContext,
        copy_id: &str,
    ) -> Result<(PrivateDirectory, std::path::PathBuf)> {
        self.verify(native)?;
        let directory = self.guard.directory(native.profile()?)?;
        use sha2::{Digest, Sha256};
        let name = format!("resources-{:x}", Sha256::digest(copy_id.as_bytes()));
        let target = directory
            .open_entry_handle(OsStr::new(&name))?
            .open_child_directory()?;
        target.verify_private_directory()?;
        let path = native
            .profile_path()?
            .join(self.guard.namespace_id())
            .join(&name);
        ensure!(
            PrivateDirectory::open_existing(&path)?.directory_identity()?
                == target.directory_identity()?,
            "SERVICE_RESOURCE_TARGET_CHANGED"
        );
        self.verify(native)?;
        Ok((target, path))
    }
}

pub fn now() -> Result<u64> {
    use anyhow::Context;
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis()
        .try_into()
        .ok()
        .context("SERVICE_LEASE_CLOCK_UNAVAILABLE")
}
