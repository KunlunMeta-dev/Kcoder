//! Offline owner relocation keeps logical initialization and the original bootstrap log.
use super::*;
use control::relocation as receipt;
use control::relocation::RelocationBinding;
use kcoder_config::storage::StoragePublishedComponent;
use kcoder_native_scope::{NativeDomainRelocation, NativeIdentity, NativeObservedDomain};
#[path = "relocation/authority.rs"]
mod authority;
use authority::{SourceAuthority, TargetAuthority};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConnectivityRelocationReceipt {
    pub operation_id: String,
    pub namespace_id: String,
    pub initialization_id: String,
    pub source_binding_hash: String,
    pub binding_hash: String,
}

/// The original source kernel lease may be retained across validation and copy,
/// then transferred without a gap to the target step. The stopped profile copier
/// uses separate preparation/conversion stages under continuous instance exclusion.
pub struct NativeConnectivityRelocationSource<'a> {
    source: &'a NativeConnectivityLeaseFacade,
    authority: SourceAuthority<'a>,
    operation_id: String,
    source_epoch: (String, u64),
    exited_parents: Vec<Arc<NativeConnectivityParent>>,
    source_initial_bytes: Vec<u8>,
    source_log_bytes: Vec<u8>,
    ready: BootstrapEntry,
    kernel: VerifiedPrivateLease,
    #[cfg(windows)]
    sidecars: BTreeMap<String, (File, PortableLeaseIdentity)>,
}

pub struct NativeConnectivityRelocation<'a> {
    source: NativeConnectivityRelocationSource<'a>,
    target_authority: TargetAuthority<'a>,
    domain: NativeDomainRelocation<'a>,
    target_epoch: (String, u64),
    target_data: PrivateDirectory,
    target_files: BTreeMap<String, (File, PortableLeaseIdentity)>,
    target_log: File,
    target_original_init: File,
    initial_anchor: File,
    initial_name: String,
    initial: Initialization,
    published: bool,
    target_kernel: VerifiedPrivateLease,
    #[cfg(windows)]
    target_sidecars: BTreeMap<String, (File, PortableLeaseIdentity)>,
}

