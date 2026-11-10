use super::model::*;
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub(super) struct Store {
    pub profile: PathBuf,
    pub identity: String,
    pub authority: TransferAuthority,
    role: &'static str,
    existing_only: bool,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct NativeIdentity {
    directory: String,
    instance: String,
    account: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    private_credentials_birth: Option<PrivateCredentialBirth>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PrivateCredentialBirth {
    directory: Option<String>,
    catalog_lock: Option<PortableLeaseIdentity>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Reservation {
    owner: String,
    request: String,
    binding: String,
    bytes: u64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Anchor {
    pub owner: String,
    pub directory: String,
    pub request: String,
    pub binding: String,
    pub writer: PortableLeaseIdentity,
    pub controller: PortableLeaseIdentity,
}

#[derive(Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Control {
    pub sequence: u64,
    pub cancelled: u64,
    pub acknowledged: u64,
    pub commands: Vec<String>,
    pub completed_entries: u32,
}
impl Control {
    pub fn state(&self, ready: bool) -> TransferState {
        TransferState {
            sequence: self.sequence,
            cancel_watermark: self.cancelled,
            cancelled: self.cancelled != self.acknowledged,
            ready,
        }
    }
}

impl Store {
    /// Secret recovery verifies the original namespace without recreating a
    /// removed ordinary incoming role or consulting a source filesystem.
    pub(super) fn reopen_private_credentials(
        profile: &Path,
        identity: &str,
        authority: &TransferAuthority,
    ) -> Result<Self> {
        ensure!(profile.is_absolute(), "source_transfer_invalid_profile");
        authority.validate()?;
        let store = Self {
            profile: profile.into(),
            identity: identity.into(),
            authority: authority.clone(),
            role: "incoming",
            existing_only: true,
        };
        store.verify_authority()?;
        store.private_credential_root(false)?;
        Ok(store)
    }
    pub(super) fn reopen_existing(
        profile: &Path,
        identity: &str,
        authority: &TransferAuthority,
        role: &'static str,
    ) -> Result<Self> {
        ensure!(
            profile.is_absolute()
                && matches!(
                    role,
                    "incoming" | "exports" | "browser-uploads" | "browser-products"
                ),
            "source_transfer_invalid_profile"
        );
        authority.validate()?;
        let store = Self {
            profile: profile.into(),
            identity: identity.into(),
            authority: authority.clone(),
            role,
            existing_only: true,
        };
        let namespace = store.verify_authority()?;
        namespace
            .open_child(OsStr::new(role), false)?
            .verify_private_directory()?;
        Ok(store)
    }
    pub fn open_existing(profile: &Path, role: &'static str) -> Result<Self> {
        ensure!(
            profile.is_absolute()
                && matches!(
                    role,
                    "incoming" | "exports" | "browser-uploads" | "browser-products"
                ),
            "source_transfer_invalid_profile"
        );
        let directory = PrivateDirectory::open_existing(profile)?;
        directory.verify_private_directory()?;
        let identity = directory.directory_identity()?;
        let namespace = directory
            .open_child(OsStr::new("migrations"), false)?
            .open_child(OsStr::new("source-transfer"), false)?;
        namespace.verify_private_directory()?;
        let native: NativeIdentity =
            load(&namespace, "native.json")?.context("source_transfer_owner_changed")?;
        ensure!(
            native.directory == identity && native.account == current_account()?,
            "source_transfer_owner_changed"
        );
        valid_uuid(&native.instance)?;
        let authority = TransferAuthority {
            instance_id: native.instance,
            account_id: digest(&("source-transfer.account/1", &native.account, &identity))?,
        };
        Self::reopen_existing(profile, &identity, &authority, role)
    }
    pub fn open(profile: &Path, role: &'static str) -> Result<Self> {
        ensure!(profile.is_absolute(), "source_transfer_invalid_profile");
        let directory = PrivateDirectory::open_or_create(profile)?;
        directory.verify_private_directory()?;
        let identity = directory.directory_identity()?;
        let namespace = directory
            .open_child(OsStr::new("migrations"), true)?
            .open_child(OsStr::new("source-transfer"), true)?;
        namespace.verify_private_directory()?;
        let account = current_account()?;
        let native = if let Some(existing) = load::<NativeIdentity>(&namespace, "native.json")? {
            existing
        } else {
            let _lease = lease(&namespace, "identity.lock")?;
            if let Some(existing) = load::<NativeIdentity>(&namespace, "native.json")? {
                existing
            } else {
                let value = NativeIdentity {
                    directory: identity.clone(),
                    instance: uuid::Uuid::new_v4().to_string(),
                    account: account.clone(),
                    private_credentials_birth: None,
                };
                exact(&namespace, "native.json", &value)?;
                value
            }
        };
        ensure!(
            native.directory == identity && native.account == account,
            "source_transfer_owner_changed"
        );
        valid_uuid(&native.instance)?;
        let authority = TransferAuthority {
            instance_id: native.instance,
            account_id: digest(&("source-transfer.account/1", &native.account, &identity))?,
        };
        Ok(Self {
            profile: profile.into(),
            identity,
            authority,
            role,
            existing_only: false,
        })
    }
    pub fn verify_authority(&self) -> Result<PrivateDirectory> {
        let profile = PrivateDirectory::open_existing(&self.profile)?;
        profile.verify_private_directory()?;
        ensure!(
            profile.directory_identity()? == self.identity,
            "source_transfer_owner_changed"
        );
        let namespace = profile
            .open_child(OsStr::new("migrations"), false)?
            .open_child(OsStr::new("source-transfer"), false)?;
        namespace.verify_private_directory()?;
        let native: NativeIdentity =
            load(&namespace, "native.json")?.context("source_transfer_owner_changed")?;
        ensure!(
            native.directory == self.identity
                && native.instance == self.authority.instance_id
                && native.account == current_account()?,
            "source_transfer_owner_changed"
        );
        Ok(namespace)
    }

    /// Only explicit private-channel initialization may create this independent
    /// secret namespace. A published pending birth or missing owned child never
    /// becomes a fresh key-generation authority after a restart.
    pub(super) fn private_credential_root(
        &self,
        create: bool,
    ) -> Result<(PrivateDirectory, PortableLeaseIdentity)> {
        let namespace = self.verify_authority()?;
        let mut native: NativeIdentity =
            load(&namespace, "native.json")?.context("private_credentials_owner_unknown")?;
        // Observing an existing private root never creates or repairs a lock.
        let _lease = if native.private_credentials_birth.is_none() && create {
            let guard = lease(&namespace, "identity.lock")?;
            native =
                load(&namespace, "native.json")?.context("private_credentials_owner_unknown")?;
            Some(guard)
        } else {
            None
        };
        ensure!(
            native.directory == self.identity
                && native.instance == self.authority.instance_id
                && native.account == current_account()?,
            "private_credentials_owner_unknown"
        );
        if native.private_credentials_birth.is_none() {
            ensure!(create, "private_credentials_unavailable");
            match namespace.open_child(OsStr::new("private-credentials"), false) {
                Err(error) if missing(&error) => {}
                _ => anyhow::bail!("private_credentials_owner_unknown"),
            }
            native.private_credentials_birth = Some(PrivateCredentialBirth {
                directory: None,
                catalog_lock: None,
            });
            save(&namespace, "native.json", &native)?;
            let directory = namespace.create_private_child(OsStr::new("private-credentials"))?;
            let _catalog = lease(&directory, "catalog.lock")?;
            exact(
                &directory,
                "catalog.json",
                &serde_json::json!({"version":1,"operations":{}}),
            )?;
            native.private_credentials_birth = Some(PrivateCredentialBirth {
                directory: Some(directory.directory_identity()?),
                catalog_lock: Some(
                    directory.portable_regular_identity(OsStr::new("catalog.lock"))?,
                ),
            });
            save(&namespace, "native.json", &native)?;
        }
        let birth = native
            .private_credentials_birth
            .context("private_credentials_owner_unknown")?;
        let expected = birth
            .directory
            .context("private_credentials_owner_unknown")?;
        let lock = birth
            .catalog_lock
            .context("private_credentials_owner_unknown")?;
        let directory = namespace.open_child(OsStr::new("private-credentials"), false)?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            directory.directory_identity()? == expected
                && directory.portable_regular_identity(OsStr::new("catalog.lock"))? == lock,
            "private_credentials_owner_unknown"
        );
        directory.open_single_link_regular_file(OsStr::new("catalog.json"))?;
        Ok((directory, lock))
    }
    pub fn root(&self) -> Result<PrivateDirectory> {
        let namespace = self.verify_authority()?;
        let directory = namespace.open_child(OsStr::new(self.role), !self.existing_only)?;
        directory.verify_private_directory()?;
        Ok(directory)
    }
    pub fn require_creation(&self) -> Result<()> {
        ensure!(!self.existing_only, "source_transfer_recovery_scope");
        Ok(())
    }
    /// Derive a sibling role from an existing verified namespace. This never
    /// initializes native identity after loss or changes the authenticated owner.
    pub(super) fn sibling(&self, role: &'static str, create: bool) -> Result<Self> {
        ensure!(
            role == "browser-products" && self.role == "browser-uploads",
            "source_transfer_recovery_scope"
        );
        let namespace = self.verify_authority()?;
        namespace
            .open_child(OsStr::new(role), create)?
            .verify_private_directory()?;
        Ok(Self {
            profile: self.profile.clone(),
            identity: self.identity.clone(),
            authority: self.authority.clone(),
            role,
            existing_only: !create,
        })
    }
    pub fn has_operation(&self, request: &str) -> Result<bool> {
        valid_uuid(request)?;
        let root = self.root()?;
        if load::<Anchor>(&root, &format!("{request}.json"))?.is_some() {
            self.existing(request)?;
            return Ok(true);
        }
        match root.open_child(OsStr::new(request), false) {
            Err(error) if missing(&error) => Ok(false),
            Ok(_) => anyhow::bail!("source_transfer_recovery_required"),
            Err(error) => Err(error),
        }
    }
    pub fn operation(
        &self,
        request: &str,
        binding: &str,
        create: bool,
    ) -> Result<PrivateDirectory> {
        valid_uuid(request)?;
        if create {
            self.require_creation()?;
        }
        let root = self.root()?;
        // Existing anchors/control files are atomically published and identity
        // checked below. Readers never contend with unrelated catalog creation.
        let _lease = if create {
            Some(lease(&root, "operations.lock")?)
        } else {
            None
        };
        let (directory, fresh) = match root.open_child(OsStr::new(request), false) {
            Ok(directory) => (directory, false),
            Err(error) if create && missing(&error) => {
                ensure!(
                    root.count_regular_files_bounded(
                        |name| name
                            .to_str()
                            .and_then(|name| name.strip_suffix(".json"))
                            .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok()),
                        256
                    )? < 256,
                    "source_transfer_operation_limit"
                );
                (root.create_private_child(OsStr::new(request))?, true)
            }
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        if fresh {
            // Only a newly created owned directory may initialize cancellation/lock state.
            // Missing control after publication is an unknown outcome, never a reset.
            let _writer = lease(&directory, "writer.lock")?;
            let _controller = lease(&directory, "control.lock")?;
            let anchor = Anchor {
                owner: self.identity.clone(),
                directory: directory.directory_identity()?,
                request: request.into(),
                binding: binding.into(),
                writer: directory.portable_regular_identity(OsStr::new("writer.lock"))?,
                controller: directory.portable_regular_identity(OsStr::new("control.lock"))?,
            };
            exact(&directory, "control.json", &Control::default())?;
            exact(&directory, "binding.json", &anchor)?;
            exact(&root, &format!("{request}.json"), &anchor)?;
        }
        let old: Anchor =
            load(&directory, "binding.json")?.context("source_transfer_recovery_required")?;
        let anchor = Anchor {
            owner: self.identity.clone(),
            directory: directory.directory_identity()?,
            request: request.into(),
            binding: binding.into(),
            writer: old.writer.clone(),
            controller: old.controller.clone(),
        };
        ensure!(old == anchor, "source_transfer_binding_changed");
        control(&directory)?;
        // Reconcile a lost catalog receipt using the already bound directory; never adopt it.
        if create {
            exact(&root, &format!("{request}.json"), &anchor)?;
        }
        Ok(directory)
    }
    pub fn existing(&self, request: &str) -> Result<PrivateDirectory> {
        valid_uuid(request)?;
        let root = self.root()?;
        let anchor: Anchor =
            load(&root, &format!("{request}.json"))?.context("source_transfer_unavailable")?;
        ensure!(
            anchor.owner == self.identity && anchor.request == request,
            "source_transfer_owner_changed"
        );
        self.operation(request, &anchor.binding, false)
    }
    pub fn reserve(&self, request: &str, binding: &str, bytes: u64) -> Result<()> {
        self.require_creation()?;
        valid_uuid(request)?;
        let maximum = if self.role == "browser-uploads" {
            TRANSFER_MAX_BYTES * 2
        } else {
            TRANSFER_MAX_BYTES
        };
        ensure!(bytes <= maximum, "source_transfer_budget_exceeded");
        let root = self.root()?;
        let _lease = lease(&root, "operations.lock")?;
        let reservation = Reservation {
            owner: self.identity.clone(),
            request: request.into(),
            binding: binding.into(),
            bytes,
        };
        let name = format!("reserve-{request}.json");
        if let Some(old) = load::<Reservation>(&root, &name)? {
            ensure!(old == reservation, "source_transfer_request_changed");
            return Ok(());
        }
        let mut total = 0u64;
        let mut count = 0usize;
        root.visit_regular_files(
            |name| {
                name.to_str()
                    .is_some_and(|name| name.starts_with("reserve-") && name.ends_with(".json"))
            },
            |name, file| {
                count += 1;
                ensure!(
                    count < 256 && file.metadata()?.len() <= 4096,
                    "source_transfer_operation_limit"
                );
                let old: Reservation = load(
                    &root,
                    name.to_str().context("source_transfer_invalid_metadata")?,
                )?
                .context("source_transfer_invalid_metadata")?;
                ensure!(
                    old.owner == self.identity && old.bytes <= maximum,
                    "source_transfer_owner_changed"
                );
                valid_uuid(&old.request)?;
                ensure!(
                    name == OsStr::new(&format!("reserve-{}.json", old.request)),
                    "source_transfer_invalid_metadata"
                );
                total = total
                    .checked_add(old.bytes)
                    .context("source_transfer_budget_exceeded")?;
                Ok(())
            },
        )?;
        ensure!(
            total
                .checked_add(bytes)
                .is_some_and(|total| total <= TRANSFER_MAX_STORE_BYTES),
            "source_transfer_storage_budget_exceeded"
        );
        exact(&root, &name, &reservation)
    }
}

pub(super) fn load<T: DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<Option<T>> {
    let mut file = match directory.open_regular_file_snapshot(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    ensure!(
        file.metadata()?.len() <= MAX_METADATA_BYTES,
        "source_transfer_metadata_budget_exceeded"
    );
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_METADATA_BYTES,
        "source_transfer_metadata_budget_exceeded"
    );
    Ok(Some(serde_json::from_slice(&bytes).map_err(|_| {
        anyhow::anyhow!("source_transfer_invalid_metadata")
    })?))
}
pub(super) fn save(directory: &PrivateDirectory, name: &str, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() as u64 <= MAX_METADATA_BYTES,
        "source_transfer_metadata_budget_exceeded"
    );
    directory.atomic_replace(OsStr::new(name), &bytes)
}
pub(super) fn exact<T: Serialize + DeserializeOwned + PartialEq>(
    directory: &PrivateDirectory,
    name: &str,
    value: &T,
) -> Result<()> {
    if let Some(existing) = load::<T>(directory, name)? {
        ensure!(&existing == value, "source_transfer_binding_changed");
        return Ok(());
    }
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() as u64 <= MAX_METADATA_BYTES,
        "source_transfer_metadata_budget_exceeded"
    );
    directory.atomic_publish_from_reader(
        OsStr::new(name),
        &mut Cursor::new(bytes),
        false,
        || Ok(None),
    )?;
    Ok(())
}
pub(super) fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}
pub(super) fn lease(directory: &PrivateDirectory, name: &str) -> Result<File> {
    directory
        .try_exclusive_lock(OsStr::new(name))?
        .context("source_transfer_busy")
}
pub(super) fn operation_lease(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<VerifiedPrivateLease> {
    operation_lease_with_wait(directory, name, std::thread::sleep)
}
pub(super) fn operation_lease_with_wait(
    directory: &PrivateDirectory,
    name: &str,
    mut wait: impl FnMut(Duration),
) -> Result<VerifiedPrivateLease> {
    // Pin the original authority across acquisition attempts. Waiting must not
    // turn a replaced anchor and lock into a newly accepted operation owner.
    let anchor: Anchor =
        load(directory, "binding.json")?.context("source_transfer_recovery_required")?;
    ensure!(
        anchor.directory == directory.directory_identity()?,
        "source_transfer_owner_changed"
    );
    let expected = match name {
        "writer.lock" => &anchor.writer,
        "control.lock" => &anchor.controller,
        _ => anyhow::bail!("source_transfer_invalid_lease"),
    };
    // Read-only status probes briefly take this same verified lease. Wait only
    // for acquisition, before any mutation; never replay an admitted operation.
    let deadline = Instant::now() + Duration::from_millis(250);
    loop {
        ensure!(
            load::<Anchor>(directory, "binding.json")?.as_ref() == Some(&anchor),
            "source_transfer_owner_changed"
        );
        if let Some(lease) = directory.try_existing_portable_lock(
            OsStr::new(name),
            expected,
            PrivateLeaseMode::Exclusive,
        )? {
            ensure!(
                load::<Anchor>(directory, "binding.json")?.as_ref() == Some(&anchor),
                "source_transfer_owner_changed"
            );
            return Ok(lease);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        ensure!(!remaining.is_zero(), "source_transfer_busy");
        wait(remaining.min(Duration::from_millis(2)));
    }
}
pub(super) fn try_operation_lease(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<Option<VerifiedPrivateLease>> {
    let anchor: Anchor =
        load(directory, "binding.json")?.context("source_transfer_recovery_required")?;
    ensure!(
        anchor.directory == directory.directory_identity()?,
        "source_transfer_owner_changed"
    );
    let expected = match name {
        "writer.lock" => &anchor.writer,
        "control.lock" => &anchor.controller,
        _ => anyhow::bail!("source_transfer_invalid_lease"),
    };
    directory.try_existing_portable_lock(OsStr::new(name), expected, PrivateLeaseMode::Exclusive)
}
pub(super) fn control(directory: &PrivateDirectory) -> Result<Control> {
    let value: Control =
        load(directory, "control.json")?.context("source_transfer_recovery_required")?;
    ensure!(
        value.acknowledged <= value.cancelled
            && value.commands.len() <= 256
            && value.cancelled == value.commands.len() as u64
            && value.sequence >= value.cancelled
            && value.completed_entries <= TRANSFER_MAX_ENTRIES as u32
            && value
                .commands
                .iter()
                .all(|command| valid_uuid(command).is_ok())
            && value
                .commands
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == value.commands.len(),
        "source_transfer_invalid_metadata"
    );
    Ok(value)
}
pub(super) fn active(directory: &PrivateDirectory) -> Result<()> {
    let value = control(directory)?;
    ensure!(
        value.cancelled == value.acknowledged,
        "source_transfer_cancelled"
    );
    Ok(())
}
pub(super) fn cancel(directory: &PrivateDirectory, command: &str) -> Result<TransferState> {
    valid_uuid(command)?;
    let _lease = operation_lease(directory, "control.lock")?;
    let mut value = control(directory)?;
    if !value.commands.iter().any(|existing| existing == command) {
        ensure!(value.commands.len() < 256, "source_transfer_command_limit");
        value.cancelled = value
            .cancelled
            .checked_add(1)
            .context("source_transfer_revision_exhausted")?;
        value.sequence = value
            .sequence
            .checked_add(1)
            .context("source_transfer_revision_exhausted")?;
        value.commands.push(command.into());
        save(directory, "control.json", &value)?;
    }
    Ok(value.state(load::<TransferReceipt>(directory, "receipt.json")?.is_some()))
}
pub(super) fn resume(
    directory: &PrivateDirectory,
    sequence: u64,
    watermark: u64,
) -> Result<TransferState> {
    let _writer = operation_lease(directory, "writer.lock")?;
    let _lease = operation_lease(directory, "control.lock")?;
    let mut value = control(directory)?;
    ensure!(
        value.sequence == sequence && value.cancelled == watermark,
        "source_transfer_revision_conflict"
    );
    value.acknowledged = watermark;
    value.sequence = value
        .sequence
        .checked_add(1)
        .context("source_transfer_revision_exhausted")?;
    save(directory, "control.json", &value)?;
    Ok(value.state(load::<TransferReceipt>(directory, "receipt.json")?.is_some()))
}
pub(super) fn fingerprint(
    file: &mut File,
    expected_bytes: u64,
    expected_hash: &str,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<()> {
    use std::io::{Seek, SeekFrom};
    ensure!(
        file.metadata()?.len() == expected_bytes,
        "source_transfer_payload_changed"
    );
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        ensure!(check(bytes), "source_transfer_cancelled");
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        ensure!(bytes <= expected_bytes, "source_transfer_payload_changed");
        hash.update(&buffer[..count]);
    }
    ensure!(
        bytes == expected_bytes
            && format!("{:x}", hash.finalize()) == expected_hash
            && file.metadata()?.len() == expected_bytes,
        "source_transfer_payload_changed"
    );
    Ok(())
}

fn current_account() -> Result<String> {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and observes this process only.
        Ok(format!("unix:{}", unsafe { libc::geteuid() }))
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            Security::{GetLengthSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser},
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        };
        struct Token(HANDLE);
        impl Drop for Token {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
        let mut raw = std::ptr::null_mut();
        // SAFETY: outputs point to initialized local storage and the process handle is current.
        ensure!(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } != 0,
            "source_transfer_os_identity_unavailable"
        );
        let token = Token(raw);
        let mut needed = 0;
        unsafe {
            GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed);
        }
        ensure!(
            needed > 0 && needed <= 65536,
            "source_transfer_os_identity_unavailable"
        );
        // Pointer-sized storage preserves TOKEN_USER alignment.
        let mut storage = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        ensure!(
            unsafe {
                GetTokenInformation(
                    token.0,
                    TokenUser,
                    storage.as_mut_ptr().cast(),
                    needed,
                    &mut needed,
                )
            } != 0,
            "source_transfer_os_identity_unavailable"
        );
        let sid = unsafe { (*(storage.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        let length = unsafe { GetLengthSid(sid) } as usize;
        ensure!(
            length > 0 && length <= 4096,
            "source_transfer_os_identity_unavailable"
        );
        let bytes = unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), length) };
        Ok(format!("windows:{:x}", Sha256::digest(bytes)))
    }
    #[cfg(not(any(unix, windows)))]
    anyhow::bail!("source_transfer_os_identity_unsupported")
}

mod private_preparations;
