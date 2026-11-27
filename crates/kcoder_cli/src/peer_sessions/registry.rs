//! Bounded locators only. Every displayed fact and delivery is rechecked at the actual Native holder.
use super::*;
use std::{ffi::OsString, io::Read};
#[cfg(all(test, windows))]
#[path = "registry/windows_tests.rs"]
mod windows_tests;

#[cfg(windows)]
fn claim_windows_locator(file: &std::fs::File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Storage::FileSystem::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx},
        System::IO::OVERLAPPED,
    };
    let mut overlap = OVERLAPPED::default();
    // Windows byte-range locks are mandatory for ordinary reads. Keep this
    // liveness byte outside every bounded locator read (at most 2049 bytes).
    // Legacy readers probe the whole file, so they still observe this claim.
    overlap.Anonymous.Anonymous.Offset = 64 * 1024;
    // SAFETY: this borrowed File and stack OVERLAPPED remain valid for the
    // nonblocking call. The retained File owns the acquired range until close.
    let locked = unsafe {
        LockFileEx(
            file.as_raw_handle().cast(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlap,
        )
    };
    if locked == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn publish_windows_claim(
    directory: &kcoder_config::PrivateDirectory,
    name: &std::ffi::OsStr,
    bytes: &[u8],
    verify: &dyn Fn() -> Result<()>,
) -> Result<std::fs::File> {
    let mut claimed = None;
    directory.atomic_publish_observed_from_reader(
        name,
        &mut std::io::Cursor::new(bytes),
        false,
        || {
            verify()?;
            Ok(())
        },
        |original| {
            // Lock the handle retained by Registration before the final name
            // is visible. Closing the publisher's temporary handle must not
            // create an unlocked locator that a reader can mistake for stale.
            let entry = original.try_clone()?;
            claim_windows_locator(&entry)?;
            verify()?;
            claimed = Some(entry);
            Ok(())
        },
    )?;
    claimed.context("peer_source_locator_claim_unavailable")
}

#[cfg(windows)]
fn legacy_windows_hint(
    service: &PeerMessageService,
    name: &std::ffi::OsStr,
) -> Result<Option<SessionAddressV1>> {
    let Some((thread_id, nonce)) = name
        .to_str()
        .and_then(|name| name.strip_suffix(".json"))
        .and_then(|name| name.rsplit_once('.'))
    else {
        return Ok(None);
    };
    if !kcoder_types::cross_session_messages::valid_agent_message_id(thread_id) {
        return Ok(None);
    }
    let Ok(nonce_id) = uuid::Uuid::parse_str(nonce) else {
        return Ok(None);
    };
    if nonce_id.get_version_num() != 4
        || nonce_id.get_variant() != uuid::Variant::RFC4122
        || nonce_id.to_string() != nonce
    {
        return Ok(None);
    }
    // Older publishers lock the entire body. This name is only an untrusted
    // locator hint, derived within the current scope. Both consumers page the
    // hints and obtain every resident fact from the authenticated live endpoint.
    Ok(Some(service.address(thread_id)?))
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Locator {
    version: u32,
    address: SessionAddressV1,
}
pub(super) struct Registration {
    directory: kcoder_config::PrivateDirectory,
    name: OsString,
    #[cfg(not(windows))]
    entry: kcoder_config::VerifiedPrivateEntry,
    #[cfg(windows)]
    entry: std::fs::File,
}
impl Registration {
    pub(super) fn publish(source: &BoundPeerSource) -> Result<Self> {
        let directory = source
            .service()
            .live_registry(true)?
            .context("peer_source_registry_unavailable")?;
        let name = OsString::from(format!(
            "{}.{}.json",
            source.state().session_id(),
            uuid::Uuid::new_v4()
        ));
        let bytes = serde_json::to_vec(&Locator {
            version: 1,
            address: source.address()?,
        })?;
        #[cfg(not(windows))]
        let entry = {
            let mut anonymous = directory.create_anonymous_private_entry()?;
            anonymous.seal(&bytes)?;
            // The claim precedes name visibility. A concurrent directory
            // reader cannot mistake this publisher for an abandoned locator.
            fs2::FileExt::try_lock_exclusive(anonymous.file())?;
            let entry = directory.publish_anonymous_private_entry(&anonymous, &name)?;
            directory.sync()?;
            ensure!(
                entry.try_exclusive_lease()?,
                "peer_source_locator_claim_unavailable"
            );
            entry
        };
        #[cfg(windows)]
        let entry = publish_windows_claim(&directory, &name, &bytes, &|| source.check_owner())?;
        Ok(Self {
            directory,
            name,
            entry,
        })
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        // This never-reused locator was created by this endpoint. Retain the
        // original file/entry claim and remove only its verified native object.
        #[cfg(not(windows))]
        let _ = self
            .directory
            .remove_verified_regular_leaf(&self.name, self.entry.identity());
        #[cfg(windows)]
        let _ = self
            .directory
            .remove_regular_file_if_handle(&self.name, &self.entry);
    }
}
pub(crate) fn live_candidates(service: &PeerMessageService) -> Result<Vec<SessionAddressV1>> {
    service.require_enabled(false)?;
    let Some(directory) = service.live_registry(false)? else {
        return Ok(Vec::new());
    };
    let identity = service.identity()?;
    let mut candidates = std::collections::BTreeSet::new();
    directory.visit_entry_names_bounded(4096, |name| {
        if !name.to_str().is_some_and(|name| name.ends_with(".json")) {
            return Ok(());
        }
        let mut file = directory.open_single_link_regular_file(name)?;
        match fs2::FileExt::try_lock_shared(&file) {
            Ok(()) => {
                // An abandoned locator is a stale hint, not a resident. Keep
                // its bytes intact and let ordinary cold history remain visible.
                fs2::FileExt::unlock(&file)?;
                return Ok(());
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {}
            Err(error) => return Err(error.into()),
        }
        ensure!(file.metadata()?.len() <= 2048, "peer_source_locator_limit");
        let mut bytes = Vec::new();
        let read = (&mut file).take(2049).read_to_end(&mut bytes);
        #[cfg(windows)]
        if let Err(error) = &read
            && error.raw_os_error()
                == Some(windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION as i32)
        {
            // Only an already verified, genuinely locked old file reaches
            // this fallback. Its inaccessible JSON never supplies any facts.
            if let Some(hint) = legacy_windows_hint(service, name)? {
                candidates.insert(hint);
            }
            return Ok(());
        }
        read?;
        ensure!(bytes.len() <= 2048, "peer_source_locator_limit");
        let locator: Locator = serde_json::from_slice(&bytes)?;
        ensure!(locator.version == 1, "peer_source_locator_version");
        locator.address.validate().map_err(anyhow::Error::msg)?;
        if identity.contains(&locator.address) {
            candidates.insert(locator.address);
        }
        Ok(())
    })?;
    service.require_enabled(false)?;
    Ok(candidates.into_iter().collect())
}