impl NativeConnectivityLeaseFacade {
    /// Read-only support check. Legacy media has another identity owner and is
    /// rejected before publication rather than silently copied into a new grant.
    pub fn relocation_source_ready(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<BootstrapEntry> {
        self.verify(context)?;
        self.relocation_ready_at(context.captured_profile_path())
    }

    fn relocation_ready_at(&self, profile_path: &Path) -> Result<BootstrapEntry> {
        let entries = control::read_log(&self.log_anchor, &self.initial, &self.initial_identity)?;
        ensure!(
            !entries
                .iter()
                .any(|entry| matches!(entry, BootstrapEntry::MediaReady { .. })),
            "CONNECTIVITY_RELOCATION_MEDIA_UNSUPPORTED: {}",
            profile_path
                .join(self.domain.namespace_id())
                .join(control::LOG)
                .display()
        );
        let ready = entries
            .get(2)
            .context("CONNECTIVITY_RELOCATION_ORIGINAL_READY_REQUIRED")?
            .clone();
        receipt::ready_hash(&ready)?;
        Ok(ready)
    }

    /// The actual original profile fence excludes live hosts before inventory or
    /// copying. The returned opaque owner must remain held through prepare_target.
    pub fn prepare_relocation_source<'a>(
        &'a self,
        source_context: &'a NativeIntegrationContext,
        operation_id: &str,
    ) -> Result<NativeConnectivityRelocationSource<'a>> {
        self.prepare_source(SourceAuthority::Runtime(source_context), operation_id)
    }

    /// Load only an existing registered data owner. No workspace capture,
    /// activation, initialization or runtime authority is constructed here.
    pub fn observe_for_relocation(
        entry: &NativeObservedDomain,
        identity: &NativeIdentity,
        profile: &PrivateDirectory,
        profile_path: &Path,
    ) -> Result<Self> {
        ensure!(
            entry.domain() == NativeDomain::Connectivity,
            "CONNECTIVITY_RELOCATION_WRONG_DOMAIN"
        );
        entry.verify(identity, profile)?;
        ensure!(
            PrivateDirectory::open_existing(profile_path)?.directory_identity()?
                == profile.directory_identity()?,
            "CONNECTIVITY_RELOCATION_SOURCE_CHANGED"
        );
        let domain = entry.clone_domain_guard(identity, profile)?;
        ensure!(
            domain.namespace_id() == entry.namespace_id(),
            "CONNECTIVITY_RELOCATION_OWNER_CHANGED"
        );
        let result =
            Self::from_existing_domain(profile, &IntegrationOwner::from(entry.scope()), domain)?;
        result.relocation_ready_at(profile_path)?;
        entry.verify(identity, profile)?;
        Ok(result)
    }

    /// Adapt a stopped, fully published profile without a runtime context.
    /// Original kernel and marker leases live only for this owner conversion.
    pub fn prepare_relocation_offline<'a>(
        &'a self,
        entry: &'a NativeObservedDomain,
        identity: &'a NativeIdentity,
        profile: &'a PrivateDirectory,
        target_identity: &'a NativeIdentity,
        published: &'a StoragePublishedComponent,
    ) -> Result<NativeConnectivityRelocation<'a>> {
        self.prepare_relocation_source_offline(
            entry,
            identity,
            profile,
            published.source_path(),
            published.operation_id(),
        )?
        .prepare_target_authority(TargetAuthority::Offline {
            identity: target_identity,
            published,
        })
    }

    /// The stopped copier prepares only existing registered stores before its
    /// inventory. No runtime context or replacement initialization is created.
    pub fn prepare_relocation_source_offline<'a>(
        &'a self,
        entry: &'a NativeObservedDomain,
        identity: &'a NativeIdentity,
        profile: &'a PrivateDirectory,
        profile_path: &Path,
        operation_id: &str,
    ) -> Result<NativeConnectivityRelocationSource<'a>> {
        self.prepare_source(
            SourceAuthority::Offline {
                entry,
                identity,
                profile,
                path: profile_path.canonicalize()?,
            },
            operation_id,
        )
    }

    fn prepare_source<'a>(
        &'a self,
        authority: SourceAuthority<'a>,
        operation_id: &str,
    ) -> Result<NativeConnectivityRelocationSource<'a>> {
        receipt::validate_operation(operation_id)?;
        {
            let mut leases = self
                .leases
                .lock()
                .map_err(|_| anyhow::anyhow!("CONNECTIVITY_LEASE_STATE_UNAVAILABLE"))?;
            let mut exited_parents = Vec::new();
            for lease in leases.values() {
                ensure!(
                    !lease.parent.alive()?,
                    "CONNECTIVITY_RELOCATION_PARENT_STILL_ACTIVE"
                );
                exited_parents.push(lease.parent.clone());
            }
            leases.clear();
            drop(leases);
            let source_directory = authority.directory(self)?;
            let source_kernel = source_directory
                .try_existing_portable_lock(
                    OsStr::new(control::LOCK),
                    &self.initial.lock_identity,
                    PrivateLeaseMode::Exclusive,
                )?
                .context("CONNECTIVITY_PROFILE_BUSY")?;
            let ready = self.relocation_ready_at(authority.path())?;
            let source_epoch = authority.epoch()?;
            let source_initial_bytes = control::read_bytes(&self.initial_anchor)?;
            let source_log_bytes = control::read_bytes(&self.log_anchor)?;
            // SQLite's read-only Windows open may need WAL/SHM coordination.
            // Prepare only these fixed leaves under the original exclusive owner.
            #[cfg(windows)]
            let sidecars = windows_bootstrap::prepare_sidecars(&control::data_directory(
                &source_directory,
                &self.initial,
            )?)?;
            let owner = NativeConnectivityRelocationSource {
                source: self,
                authority,
                operation_id: operation_id.into(),
                source_epoch,
                exited_parents,
                source_initial_bytes,
                source_log_bytes,
                ready,
                kernel: source_kernel,
                #[cfg(windows)]
                sidecars,
            };
            owner.verify()?;
            Ok(owner)
        }
    }

    /// Compatibility entry for a target already published by the caller. Source
    /// preparation is still the same owner path, with no separate lease manager.
    pub fn prepare_relocation<'a>(
        &'a self,
        source_context: &'a NativeIntegrationContext,
        target_context: &'a NativeIntegrationContext,
        operation_id: &str,
    ) -> Result<NativeConnectivityRelocation<'a>> {
        self.prepare_relocation_source(source_context, operation_id)?
            .prepare_target(target_context)
    }
}

