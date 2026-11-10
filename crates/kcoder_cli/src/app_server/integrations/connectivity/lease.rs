use super::{
    control::{self, BootstrapEntry, Initialization},
    parent::NativeConnectivityParent,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::core::IntegrationOwner;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::File,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConnectivityLeaseReply {
    pub lease_id: String,
    pub namespace_id: String,
    pub expires_at: u64,
    pub stage: &'static str,
    pub store_mode: &'static str,
    pub initialization_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeConnectivityReadyInput {
    pub lease_id: String,
    pub namespace_id: String,
    pub initialization_id: String,
    pub binding_hash: String,
}

struct ActiveLease {
    id: String,
    parent: Arc<NativeConnectivityParent>,
    kernel: Option<VerifiedPrivateLease>,
    expires_at: u64,
    activation_ready: bool,
    create: bool,
    verified_files: BTreeMap<String, (File, PortableLeaseIdentity)>,
}
impl Drop for ActiveLease {
    fn drop(&mut self) {
        let Some(kernel) = self.kernel.take() else {
            return;
        };
        if self.parent.alive().is_ok_and(|alive| !alive) {
            drop(kernel);
            return;
        }
        // A disconnect/Drop is not process termination. Keep the actual OS lease
        // until the original pidfd/process handle confirms this worker exited.
        let parent = self.parent.clone();
        std::thread::spawn(move || {
            while !parent.alive().is_ok_and(|alive| !alive) {
                std::thread::sleep(Duration::from_millis(25));
            }
            drop(kernel);
        });
    }
}

pub struct NativeConnectivityLeaseFacade {
    domain: NativeDomainGuard,
    initial: Initialization,
    initial_identity: PortableLeaseIdentity,
    initial_anchor: File,
    log_anchor: File,
    lock_anchor: File,
    leases: Mutex<BTreeMap<String, ActiveLease>>,
    #[cfg(test)]
    ready_inspections: std::sync::atomic::AtomicUsize,
}

impl NativeConnectivityLeaseFacade {
    /// Exact exited-owner cleanup does not require a now-deleted/reconfigured path.
    pub fn release_exited_parent(&self, parent: &NativeConnectivityParent) -> Result<()> {
        ensure!(!parent.alive()?, "CONNECTIVITY_PARENT_STILL_ACTIVE");
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
        leases.retain(|_, lease| lease.parent.id != parent.id);
        Ok(())
    }
    pub fn namespace_id(&self, context: &NativeIntegrationContext) -> Result<&str> {
        self.verify(context)?;
        Ok(self.domain.namespace_id())
    }
    /// Called only by the native authorized first-write path. Reads use observe.
    pub fn initialize(context: &NativeIntegrationContext, operation_id: &str) -> Result<Self> {
        context.verify()?;
        let scope = context.scope().clone();
        let profile = context.profile()?;
        let (domain, ()) = NativeDomainGuard::initialize(
            profile,
            &scope,
            NativeDomain::Connectivity,
            operation_id,
            |directory| {
                control::initialize(directory, IntegrationOwner::from(&scope), operation_id)
            },
        )?;
        context.validate_scope(&scope)?;
        Self::from_domain(context, domain)
    }
    pub fn observe(context: &NativeIntegrationContext) -> Result<Option<Self>> {
        context.verify()?;
        let Some(domain) = NativeDomainGuard::observe(
            context.profile()?,
            context.scope(),
            NativeDomain::Connectivity,
        )?
        else {
            return Ok(None);
        };
        Ok(Some(Self::from_domain(context, domain)?))
    }
    fn from_domain(context: &NativeIntegrationContext, domain: NativeDomainGuard) -> Result<Self> {
        let directory = domain.directory(context.profile()?)?;
        let initial_anchor = directory.open_single_link_regular_file(OsStr::new(control::INIT))?;
        let initial_identity = directory.portable_regular_handle_identity(&initial_anchor)?;
        let initial = control::read_initialization(&initial_anchor)?;
        ensure!(
            initial.version == 1 && initial.owner == IntegrationOwner::from(context.scope()),
            "CONNECTIVITY_STORAGE_OWNER_MISMATCH"
        );
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new(control::LOCK))?;
        let log_anchor = directory.open_single_link_regular_file(OsStr::new(control::LOG))?;
        ensure!(
            directory.portable_regular_handle_identity(&lock_anchor)? == initial.lock_identity
                && directory.portable_regular_handle_identity(&log_anchor)? == initial.log_identity,
            "CONNECTIVITY_CONTROL_CHANGED"
        );
        control::data_directory(&directory, &initial)?;
        let result = Self {
            domain,
            initial,
            initial_identity,
            initial_anchor,
            log_anchor,
            lock_anchor,
            leases: Mutex::new(BTreeMap::new()),
            #[cfg(test)]
            ready_inspections: std::sync::atomic::AtomicUsize::new(0),
        };
        result.verify(context)?;
        Ok(result)
    }
    fn verify(&self, context: &NativeIntegrationContext) -> Result<PrivateDirectory> {
        let profile = context.profile()?;
        ensure!(
            self.initial.owner == IntegrationOwner::from(context.scope()),
            "CONNECTIVITY_STORAGE_OWNER_MISMATCH"
        );
        let directory = self.domain.directory(profile)?;
        ensure!(
            directory.portable_regular_handle_identity(&self.initial_anchor)?
                == self.initial_identity
                && directory.portable_regular_identity(OsStr::new(control::INIT))?
                    == self.initial_identity
                && control::read_initialization(&self.initial_anchor)? == self.initial,
            "CONNECTIVITY_INITIALIZATION_CHANGED"
        );
        ensure!(
            directory.portable_regular_handle_identity(&self.lock_anchor)?
                == self.initial.lock_identity
                && directory.portable_regular_identity(OsStr::new(control::LOCK))?
                    == self.initial.lock_identity
                && directory.portable_regular_handle_identity(&self.log_anchor)?
                    == self.initial.log_identity
                && directory.portable_regular_identity(OsStr::new(control::LOG))?
                    == self.initial.log_identity,
            "CONNECTIVITY_CONTROL_CHANGED"
        );
        let entries = control::read_log(&self.log_anchor, &self.initial, &self.initial_identity)?;
        let data = control::data_directory(&directory, &self.initial)?;
        if let Some(ready @ BootstrapEntry::Ready { .. }) = entries.get(2) {
            ensure!(
                &control::verify_node_store(
                    &directory,
                    &data,
                    self.domain.namespace_id(),
                    &self.initial
                )? == ready,
                "CONNECTIVITY_NODE_STORAGE_CHANGED"
            );
        }
        Ok(directory)
    }
    /// Observe an already sealed Node store; a receipt read cannot issue an initialization authority.
    pub fn require_original_ready_store(&self, context: &NativeIntegrationContext) -> Result<()> {
        self.verify(context)?;
        let entries = control::read_log(&self.log_anchor, &self.initial, &self.initial_identity)?;
        ensure!(
            matches!(entries.get(2), Some(BootstrapEntry::Ready { .. })),
            "CONNECTIVITY_ORIGINAL_STORE_UNAVAILABLE"
        );
        Ok(())
    }
    /// Private launch path only; never serialize this path into model/tool context.
    pub fn private_data_path(&self, context: &NativeIntegrationContext) -> Result<PathBuf> {
        self.verify(context)?;
        Ok(context
            .captured_profile_path()
            .join(self.domain.namespace_id())
            .join(control::DATA))
    }
    pub fn acquire(
        &self,
        context: &NativeIntegrationContext,
        parent: Option<Arc<NativeConnectivityParent>>,
    ) -> Result<NativeConnectivityLeaseReply> {
        let parent = parent.context("CONNECTIVITY_PRIVATE_PARENT_REQUIRED")?;
        parent.check_process_for_captured_scope(context)?;
        let directory = self.verify(context)?;
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
        leases.retain(|_, lease| !lease.parent.alive().is_ok_and(|alive| !alive));
        if let Some(lease) = leases.values().find(|lease| lease.parent.id == parent.id) {
            return Ok(self.reply(lease));
        }
        let kernel = directory
            .try_existing_portable_lock(
                OsStr::new(control::LOCK),
                &self.initial.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("CONNECTIVITY_PROFILE_BUSY")?;
        let entries = control::read_log(&self.log_anchor, &self.initial, &self.initial_identity)?;
        let create = entries.len() == 1;
        if create {
            let data = control::data_directory(&directory, &self.initial)?;
            let mut count = 0;
            data.visit_entry_names_bounded(1, |_| {
                count += 1;
                Ok(())
            })?;
            ensure!(
                count == 0
                    && directory
                        .entry_metadata(OsStr::new("data.binding.json"))
                        .is_err_and(|error| error
                            .downcast_ref::<std::io::Error>()
                            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)),
                "CONNECTIVITY_UNRECEIPTED_NODE_STORAGE"
            );
            control::append_log(
                &directory,
                &BootstrapEntry::Issued {
                    initialization_id: self.initial.initialization_id.clone(),
                    initialization_identity: self.initial_identity.clone(),
                },
            )?;
        }
        parent.check_process_for_captured_scope(context)?;
        self.verify(context)?;
        let id = uuid::Uuid::new_v4().to_string();
        #[cfg(windows)]
        let verified_files = if matches!(entries.get(2), Some(BootstrapEntry::Ready { .. })) {
            let data = control::data_directory(&directory, &self.initial)?;
            windows_bootstrap::prepare_sidecars(&data)?
        } else {
            BTreeMap::new()
        };
        #[cfg(not(windows))]
        let verified_files = BTreeMap::new();
        let lease = ActiveLease {
            id: id.clone(),
            parent,
            kernel: Some(kernel),
            expires_at: expires()?,
            activation_ready: false,
            create,
            verified_files,
        };
        let reply = self.reply(&lease);
        leases.insert(id, lease);
        Ok(reply)
    }
    pub fn renew(
        &self,
        context: &NativeIntegrationContext,
        parent: Option<&NativeConnectivityParent>,
        lease_id: &str,
    ) -> Result<NativeConnectivityLeaseReply> {
        let parent = parent.context("CONNECTIVITY_PRIVATE_PARENT_REQUIRED")?;
        parent.check_process_for_captured_scope(context)?;
        self.verify(context)?;
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
        let lease = leases
            .get_mut(lease_id)
            .context("CONNECTIVITY_LEASE_UNAVAILABLE")?;
        ensure!(
            lease.parent.id == parent.id,
            "CONNECTIVITY_LEASE_OWNER_MISMATCH"
        );
        lease.expires_at = expires()?;
        parent.verify(context)?;
        Ok(self.reply(lease))
    }
    /// Signer/runtime/credential contributions call this before any SDK or business effect.
    pub fn require_ready(
        &self,
        context: &NativeIntegrationContext,
        parent: Option<&NativeConnectivityParent>,
        lease_id: &str,
    ) -> Result<()> {
        self.ready_namespace(context, parent, lease_id).map(|_| ())
    }
    pub fn ready_namespace(
        &self,
        context: &NativeIntegrationContext,
        parent: Option<&NativeConnectivityParent>,
        lease_id: &str,
    ) -> Result<&str> {
        let parent = parent.context("CONNECTIVITY_PRIVATE_PARENT_REQUIRED")?;
        self.inspect_ready_lease(context, parent, Some(lease_id), |_| ())?;
        Ok(self.domain.namespace_id())
    }
    /// Select and validate the parent's original active lease before one IPC read.
    pub fn ready_lease_id(
        &self,
        context: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
    ) -> Result<String> {
        self.inspect_ready_lease(context, parent, None, |lease| lease.id.clone())
    }
    #[cfg(test)]
    pub fn ready_inspections(&self) -> usize {
        self.ready_inspections
            .load(std::sync::atomic::Ordering::Relaxed)
    }
    fn inspect_ready_lease<T>(
        &self,
        context: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
        lease_id: Option<&str>,
        read: impl FnOnce(&ActiveLease) -> T,
    ) -> Result<T> {
        #[cfg(test)]
        self.ready_inspections
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.verify(context)?;
        self.inspect_captured_ready_lease(parent, lease_id, || parent.verify(context), read)
    }
    /// Check the live original lease held by this already authenticated pipe.
    /// This protects transport routing only. It supplies no business authority.
    pub fn held_gateway_transport_lease(
        &self,
        context: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
        lease_id: Option<&str>,
    ) -> Result<Option<NativeConnectivityLeaseReply>> {
        let Some(host) = parent.scope_host() else {
            return Ok(None);
        };
        if !host.gateway_transport_open()? {
            return Ok(None);
        }
        context.check_captured_scope(host.native().scope())?;
        ensure!(
            self.initial.owner == IntegrationOwner::from(context.scope()),
            "CONNECTIVITY_STORAGE_OWNER_MISMATCH"
        );
        self.inspect_captured_ready_lease(
            parent,
            lease_id,
            || parent.check_process_for_captured_scope(context),
            |lease| self.reply(lease),
        )
        .map(Some)
    }
    fn inspect_captured_ready_lease<T>(
        &self,
        parent: &NativeConnectivityParent,
        lease_id: Option<&str>,
        check_parent: impl FnOnce() -> Result<()>,
        read: impl FnOnce(&ActiveLease) -> T,
    ) -> Result<T> {
        let leases = self
            .leases
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
        let lease = match lease_id {
            Some(id) => leases.get(id),
            None => leases.values().find(|lease| lease.parent.id == parent.id),
        }
        .context("CONNECTIVITY_LEASE_UNAVAILABLE")?;
        ensure!(
            std::ptr::eq(lease.parent.as_ref(), parent)
                && lease.kernel.is_some()
                && lease.activation_ready
                && lease.expires_at > now()?,
            "CONNECTIVITY_NATIVE_READY_REQUIRED"
        );
        check_parent()?;
        Ok(read(lease))
    }
    pub fn lease_for_parent(
        &self,
        context: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
    ) -> Result<NativeConnectivityLeaseReply> {
        self.verify(context)?;
        parent.check_process_for_captured_scope(context)?;
        let leases = self
            .leases
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
        let lease = leases
            .values()
            .find(|lease| lease.parent.id == parent.id)
            .context("CONNECTIVITY_LEASE_UNAVAILABLE")?;
        ensure!(lease.expires_at > now()?, "CONNECTIVITY_LEASE_EXPIRED");
        Ok(self.reply(lease))
    }
    pub fn commit_ready(
        &self,
        context: &NativeIntegrationContext,
        parent: Option<&NativeConnectivityParent>,
        input: &NativeConnectivityReadyInput,
    ) -> Result<NativeConnectivityLeaseReply> {
        let parent = parent.context("CONNECTIVITY_PRIVATE_PARENT_REQUIRED")?;
        parent.check_process_for_captured_scope(context)?;
        let directory = self.verify(context)?;
        ensure!(
            input.namespace_id == self.domain.namespace_id()
                && input.initialization_id == self.initial.initialization_id,
            "CONNECTIVITY_READY_OWNER_MISMATCH"
        );
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
        let lease = leases
            .get_mut(&input.lease_id)
            .context("CONNECTIVITY_LEASE_UNAVAILABLE")?;
        ensure!(
            lease.parent.id == parent.id && lease.expires_at > now()?,
            "CONNECTIVITY_LEASE_OWNER_MISMATCH"
        );
        let data = control::data_directory(&directory, &self.initial)?;
        #[cfg(windows)]
        if lease.create && !lease.activation_ready {
            let entries =
                control::read_log(&self.log_anchor, &self.initial, &self.initial_identity)?;
            ensure!(
                matches!(
                    entries.as_slice(),
                    [BootstrapEntry::Seed { .. }, BootstrapEntry::Issued { .. }]
                ),
                "CONNECTIVITY_ORIGINAL_INITIALIZATION_REQUIRED"
            );
            windows_bootstrap::seal_created_files(&directory, &data, &lease.verified_files)?;
            parent.verify(context)?;
            self.verify(context)?;
        }
        let ready = control::verify_node_store(
            &directory,
            &data,
            self.domain.namespace_id(),
            &self.initial,
        )?;
        if let BootstrapEntry::Ready { binding_hash, .. } = &ready {
            ensure!(
                binding_hash == &input.binding_hash,
                "CONNECTIVITY_READY_RECEIPT_MISMATCH"
            );
        }
        #[cfg(windows)]
        for (key, (file, identity)) in windows_bootstrap::prepare_sidecars(&data)? {
            if let Some((_, original)) = lease.verified_files.get(&key) {
                ensure!(*original == identity, "CONNECTIVITY_PRIVATE_FILE_CHANGED");
            } else {
                lease.verified_files.insert(key, (file, identity));
            }
        }
        let entries = control::read_log(&self.log_anchor, &self.initial, &self.initial_identity)?;
        match entries.get(2) {
            Some(original @ BootstrapEntry::Ready { .. }) => {
                ensure!(original == &ready, "CONNECTIVITY_READY_RECEIPT_CHANGED")
            }
            None if matches!(entries.last(), Some(BootstrapEntry::Issued { .. })) => {
                control::append_log(&directory, &ready)?
            }
            _ => anyhow::bail!("CONNECTIVITY_INITIALIZATION_NOT_ISSUED"),
        }
        parent.check_process_for_captured_scope(context)?;
        self.verify(context)?;
        lease.activation_ready = true;
        lease.expires_at = expires()?;
        Ok(self.reply(lease))
    }
    /// Prepare only the original owner's fixed SQLite coordination files.
    /// This retains the initialization stage; it never grants Ready or repairs
    /// an existing namespace's permissions to let a new caller adopt it.
    #[cfg(windows)]
    pub fn prepare_original_windows_sidecars(
        &self,
        context: &NativeIntegrationContext,
        parent: Option<&NativeConnectivityParent>,
        lease_id: &str,
    ) -> Result<()> {
        let parent = parent.context("CONNECTIVITY_PRIVATE_PARENT_REQUIRED")?;
        parent.check_process_for_captured_scope(context)?;
        let directory = self.verify(context)?;
        let data = control::data_directory(&directory, &self.initial)?;
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
        let lease = leases
            .get_mut(lease_id)
            .context("CONNECTIVITY_LEASE_UNAVAILABLE")?;
        ensure!(
            lease.parent.id == parent.id
                && lease.expires_at > now()?
                && !lease.activation_ready
                && lease.kernel.is_some(),
            "CONNECTIVITY_ORIGINAL_BOOTSTRAP_REQUIRED"
        );
        if lease.create {
            let entries =
                control::read_log(&self.log_anchor, &self.initial, &self.initial_identity)?;
            ensure!(
                matches!(
                    entries.as_slice(),
                    [BootstrapEntry::Seed { .. }, BootstrapEntry::Issued { .. }]
                ),
                "CONNECTIVITY_ORIGINAL_INITIALIZATION_REQUIRED"
            );
            windows_bootstrap::seal_created_files(&directory, &data, &lease.verified_files)?;
        }
        control::verify_node_store(&directory, &data, self.domain.namespace_id(), &self.initial)?;
        for (name, (file, identity)) in windows_bootstrap::prepare_sidecars(&data)? {
            if let Some((_, original)) = lease.verified_files.get(&name) {
                ensure!(*original == identity, "CONNECTIVITY_PRIVATE_FILE_CHANGED");
            } else {
                lease.verified_files.insert(name, (file, identity));
            }
        }
        ensure!(lease.expires_at > now()?, "CONNECTIVITY_LEASE_EXPIRED");
        parent.check_process_for_captured_scope(context)?;
        self.verify(context)?;
        Ok(())
    }
    pub fn verify_private_path(
        &self,
        context: &NativeIntegrationContext,
        parent: Option<&NativeConnectivityParent>,
        lease_id: &str,
        path: &Path,
    ) -> Result<()> {
        let parent = parent.context("CONNECTIVITY_PRIVATE_PARENT_REQUIRED")?;
        parent.check_process_for_captured_scope(context)?;
        let directory = self.verify(context)?;
        let data = control::data_directory(&directory, &self.initial)?;
        let expected = context
            .captured_profile_path()
            .join(self.domain.namespace_id())
            .join(control::DATA);
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
        let lease = leases
            .get_mut(lease_id)
            .context("CONNECTIVITY_LEASE_UNAVAILABLE")?;
        ensure!(
            lease.parent.id == parent.id && lease.expires_at > now()?,
            "CONNECTIVITY_LEASE_OWNER_MISMATCH"
        );
        if path == expected {
            data.verify_private_directory()?;
        } else {
            let (key, file) = if path == expected.with_file_name("data.binding.json") {
                (
                    "binding".to_owned(),
                    directory.open_single_link_regular_file(OsStr::new("data.binding.json"))?,
                )
            } else {
                let name = path
                    .file_name()
                    .context("CONNECTIVITY_PRIVATE_PATH_DENIED")?;
                ensure!(
                    path.parent() == Some(expected.as_path())
                        && [
                            "connectivity.sqlite3",
                            "connectivity.lock",
                            "connectivity.ready.json",
                            "connectivity.sqlite3-wal",
                            "connectivity.sqlite3-shm",
                            "connectivity.sqlite3-journal"
                        ]
                        .iter()
                        .any(|allowed| name == OsStr::new(allowed)),
                    "CONNECTIVITY_PRIVATE_PATH_DENIED"
                );
                (
                    name.to_string_lossy().into_owned(),
                    data.open_single_link_regular_file(name)?,
                )
            };
            let identity = PortableLeaseIdentity::from_regular_handle(&file)?;
            if let Some((_, original)) = lease.verified_files.get(&key) {
                ensure!(original == &identity, "CONNECTIVITY_PRIVATE_FILE_CHANGED");
            } else {
                lease.verified_files.insert(key, (file, identity));
            }
        }
        parent.check_process_for_captured_scope(context)?;
        self.verify(context)?;
        Ok(())
    }
    pub fn release(
        &self,
        context: &NativeIntegrationContext,
        parent: Option<&NativeConnectivityParent>,
        lease_id: &str,
    ) -> Result<bool> {
        let parent = parent.context("CONNECTIVITY_PRIVATE_PARENT_REQUIRED")?;
        context.verify()?;
        ensure!(
            IntegrationOwner::from(context.scope()) == self.initial.owner
                && IntegrationOwner::from(&parent.scope) == self.initial.owner,
            "CONNECTIVITY_STORAGE_OWNER_MISMATCH"
        );
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
        let lease = leases
            .get(lease_id)
            .context("CONNECTIVITY_LEASE_UNAVAILABLE")?;
        ensure!(
            lease.parent.id == parent.id,
            "CONNECTIVITY_LEASE_OWNER_MISMATCH"
        );
        if parent.alive()? {
            return Ok(false);
        }
        leases.remove(lease_id);
        Ok(true)
    }
    fn reply(&self, lease: &ActiveLease) -> NativeConnectivityLeaseReply {
        NativeConnectivityLeaseReply {
            lease_id: lease.id.clone(),
            namespace_id: self.domain.namespace_id().into(),
            expires_at: lease.expires_at,
            stage: if lease.activation_ready {
                "ready"
            } else if lease.create {
                "initializing"
            } else {
                "reconciling"
            },
            store_mode: if lease.create {
                "create"
            } else {
                "open_existing"
            },
            initialization_id: self.initial.initialization_id.clone(),
        }
    }
}
fn now() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}
fn expires() -> Result<u64> {
    now()?
        .checked_add(30000)
        .context("CONNECTIVITY_LEASE_CLOCK_UNAVAILABLE")
}

#[cfg(test)]
#[path = "lease/tests.rs"]
pub mod tests;

#[cfg(windows)]
#[path = "lease/windows_bootstrap.rs"]
mod windows_bootstrap;
