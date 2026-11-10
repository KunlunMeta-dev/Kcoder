use super::*;
use std::{
    io::{Read, Seek, SeekFrom},
    path::Component,
    time::{SystemTime, UNIX_EPOCH},
};
const LIFETIME_MS: u64 = 15 * 60 * 1000;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stamp {
    identity: String,
    bytes: u64,
    modified: u128,
    change: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    root: PathBuf,
    relative: PathBuf,
    chain: Vec<String>,
    stamp: Stamp,
    pub sha256: String,
    issued_ms: u64,
    expires_ms: u64,
    nonce: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StagedSelection {
    version: u8,
    directory_identity: String,
    binding: Binding,
}
/// Owned by a native file-selection callback, never constructed from a historical path.
pub struct SelectedLocalFile {
    pub(super) binding: Binding,
    file: File,
}
fn now() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}
fn parts(path: &Path) -> Result<Vec<&OsStr>> {
    ensure!(
        path.to_str()
            .is_some_and(|v| !v.is_empty() && v.len() <= 2048 && !v.chars().any(char::is_control)),
        "local_attachment_unsafe_selection"
    );
    let parts = path
        .components()
        .map(|part| match part {
            Component::Normal(value) => Ok(value),
            _ => Err(anyhow::anyhow!("local_attachment_unsafe_selection")),
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        !parts.is_empty() && parts.len() <= 17,
        "local_attachment_unsafe_selection"
    );
    for part in &parts {
        let name = part
            .to_str()
            .context("local_attachment_unsafe_selection")?
            .to_ascii_lowercase();
        ensure!(
            !matches!(
                name.as_str(),
                "auth.json" | "credentials.json" | "credentials.toml" | ".git"
            ) && !name.starts_with(".env"),
            "local_attachment_sensitive_source_not_supported"
        );
    }
    Ok(parts)
}
fn stamp(file: &File) -> Result<Stamp> {
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= HISTORICAL_ATTACHMENT_MAX_BYTES,
        "local_attachment_source_budget_exceeded"
    );
    let modified = metadata.modified()?.duration_since(UNIX_EPOCH)?.as_nanos();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid only observes the current native account.
        ensure!(
            metadata.nlink() == 1 && metadata.uid() == unsafe { libc::geteuid() },
            "local_attachment_unsafe_selection"
        );
        Ok(Stamp {
            identity: format!("unix:{}:{}", metadata.dev(), metadata.ino()),
            bytes: metadata.len(),
            modified,
            change: format!(
                "{}:{}:{}:{}:{}",
                metadata.ctime(),
                metadata.ctime_nsec(),
                metadata.mode(),
                metadata.uid(),
                metadata.gid()
            ),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: file owns a live handle and info is writable native output storage.
        ensure!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } != 0
                && info.nNumberOfLinks == 1,
            "local_attachment_unsafe_selection"
        );
        Ok(Stamp {
            identity: format!(
                "windows:{}:{}:{}",
                info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
            ),
            bytes: metadata.len(),
            modified,
            change: format!(
                "{}:{}",
                metadata.creation_time(),
                metadata.file_attributes()
            ),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (file, modified);
        anyhow::bail!("local_attachment_platform_unsupported")
    }
}
pub(super) fn file_identity(file: &File) -> Result<String> {
    Ok(stamp(file)?.identity)
}
fn open(root: &Path, relative: &Path) -> Result<(File, Vec<String>)> {
    ensure!(root.is_absolute(), "local_attachment_unsafe_selection");
    ensure!(
        root.to_str()
            .is_some_and(|root| root.len() <= 4096 && !root.chars().any(char::is_control)),
        "local_attachment_unsafe_selection"
    );
    let parts = parts(relative)?;
    let mut directory = PrivateDirectory::open_existing(root)
        .map_err(|_| anyhow::anyhow!("local_attachment_source_unavailable"))?;
    directory
        .verify_trusted_config_directory()
        .map_err(|_| anyhow::anyhow!("local_attachment_unsafe_selection"))?;
    let mut chain = vec![directory.directory_identity()?];
    for part in &parts[..parts.len() - 1] {
        directory = directory
            .open_child(part, false)
            .map_err(|_| anyhow::anyhow!("local_attachment_unsafe_selection"))?;
        directory
            .verify_trusted_config_directory()
            .map_err(|_| anyhow::anyhow!("local_attachment_unsafe_selection"))?;
        chain.push(directory.directory_identity()?);
    }
    let file = directory
        .open_single_link_regular_file(parts[parts.len() - 1])
        .map_err(|_| anyhow::anyhow!("local_attachment_unsafe_selection"))?;
    Ok((file, chain))
}
impl SelectedLocalFile {
    /// The host must obtain explicit selection first. False consent returns before any source access.
    pub fn select(
        root: &Path,
        relative: &Path,
        explicit_selection: bool,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Self> {
        ensure!(
            explicit_selection,
            "local_attachment_explicit_selection_required"
        );
        ensure!(check(0), "local_attachment_cancelled");
        let (mut file, chain) = open(root, relative)?;
        let before = stamp(&file)?;
        let mut hash = Sha256::new();
        let mut bytes = 0;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            ensure!(check(bytes), "local_attachment_cancelled");
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            bytes += count as u64;
            ensure!(bytes <= before.bytes, "local_attachment_source_changed");
            hash.update(&buffer[..count]);
        }
        ensure!(
            bytes == before.bytes && stamp(&file)? == before,
            "local_attachment_source_changed"
        );
        let issued_ms = now()?;
        let binding = Binding {
            root: root.into(),
            relative: relative.into(),
            chain,
            stamp: before,
            sha256: format!("{:x}", hash.finalize()),
            issued_ms,
            expires_ms: issued_ms
                .checked_add(LIFETIME_MS)
                .context("local_attachment_selection_expired")?,
            nonce: uuid::Uuid::new_v4().to_string(),
        };
        let selected = Self { binding, file };
        selected.verify()?;
        Ok(selected)
    }
    /// Native-owned completed upload bytes have durable ownership, unlike an external picker grant.
    pub fn select_staged_upload(
        root: &Path,
        directory: &PrivateDirectory,
        bytes: u64,
        sha256: &str,
        check: impl FnMut(u64) -> bool,
    ) -> Result<Self> {
        directory.verify_private_directory()?;
        ensure!(
            PrivateDirectory::open_existing(root)?.directory_identity()?
                == directory.directory_identity()?,
            "local_attachment_source_changed"
        );
        let mut selected = Self::select(root, Path::new("payload.bin"), true, check)?;
        ensure!(
            selected.bytes() == bytes && selected.binding.sha256 == sha256,
            "local_attachment_content_changed"
        );
        selected.binding.issued_ms = 0;
        selected.binding.expires_ms = u64::MAX;
        Ok(selected)
    }
    /// Persist only an already verified owned upload capability, never a public path grant.
    pub fn persist_staged_upload(&self, directory: &PrivateDirectory) -> Result<()> {
        directory.verify_private_directory()?;
        ensure!(
            self.binding.issued_ms == 0
                && self.binding.expires_ms == u64::MAX
                && self.binding.relative == Path::new("payload.bin")
                && self.binding.chain.first() == Some(&directory.directory_identity()?),
            "local_attachment_invalid_staged_selection"
        );
        self.verify()?;
        let ticket = StagedSelection {
            version: 1,
            directory_identity: directory.directory_identity()?,
            binding: self.binding.clone(),
        };
        publish_exact(
            directory,
            "selection.json",
            &serde_json::to_vec(&ticket)?,
            32 * 1024,
        )
    }
    /// The private file preserves the original nonce across an interrupted authorize dispatch.
    pub fn reopen_staged_upload(
        root: &Path,
        directory: &PrivateDirectory,
        bytes: u64,
        sha256: &str,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Option<Self>> {
        directory.verify_private_directory()?;
        let identity = directory.directory_identity()?;
        ensure!(
            PrivateDirectory::open_existing(root)?.directory_identity()? == identity,
            "local_attachment_source_changed"
        );
        let Some(encoded) = read_optional(directory, "selection.json", 32 * 1024)? else {
            return Ok(None);
        };
        let ticket: StagedSelection = serde_json::from_slice(&encoded)
            .map_err(|_| anyhow::anyhow!("local_attachment_invalid_staged_selection"))?;
        let binding = ticket.binding;
        ensure!(
            ticket.version == 1
                && ticket.directory_identity == identity
                && binding.root == root
                && binding.relative == Path::new("payload.bin")
                && binding.chain.first() == Some(&identity)
                && binding.issued_ms == 0
                && binding.expires_ms == u64::MAX
                && binding.stamp.bytes == bytes
                && binding.sha256 == sha256
                && uuid::Uuid::parse_str(&binding.nonce)
                    .is_ok_and(|id| id.to_string() == binding.nonce),
            "local_attachment_invalid_staged_selection"
        );
        let selected = Self::reopen(&binding)?;
        let mut reader = selected.reader()?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            ensure!(check(reader.bytes), "local_attachment_cancelled");
            if reader.read(&mut buffer)? == 0 {
                break;
            }
        }
        Ok(Some(reader.selected))
    }
    pub fn bytes(&self) -> u64 {
        self.binding.stamp.bytes
    }
    /// Digest captured under the explicit native selection; no path or private binding is exposed.
    pub fn sha256(&self) -> &str {
        &self.binding.sha256
    }
    /// Consumers must read through EOF: the final read revalidates ownership, identity and SHA256.
    /// Each underlying read remains bounded to 64 KiB, regardless of the caller's buffer size.
    pub fn into_verified_reader(self) -> Result<impl Read> {
        self.reader()
    }
    pub fn revision(&self) -> Result<String> {
        hash_value(&self.binding)
    }
    pub(super) fn verify(&self) -> Result<()> {
        ensure!(
            (self.binding.issued_ms..=self.binding.expires_ms).contains(&now()?),
            "local_attachment_selection_expired"
        );
        let (file, chain) = open(&self.binding.root, &self.binding.relative)?;
        ensure!(
            chain == self.binding.chain
                && stamp(&file)? == self.binding.stamp
                && stamp(&self.file)? == self.binding.stamp,
            "local_attachment_source_changed"
        );
        Ok(())
    }
    pub(super) fn reopen(binding: &Binding) -> Result<Self> {
        let time = now()?;
        ensure!(
            (binding.issued_ms..=binding.expires_ms).contains(&time),
            "local_attachment_selection_expired"
        );
        let (file, chain) = open(&binding.root, &binding.relative)?;
        ensure!(
            chain == binding.chain && stamp(&file)? == binding.stamp,
            "local_attachment_source_changed"
        );
        Ok(Self {
            binding: binding.clone(),
            file,
        })
    }
    pub(super) fn reader(mut self) -> Result<VerifiedReader> {
        self.verify()?;
        self.file.seek(SeekFrom::Start(0))?;
        Ok(VerifiedReader {
            selected: self,
            bytes: 0,
            hash: Sha256::new(),
            complete: false,
        })
    }
}
impl Binding {
    pub(super) fn bytes(&self) -> u64 {
        self.stamp.bytes
    }
}
pub(super) struct VerifiedReader {
    selected: SelectedLocalFile,
    bytes: u64,
    hash: Sha256,
    complete: bool,
}
impl Read for VerifiedReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() || self.complete {
            return Ok(0);
        }
        let expected = self.selected.binding.stamp.bytes;
        if self.bytes == expected {
            let mut extra = [0u8; 1];
            if self.selected.file.read(&mut extra)? != 0 {
                return Err(std::io::Error::other("local_attachment_source_changed"));
            }
            self.selected
                .verify()
                .map_err(|_| std::io::Error::other("local_attachment_source_changed"))?;
            if format!("{:x}", self.hash.clone().finalize()) != self.selected.binding.sha256 {
                return Err(std::io::Error::other("local_attachment_source_changed"));
            }
            self.complete = true;
            return Ok(0);
        }
        let take = output
            .len()
            .min(64 * 1024)
            .min((expected - self.bytes) as usize);
        let count = self.selected.file.read(&mut output[..take])?;
        if count == 0 {
            return Err(std::io::Error::other("local_attachment_source_changed"));
        }
        self.bytes += count as u64;
        self.hash.update(&output[..count]);
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_selected_reader_is_bounded_and_only_eof_confirms_unchanged_content() {
        let root = tempfile::tempdir().unwrap();
        let bytes = vec![3u8; 200000];
        std::fs::write(root.path().join("selected.bin"), &bytes).unwrap();
        let selected =
            SelectedLocalFile::select(root.path(), Path::new("selected.bin"), true, |_| true)
                .unwrap();
        assert_eq!(selected.bytes(), bytes.len() as u64);
        assert_eq!(selected.sha256(), format!("{:x}", Sha256::digest(&bytes)));
        let mut reader = selected.into_verified_reader().unwrap();
        let mut output = vec![0; 192 * 1024];
        assert_eq!(reader.read(&mut output).unwrap(), 64 * 1024);
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, bytes[64 * 1024..]);
        let selected =
            SelectedLocalFile::select(root.path(), Path::new("selected.bin"), true, |_| true)
                .unwrap();
        let mut reader = selected.into_verified_reader().unwrap();
        let mut declared = vec![0; bytes.len()];
        reader.read_exact(&mut declared).unwrap();
        std::fs::write(root.path().join("selected.bin"), &bytes).unwrap();
        assert!(
            reader.read(&mut [0u8; 1]).is_err(),
            "reading exactly the declared bytes is not EOF verification"
        );
    }
    #[test]
    fn durable_upload_selection_requires_its_fixed_private_handle_and_digest() {
        let root = tempfile::tempdir().unwrap();
        let peer = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("payload.bin"), b"owned bytes").unwrap();
        let directory = PrivateDirectory::open_or_create(root.path()).unwrap();
        let peer_directory = PrivateDirectory::open_or_create(peer.path()).unwrap();
        let sha = format!("{:x}", Sha256::digest(b"owned bytes"));
        assert!(
            SelectedLocalFile::select_staged_upload(
                root.path(),
                &peer_directory,
                11,
                &sha,
                |_| panic!("wrong directory must fail before content access")
            )
            .is_err()
        );
        assert!(
            SelectedLocalFile::select_staged_upload(
                root.path(),
                &directory,
                11,
                &"0".repeat(64),
                |_| true
            )
            .is_err()
        );
        let selected =
            SelectedLocalFile::select_staged_upload(root.path(), &directory, 11, &sha, |_| true)
                .unwrap();
        assert_eq!(selected.binding.issued_ms, 0);
        assert_eq!(selected.binding.expires_ms, u64::MAX);
        assert!(SelectedLocalFile::reopen(&selected.binding).is_ok());
        selected.persist_staged_upload(&directory).unwrap();
        let restored =
            SelectedLocalFile::reopen_staged_upload(root.path(), &directory, 11, &sha, |_| true)
                .unwrap()
                .unwrap();
        assert_eq!(selected.revision().unwrap(), restored.revision().unwrap());
        assert!(
            SelectedLocalFile::reopen_staged_upload(
                root.path(),
                &directory,
                11,
                &"0".repeat(64),
                |_| true
            )
            .is_err()
        );
    }
    #[test]
    fn an_expired_selection_is_rejected_before_reopening_a_disappeared_source() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("file.bin"), b"selected").unwrap();
        let mut selected =
            SelectedLocalFile::select(root.path(), Path::new("file.bin"), true, |_| true).unwrap();
        selected.binding.expires_ms = selected.binding.issued_ms.saturating_sub(1);
        std::fs::remove_file(root.path().join("file.bin")).unwrap();
        assert_eq!(
            selected.verify().unwrap_err().to_string(),
            "local_attachment_selection_expired"
        );
        assert!(
            SelectedLocalFile::reopen(&selected.binding)
                .err()
                .unwrap()
                .to_string()
                .contains("selection_expired")
        );
    }
}