impl<'a> NativeConnectivityRelocationSource<'a> {
    pub fn source_data_path(&self) -> Result<PathBuf> {
        self.verify()?;
        Ok(self
            .authority
            .path()
            .join(self.namespace_id())
            .join(control::DATA))
    }
    /// A live proof for one exact private store entry, never a cached allow verdict.
    pub fn verify_private_path(&self, path: &Path) -> Result<()> {
        self.verify()?;
        let directory = self.authority.directory(self.source)?;
        let data = control::data_directory(&directory, &self.source.initial)?;
        let root = kcoder_config::storage::node_storage_path(&self.source_data_path()?)?;
        verify_private_path(&root, &directory, &data, path)?;
        self.verify()
    }
    pub fn namespace_id(&self) -> &str {
        self.source.domain.namespace_id()
    }
    pub fn initialization_id(&self) -> &str {
        &self.source.initial.initialization_id
    }
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub fn source_binding_hash(&self) -> Result<&str> {
        receipt::ready_hash(&self.ready)
    }

    pub fn verify(&self) -> Result<()> {
        ensure!(
            self.authority.epoch()? == self.source_epoch,
            "CONNECTIVITY_RELOCATION_EPOCH_CHANGED"
        );
        for parent in &self.exited_parents {
            ensure!(
                !parent.alive()?,
                "CONNECTIVITY_RELOCATION_PARENT_STILL_ACTIVE"
            );
        }
        let directory = self.authority.directory(self.source)?;
        verify_kernel(&directory, &self.kernel, &self.source.initial.lock_identity)?;
        #[cfg(windows)]
        verify_sidecars(
            &control::data_directory(&directory, &self.source.initial)?,
            &self.sidecars,
        )?;
        ensure!(
            control::read_bytes(&self.source.initial_anchor)? == self.source_initial_bytes
                && control::read_bytes(&self.source.log_anchor)? == self.source_log_bytes,
            "CONNECTIVITY_RELOCATION_SOURCE_CHANGED"
        );
        Ok(())
    }

    /// Consume the source owner only after the caller has copied and published
    /// final target directories. No gap releases or reacquires its original lock.
    pub fn prepare_target<'target>(
        self,
        target_context: &'target NativeIntegrationContext,
    ) -> Result<NativeConnectivityRelocation<'target>>
    where
        'a: 'target,
    {
        self.prepare_target_authority(TargetAuthority::Runtime(target_context))
    }

    fn prepare_target_authority<'target>(
        self,
        target_authority: TargetAuthority<'target>,
    ) -> Result<NativeConnectivityRelocation<'target>>
    where
        'a: 'target,
    {
        {
            self.verify()?;
            let source_state = self;
            let source = source_state.source;
            let target_epoch = source_state
                .authority
                .target_epoch(&target_authority, &source_state.operation_id)?;
            ensure!(
                source_state.source_epoch == target_epoch,
                "CONNECTIVITY_RELOCATION_EPOCH_CHANGED"
            );
            let domain = source.domain.prepare_relocation(
                source_state.authority.profile()?,
                target_authority.profile()?,
                &source_state.operation_id,
            )?;
            let target = domain.target_directory();
            let target_lock = target.open_single_link_regular_file(OsStr::new(control::LOCK))?;
            let target_lock_identity = target.portable_regular_handle_identity(&target_lock)?;
            let target_kernel = target
                .try_existing_portable_lock(
                    OsStr::new(control::LOCK),
                    &target_lock_identity,
                    PrivateLeaseMode::Exclusive,
                )?
                .context("CONNECTIVITY_PROFILE_BUSY")?;
            let target_log = target.open_single_link_regular_file(OsStr::new(control::LOG))?;
            ensure!(
                control::read_bytes(&target_log)? == source_state.source_log_bytes,
                "CONNECTIVITY_RELOCATION_SOURCE_LOG_CHANGED"
            );
            let target_data = target.open_child(OsStr::new(control::DATA), false)?;
            target_data.verify_private_directory()?;
            #[cfg(windows)]
            let target_sidecars = windows_bootstrap::prepare_sidecars(&target_data)?;
            let target_files = hold_files(target, &target_data)?;
            let copied = target.open_single_link_regular_file(OsStr::new(control::INIT))?;
            let copied_bytes = control::read_bytes(&copied)?;
            let published = copied_bytes != source_state.source_initial_bytes;
            let initial_name = if published {
                control::INIT.into()
            } else {
                format!(
                    ".channel-host-relocation-{}.prepared",
                    receipt::digest(source_state.operation_id.as_bytes())
                )
            };
            let mut initial_anchor = if published {
                target.open_read_write_file(OsStr::new(control::INIT), false)?
            } else {
                match target.open_read_write_file(OsStr::new(&initial_name), true) {
                    Ok(file) => file,
                    Err(error) if exists(&error) => {
                        target.open_read_write_file(OsStr::new(&initial_name), false)?
                    }
                    Err(error) => return Err(error),
                }
            };
            let mut initial = source.initial.clone();
            initial.version = 2;
            initial.lock_identity = target_lock_identity;
            initial.log_identity = target.portable_regular_handle_identity(&target_log)?;
            initial.data_directory_identity = target_data.directory_identity()?;
            initial.relocation = Some(Box::new(RelocationBinding {
                operation_id: source_state.operation_id.clone(),
                namespace_id: source.domain.namespace_id().into(),
                initialization_identity: target
                    .portable_regular_handle_identity(&initial_anchor)?,
                source_initialization_identity: source.initial_identity.clone(),
                log_initialization_identity: source.initial.relocation.as_ref().map_or_else(
                    || source.initial_identity.clone(),
                    |value| value.log_initialization_identity.clone(),
                ),
                source_initialization_sha256: receipt::digest(&source_state.source_initial_bytes),
                source_log_sha256: receipt::digest(&source_state.source_log_bytes),
                source_ready: source_state.ready.clone(),
                target_files: target_files
                    .iter()
                    .map(|(name, (_, identity))| (name.clone(), identity.clone()))
                    .collect(),
                ready: None,
            }));
            if initial_anchor.metadata()?.len() == 0 {
                ensure!(!published, "CONNECTIVITY_RELOCATION_OPERATION_CONFLICT");
                receipt::write_preparation(&mut initial_anchor, &initial)?;
                target.sync()?;
            }
            let current = receipt::read_preparation(&initial_anchor)?;
            let mut header = current.clone();
            header.relocation.as_mut().unwrap().ready = None;
            ensure!(
                header == initial,
                "CONNECTIVITY_RELOCATION_OPERATION_CONFLICT"
            );
            initial = current;
            ensure!(
                !domain.is_committed()
                    || published && initial.relocation.as_ref().unwrap().ready.is_some(),
                "CONNECTIVITY_RELOCATION_READY_UNCONFIRMED"
            );
            let transaction = NativeConnectivityRelocation {
                source: source_state,
                target_authority,
                domain,
                target_epoch,
                target_data,
                target_files,
                target_log,
                target_original_init: copied,
                initial_anchor,
                initial_name,
                initial,
                published,
                target_kernel,
                #[cfg(windows)]
                target_sidecars,
            };
            transaction.verify()?;
            Ok(transaction)
        }
    }
}

impl NativeConnectivityRelocation<'_> {
    pub fn source_data_path(&self) -> Result<PathBuf> {
        self.verify()?;
        Ok(self
            .source
            .authority
            .path()
            .join(self.namespace_id())
            .join(control::DATA))
    }
    pub fn target_data_path(&self) -> Result<PathBuf> {
        self.verify()?;
        Ok(self
            .target_authority
            .path()
            .join(self.namespace_id())
            .join(control::DATA))
    }
    /// Both original exclusive leases and the real private path are rechecked.
    pub fn verify_private_path(&self, path: &Path) -> Result<()> {
        self.verify()?;
        let source = kcoder_config::storage::node_storage_path(&self.source_data_path()?)?;
        if path == source
            || path.parent() == Some(source.as_path())
            || path == source.with_extension("binding.json")
            || path == source.with_extension("relocation.json")
        {
            self.source.verify_private_path(path)?;
        } else {
            verify_private_path(
                &kcoder_config::storage::node_storage_path(&self.target_data_path()?)?,
                self.domain.target_directory(),
                &self.target_data,
                path,
            )?;
        }
        self.verify()
    }
    pub fn namespace_id(&self) -> &str {
        self.source.namespace_id()
    }
    pub fn initialization_id(&self) -> &str {
        &self.initial.initialization_id
    }
    pub fn operation_id(&self) -> Result<&str> {
        Ok(&self
            .initial
            .relocation
            .as_ref()
            .context("CONNECTIVITY_RELOCATION_RECEIPT_REQUIRED")?
            .operation_id)
    }
    pub fn source_binding_hash(&self) -> Result<&str> {
        receipt::ready_hash(
            &self
                .initial
                .relocation
                .as_ref()
                .context("CONNECTIVITY_RELOCATION_RECEIPT_REQUIRED")?
                .source_ready,
        )
    }

    pub fn verify(&self) -> Result<()> {
        self.source.verify()?;
        ensure!(
            self.source
                .authority
                .target_epoch(&self.target_authority, self.operation_id()?)?
                == self.target_epoch,
            "CONNECTIVITY_RELOCATION_EPOCH_CHANGED"
        );
        self.domain.verify()?;
        ensure!(
            control::read_bytes(&self.target_log)? == self.source.source_log_bytes,
            "CONNECTIVITY_RELOCATION_SOURCE_CHANGED"
        );
        let directory = self.domain.target_directory();
        verify_kernel(directory, &self.target_kernel, &self.initial.lock_identity)?;
        ensure!(
            directory.portable_regular_identity(OsStr::new(control::LOG))?
                == self.initial.log_identity
                && control::data_directory(directory, &self.initial)?.directory_identity()?
                    == self.target_data.directory_identity()?
                && directory.portable_regular_identity(OsStr::new(&self.initial_name))?
                    == directory.portable_regular_handle_identity(&self.initial_anchor)?,
            "CONNECTIVITY_RELOCATION_TARGET_CHANGED"
        );
        ensure!(
            receipt::read_preparation(&self.initial_anchor)? == self.initial,
            "CONNECTIVITY_RELOCATION_TARGET_CHANGED"
        );
        if !self.published {
            let current = directory.open_single_link_regular_file(OsStr::new(control::INIT))?;
            ensure!(
                directory.portable_regular_handle_identity(&current)?
                    == directory.portable_regular_handle_identity(&self.target_original_init)?
                    && control::read_bytes(&current)? == self.source.source_initial_bytes,
                "CONNECTIVITY_RELOCATION_TARGET_CHANGED"
            );
        }
        verify_files(directory, &self.target_data, &self.target_files)?;
        #[cfg(windows)]
        verify_sidecars(&self.target_data, &self.target_sidecars)?;
        Ok(())
    }

    pub fn query(&self) -> Result<Option<NativeConnectivityRelocationReceipt>> {
        self.verify()?;
        if !self.published || !self.domain.is_committed() {
            return Ok(None);
        }
        let ready = control::verify_node_store(
            self.domain.target_directory(),
            &self.target_data,
            self.namespace_id(),
            &self.initial,
        )?;
        ensure!(
            self.initial.relocation.as_ref().unwrap().ready.as_ref() == Some(&ready),
            "CONNECTIVITY_RELOCATION_READY_UNCONFIRMED"
        );
        Ok(Some(self.result(&ready)?))
    }

    /// The helper's hash is checked against the actual final private files.
    /// It cannot issue a namespace, initialization or source authorization.
    pub fn commit(mut self, new_binding_hash: &str) -> Result<NativeConnectivityRelocationReceipt> {
        self.verify()?;
        let directory = self.domain.target_directory();
        let ready = control::verify_node_store(
            directory,
            &self.target_data,
            self.namespace_id(),
            &self.initial,
        )?;
        ensure!(
            receipt::ready_hash(&ready)? == new_binding_hash,
            "CONNECTIVITY_RELOCATION_READY_HASH_MISMATCH"
        );
        let result = self.result(&ready)?;
        self.initial =
            receipt::append_ready(&mut self.initial_anchor, &self.initial, ready.clone())?;
        directory.sync()?;
        self.verify()?;
        if !self.published {
            directory.publish_prepared(
                OsStr::new(&self.initial_name),
                OsStr::new(control::INIT),
                &PrivateDirectory::identity_of_file(&self.initial_anchor)?,
            )?;
            self.published = true;
            self.initial_name = control::INIT.into();
        }
        self.verify()?;
        let expected = self.initial.clone();
        let original_log = self.source.source_log_bytes.clone();
        let target_files = &self.target_files;
        let target_data = &self.target_data;
        let source = &self.source;
        let target_authority = &self.target_authority;
        let target_epoch = &self.target_epoch;
        self.domain.commit(|_, target| {
            source.verify()?;
            ensure!(
                &source
                    .authority
                    .target_epoch(target_authority, &source.operation_id)?
                    == target_epoch,
                "CONNECTIVITY_RELOCATION_EPOCH_CHANGED"
            );
            let initial_file = target.open_single_link_regular_file(OsStr::new(control::INIT))?;
            let initial = control::read_initialization(&initial_file)?;
            ensure!(
                initial == expected,
                "CONNECTIVITY_RELOCATION_TARGET_CHANGED"
            );
            let log = target.open_single_link_regular_file(OsStr::new(control::LOG))?;
            ensure!(
                control::read_bytes(&log)? == original_log,
                "CONNECTIVITY_RELOCATION_SOURCE_LOG_CHANGED"
            );
            let entries = control::read_log(
                &log,
                &initial,
                &target.portable_regular_handle_identity(&initial_file)?,
            )?;
            verify_files(target, target_data, target_files)?;
            ensure!(
                entries.get(2) == Some(&ready)
                    && control::verify_node_store(
                        target,
                        target_data,
                        &result.namespace_id,
                        &initial
                    )? == ready,
                "CONNECTIVITY_RELOCATION_READY_UNCONFIRMED"
            );
            Ok(())
        })?;
        Ok(result)
    }

    fn result(&self, ready: &BootstrapEntry) -> Result<NativeConnectivityRelocationReceipt> {
        Ok(NativeConnectivityRelocationReceipt {
            operation_id: self
                .initial
                .relocation
                .as_ref()
                .context("CONNECTIVITY_RELOCATION_RECEIPT_REQUIRED")?
                .operation_id
                .clone(),
            namespace_id: self.namespace_id().into(),
            initialization_id: self.initialization_id().into(),
            source_binding_hash: self.source_binding_hash()?.into(),
            binding_hash: receipt::ready_hash(ready)?.into(),
        })
    }
}

// Restrict the original owner's proof to the fixed store leaves. Metadata-only
// observation is insufficient: these primitives also verify held file identity.
fn verify_private_path(
    root: &Path,
    directory: &PrivateDirectory,
    data: &PrivateDirectory,
    path: &Path,
) -> Result<()> {
    if path == root {
        return data.verify_private_directory();
    }
    let (parent, name) = if path == root.with_extension("binding.json") {
        (directory, OsStr::new("data.binding.json"))
    } else if path == root.with_extension("relocation.json") {
        (directory, OsStr::new("data.relocation.json"))
    } else {
        let name = path
            .file_name()
            .context("CONNECTIVITY_PRIVATE_PATH_DENIED")?;
        ensure!(
            path.parent() == Some(root)
                && [
                    "connectivity.sqlite3",
                    "connectivity.lock",
                    "connectivity.ready.json",
                    "connectivity.sqlite3-wal",
                    "connectivity.sqlite3-shm",
                    "connectivity.sqlite3-journal",
                ]
                .iter()
                .any(|allowed| name == OsStr::new(allowed)),
            "CONNECTIVITY_PRIVATE_PATH_DENIED"
        );
        (data, name)
    };
    let file = parent.open_single_link_regular_file(name)?;
    ensure!(
        parent.portable_regular_handle_identity(&file)?
            == parent.portable_regular_identity(name)?,
        "CONNECTIVITY_PRIVATE_FILE_CHANGED"
    );
    Ok(())
}

#[cfg(windows)]
fn verify_sidecars(
    data: &PrivateDirectory,
    files: &BTreeMap<String, (File, PortableLeaseIdentity)>,
) -> Result<()> {
    for (name, (file, identity)) in files {
        ensure!(
            data.portable_regular_handle_identity(file)? == *identity
                && data.portable_regular_identity(OsStr::new(name))? == *identity,
            "CONNECTIVITY_PRIVATE_FILE_CHANGED"
        );
    }
    Ok(())
}

fn verify_kernel(
    directory: &PrivateDirectory,
    kernel: &VerifiedPrivateLease,
    expected: &PortableLeaseIdentity,
) -> Result<()> {
    ensure!(
        kernel.identity() == expected
            && directory.portable_regular_handle_identity(kernel.file())? == *expected
            && directory.portable_regular_identity(OsStr::new(control::LOCK))? == *expected,
        "CONNECTIVITY_RELOCATION_KERNEL_CHANGED"
    );
    Ok(())
}

fn hold_files(
    directory: &PrivateDirectory,
    data: &PrivateDirectory,
) -> Result<BTreeMap<String, (File, PortableLeaseIdentity)>> {
    let mut files = BTreeMap::new();
    for (key, name) in [
        ("binding", "data.binding.json"),
        ("ready", "connectivity.ready.json"),
        ("database", "connectivity.sqlite3"),
        ("lock", "connectivity.lock"),
    ] {
        let parent = if key == "binding" { directory } else { data };
        let file = parent.open_single_link_regular_file(OsStr::new(name))?;
        let identity = parent.portable_regular_handle_identity(&file)?;
        files.insert(key.into(), (file, identity));
    }
    Ok(files)
}

fn verify_files(
    directory: &PrivateDirectory,
    data: &PrivateDirectory,
    files: &BTreeMap<String, (File, PortableLeaseIdentity)>,
) -> Result<()> {
    for (key, name) in [
        ("binding", "data.binding.json"),
        ("ready", "connectivity.ready.json"),
        ("database", "connectivity.sqlite3"),
        ("lock", "connectivity.lock"),
    ] {
        let parent = if key == "binding" { directory } else { data };
        let (file, identity) = files
            .get(key)
            .context("CONNECTIVITY_RELOCATION_FILE_UNAVAILABLE")?;
        ensure!(
            parent.portable_regular_handle_identity(file)? == *identity
                && parent.portable_regular_identity(OsStr::new(name))? == *identity,
            "CONNECTIVITY_RELOCATION_TARGET_CHANGED"
        );
    }
    Ok(())
}

fn exists(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists)
    })
}

#[cfg(test)]
#[path = "relocation/tests.rs"]
mod tests;
