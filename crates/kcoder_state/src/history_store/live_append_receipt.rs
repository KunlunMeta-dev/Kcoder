//! Process-local evidence for the exact file handle used by one source append.
//! This is not serialized, an execution grant, or a cross-restart identity.
use super::*;
use anyhow::ensure;
use kcoder_config::PortableLeaseIdentity;
use sha2::{Digest, Sha256};
use std::time::SystemTime;

pub(super) struct BodyStamp {
    len: u64,
    modified: SystemTime,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    changed: i64,
    #[cfg(not(any(unix, windows)))]
    changed: (),
}
impl PartialEq for BodyStamp {
    fn eq(&self, other: &Self) -> bool {
        self.len == other.len && self.modified == other.modified && self.changed == other.changed
    }
}
impl Eq for BodyStamp {}

pub(super) fn stamp(file: &File) -> Result<BodyStamp> {
    let metadata = file.metadata()?;
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        (metadata.ctime(), metadata.ctime_nsec())
    };
    #[cfg(windows)]
    let changed = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandleEx,
        };
        let mut info: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: file owns a live handle and info is the correctly sized output buffer.
        ensure!(
            unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle().cast(),
                    FileBasicInfo,
                    (&mut info as *mut FILE_BASIC_INFO).cast(),
                    std::mem::size_of::<FILE_BASIC_INFO>() as u32,
                )
            } != 0,
            "history append change stamp unavailable"
        );
        info.ChangeTime
    };
    #[cfg(not(any(unix, windows)))]
    let changed = ();
    Ok(BodyStamp {
        len: metadata.len(),
        modified: metadata.modified()?,
        changed,
    })
}

pub(super) struct PreparedLiveAppend {
    parent: PrivateDirectory,
    parent_path: PathBuf,
    parent_identity: String,
    name: OsString,
    before: File,
    file_identity: PortableLeaseIdentity,
}

impl PreparedLiveAppend {
    /// Call under the source mutation lock before publishing the pending
    /// append. A missing source is never recreated by this receipt path.
    /// A live handle still does not prove fresh-session birth.
    pub(super) fn open(
        directory: &PrivateDirectory,
        name: &OsStr,
        source_path: &Path,
    ) -> Result<Self> {
        let parent_path =
            dunce::canonicalize(source_path.parent().context("history parent missing")?)?;
        let parent_identity = directory.directory_identity()?;
        let current_parent = PrivateDirectory::open_existing(&parent_path)?;
        ensure!(
            current_parent.directory_identity()? == parent_identity,
            "history parent changed"
        );
        let before = directory.open_single_link_regular_file(name)?;
        let file_identity = PortableLeaseIdentity::from_regular_handle(&before)?;
        Ok(Self {
            parent: directory.duplicate_handle()?,
            parent_path,
            parent_identity,
            name: name.to_os_string(),
            before,
            file_identity,
        })
    }

    pub(super) fn len(&self) -> Result<u64> {
        Ok(self.before.metadata()?.len())
    }

    #[cfg(target_os = "linux")]
    pub(super) fn lineage_matches_prefix(&self, prefix: &File) -> Result<()> {
        ensure!(
            PortableLeaseIdentity::from_regular_handle(prefix)? == self.file_identity,
            "native lineage prefix object changed"
        );
        self.verify_identity(prefix)
    }

    fn verify_identity(&self, writer: &File) -> Result<()> {
        let current_parent = PrivateDirectory::open_existing(&self.parent_path)?;
        ensure!(
            self.parent.directory_identity()? == self.parent_identity
                && current_parent.directory_identity()? == self.parent_identity,
            "history parent changed"
        );
        let current = self.parent.open_single_link_regular_file(&self.name)?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(&self.before)? == self.file_identity
                && PortableLeaseIdentity::from_regular_handle(writer)? == self.file_identity
                && PortableLeaseIdentity::from_regular_handle(&current)? == self.file_identity,
            "history append object changed"
        );
        Ok(())
    }

    /// The mutation lock is still held. Verify the actual writer handle and
    /// exact appended bytes before the source ready record can be committed.
    pub(super) fn finish(
        mut self,
        writer: File,
        start: u64,
        end: u64,
        sha256: &str,
    ) -> Result<LiveAppendReceipt> {
        self.verify_identity(&writer)?;
        let observed = verify_range(&mut self.before, start, end, sha256)?;
        self.verify_identity(&writer)?;
        Ok(LiveAppendReceipt {
            prepared: self,
            writer,
            stamp: observed,
            start,
            end,
            sha256: sha256.into(),
            committed: None,
        })
    }
}

fn verify_range(file: &mut File, start: u64, end: u64, sha256: &str) -> Result<BodyStamp> {
    let observed = stamp(file)?;
    ensure!(
        end > start && observed.len == end,
        "history append length changed"
    );
    file.seek(SeekFrom::Start(start))?;
    let mut hash = Sha256::new();
    let mut remaining = end - start;
    let mut block = [0_u8; 64 * 1024];
    while remaining > 0 {
        let limit = usize::try_from(remaining.min(block.len() as u64))?;
        let read = file.read(&mut block[..limit])?;
        ensure!(read > 0, "history append range is incomplete");
        hash.update(&block[..read]);
        remaining -= u64::try_from(read)?;
    }
    ensure!(
        format!("{:x}", hash.finalize()) == sha256 && stamp(file)? == observed,
        "history append bytes changed"
    );
    Ok(observed)
}

/// Held writer/source handles preserve only a live observation. The caller
/// must separately bind source control, native session/attempt, and authority.
pub(crate) struct LiveAppendReceipt {
    prepared: PreparedLiveAppend,
    writer: File,
    stamp: BodyStamp,
    pub(super) start: u64,
    pub(super) end: u64,
    pub(super) sha256: String,
    pub(super) committed: Option<LiveSourceCommit>,
}

pub(super) struct LiveSourceCommit {
    pub(super) incarnation: uuid::Uuid,
    pub(super) generation: uuid::Uuid,
    pub(super) revision: u64,
    pub(super) control_sha256: String,
    control_directory: PrivateDirectory,
    control_directory_identity: String,
    control_directory_name: OsString,
    control_anchor: File,
    control_identity: PortableLeaseIdentity,
    control_stamp: BodyStamp,
    #[cfg(target_os = "linux")]
    pub(super) publisher_observed: bool,
}

impl LiveAppendReceipt {
    pub(crate) fn range(&self) -> (u64, u64) {
        (self.start, self.end)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn lineage_same_body(&self, other: &Self) -> Result<()> {
        ensure!(
            self.prepared.parent_identity == other.prepared.parent_identity
                && self.prepared.name == other.prepared.name
                && self.prepared.file_identity == other.prepared.file_identity,
            "native lineage history body changed"
        );
        self.prepared.verify_identity(&self.writer)?;
        other.prepared.verify_identity(&other.writer)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn lineage_matches_prepared(&self, next: &PreparedLiveAppend) -> Result<()> {
        ensure!(
            self.prepared.parent_identity == next.parent_identity
                && self.prepared.name == next.name,
            "native lineage history parent changed"
        );
        next.lineage_matches_prefix(&self.prepared.before)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn lineage_hash_range(
        &mut self,
        start: u64,
        end: u64,
        max_bytes: u64,
    ) -> Result<[u8; 32]> {
        ensure!(
            end >= start && end - start <= max_bytes,
            "lineage range exceeds budget"
        );
        self.verify_contents()?;
        ensure!(end <= self.stamp.len, "lineage range exceeds history");
        self.prepared.before.seek(SeekFrom::Start(start))?;
        let mut remaining = end - start;
        let mut digest = Sha256::new();
        let mut block = [0_u8; 64 * 1024];
        while remaining > 0 {
            let length = usize::try_from(remaining.min(block.len() as u64))?;
            let read = self.prepared.before.read(&mut block[..length])?;
            ensure!(read > 0, "lineage range is incomplete");
            digest.update(&block[..read]);
            remaining -= u64::try_from(read)?;
        }
        self.verify_contents()?;
        Ok(digest.finalize().into())
    }

    #[cfg(target_os = "linux")]
    pub(super) fn lineage_read_range(
        &mut self,
        start: u64,
        end: u64,
        max_bytes: u64,
    ) -> Result<Vec<u8>> {
        ensure!(
            end > start && end - start <= max_bytes,
            "lineage row exceeds budget"
        );
        self.verify_contents()?;
        ensure!(end <= self.stamp.len, "lineage row exceeds history");
        self.prepared.before.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        (&mut self.prepared.before)
            .take(end - start)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == end - start,
            "lineage row is incomplete"
        );
        self.verify_contents()?;
        Ok(bytes)
    }
    pub(super) fn bind_committed(
        &mut self,
        incarnation: uuid::Uuid,
        generation: uuid::Uuid,
        revision: u64,
        record: &SourceRecord,
        published: Option<File>,
    ) -> Result<()> {
        let expected = serde_json::to_vec(record)?;
        ensure!(
            expected.len() <= 4096,
            "history source control is oversized"
        );
        let control_directory_name = source_directory_name(&self.prepared.name)?;
        let control_directory = self
            .prepared
            .parent
            .open_child(&control_directory_name, false)?;
        control_directory.verify_private_directory()?;
        let control_directory_identity = control_directory.directory_identity()?;
        #[cfg(target_os = "linux")]
        let publisher_observed = published.is_some();
        let mut control_anchor = match published {
            Some(file) => file,
            None => {
                control_directory.open_single_link_regular_file(OsStr::new(SOURCE_RECORD_FILE))?
            }
        };
        let control_identity = PortableLeaseIdentity::from_regular_handle(&control_anchor)?;
        let control_stamp = stamp(&control_anchor)?;
        let mut actual = Vec::new();
        control_anchor.seek(SeekFrom::Start(0))?;
        (&mut control_anchor).take(4097).read_to_end(&mut actual)?;
        ensure!(
            actual == expected && stamp(&control_anchor)? == control_stamp,
            "history source control bytes changed"
        );
        let named =
            control_directory.open_single_link_regular_file(OsStr::new(SOURCE_RECORD_FILE))?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(&named)? == control_identity,
            "history source control object changed"
        );
        let control_sha256 = format!("{:x}", Sha256::digest(&actual));
        ensure!(
            self.committed.is_none() && revision > 0 && control_sha256.len() == 64,
            "invalid history append commit evidence"
        );
        self.committed = Some(LiveSourceCommit {
            incarnation,
            generation,
            revision,
            control_sha256,
            control_directory,
            control_directory_identity,
            control_directory_name,
            control_anchor,
            control_identity,
            control_stamp,
            #[cfg(target_os = "linux")]
            publisher_observed,
        });
        Ok(())
    }

    /// Duplicate an already observed live commit while its named source is
    /// still protected by the source lock. Reopened read cursors are checked
    /// against the original publisher and writer handles before either drops.
    #[cfg(target_os = "linux")]
    pub(super) fn duplicate_for_lineage(&mut self) -> Result<Self> {
        self.verify_contents()?;
        let commit = self.committed.as_ref().context("history commit missing")?;
        ensure!(
            commit.publisher_observed,
            "history publisher was not observed"
        );
        let prepared = PreparedLiveAppend::open(
            &self.prepared.parent,
            &self.prepared.name,
            &self.prepared.parent_path.join(&self.prepared.name),
        )?;
        self.lineage_matches_prepared(&prepared)?;
        let control = commit
            .control_directory
            .open_single_link_regular_file(OsStr::new(SOURCE_RECORD_FILE))?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(&control)? == commit.control_identity,
            "history publisher changed before duplication"
        );
        let copy = LiveAppendReceipt {
            writer: self.writer.try_clone()?,
            stamp: stamp(&prepared.before)?,
            prepared,
            start: self.start,
            end: self.end,
            sha256: self.sha256.clone(),
            committed: Some(LiveSourceCommit {
                incarnation: commit.incarnation,
                generation: commit.generation,
                revision: commit.revision,
                control_sha256: commit.control_sha256.clone(),
                control_directory: commit.control_directory.duplicate_handle()?,
                control_directory_identity: commit.control_directory_identity.clone(),
                control_directory_name: commit.control_directory_name.clone(),
                control_identity: commit.control_identity.clone(),
                control_stamp: stamp(&control)?,
                control_anchor: control,
                publisher_observed: true,
            }),
        };
        let mut copy = copy;
        copy.verify_contents()?;
        self.verify_contents()?;
        Ok(copy)
    }

    /// Old control names may have been replaced by legitimate later commits.
    /// Compare two still-live original handles; do not infer identity from a
    /// recycled inode or require the old name to remain linked.
    #[cfg(target_os = "linux")]
    pub(crate) fn same_original_lineage_commit(&self, other: &Self) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        self.lineage_same_body(other)?;
        let left = self.committed.as_ref().context("original commit missing")?;
        let right = other
            .committed
            .as_ref()
            .context("supplied commit missing")?;
        let a = left.control_anchor.metadata()?;
        let b = right.control_anchor.metadata()?;
        ensure!(
            left.publisher_observed
                && right.publisher_observed
                && left.incarnation == right.incarnation
                && left.generation == right.generation
                && left.revision == right.revision
                && left.control_sha256 == right.control_sha256
                && left.control_identity == right.control_identity
                && a.dev() == b.dev()
                && a.ino() == b.ino()
                && self.start == other.start
                && self.end == other.end
                && self.sha256 == other.sha256,
            "original live commit differs"
        );
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn matches_lineage_row(&self, start: u64, end: u64, digest: &str) -> bool {
        self.start == start && self.end == end && self.sha256 == digest
    }
    /// Re-read the exact original bytes outside State/activity gates. A caller
    /// still needs a live source lease and a final metadata/identity check.
    pub(super) fn verify_contents(&mut self) -> Result<()> {
        self.prepared.verify_identity(&self.writer)?;
        ensure!(
            stamp(&self.prepared.before)? == self.stamp,
            "history append changed after verification"
        );
        let observed = verify_range(
            &mut self.prepared.before,
            self.start,
            self.end,
            &self.sha256,
        )?;
        ensure!(
            observed == self.stamp,
            "history append changed during verification"
        );
        self.prepared.verify_identity(&self.writer)?;
        if let Some(committed) = &mut self.committed {
            let current = self
                .prepared
                .parent
                .open_child(&committed.control_directory_name, false)?;
            current.verify_private_directory()?;
            ensure!(
                current.directory_identity()? == committed.control_directory_identity
                    && committed.control_directory.directory_identity()?
                        == committed.control_directory_identity,
                "history source control directory changed"
            );
            let named = current.open_single_link_regular_file(OsStr::new(SOURCE_RECORD_FILE))?;
            ensure!(
                PortableLeaseIdentity::from_regular_handle(&named)? == committed.control_identity
                    && PortableLeaseIdentity::from_regular_handle(&committed.control_anchor)?
                        == committed.control_identity,
                "history source control object changed"
            );
            ensure!(
                stamp(&committed.control_anchor)? == committed.control_stamp,
                "history source control changed after commit"
            );
            committed.control_anchor.seek(SeekFrom::Start(0))?;
            let mut bytes = Vec::new();
            (&mut committed.control_anchor)
                .take(4097)
                .read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() <= 4096
                    && format!("{:x}", Sha256::digest(&bytes)) == committed.control_sha256
                    && stamp(&committed.control_anchor)? == committed.control_stamp,
                "history source control bytes changed"
            );
            let record: SourceRecord =
                serde_json::from_slice(&bytes).context("history source control is invalid")?;
            let state = record
                .commit
                .as_ref()
                .context("history source control is not committed")?;
            state.check_ready()?;
            ensure!(
                !record.deleted
                    && record.incarnation == committed.incarnation
                    && state.generation == committed.generation
                    && state.revision == committed.revision,
                "history source commit facts changed"
            );
            let named_after =
                current.open_single_link_regular_file(OsStr::new(SOURCE_RECORD_FILE))?;
            ensure!(
                PortableLeaseIdentity::from_regular_handle(&named_after)?
                    == committed.control_identity,
                "history source control object changed"
            );
        }
        Ok(())
    }

    /// Read one bounded row from the still-held source after checking the
    /// original batch and ready control. Never use this while holding State or
    /// an activity gate; it is not a fresh-session or execution witness.
    pub(crate) fn read_verified_row(
        &mut self,
        start: u64,
        end: u64,
        row_sha256: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>> {
        ensure!(self.committed.is_some(), "history append is not confirmed");
        ensure!(
            start >= self.start && end <= self.end && end > start && end - start <= max_bytes,
            "history row range is invalid"
        );
        self.verify_contents()?;
        self.prepared.before.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        (&mut self.prepared.before)
            .take(end - start)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == end - start
                && format!("{:x}", Sha256::digest(&bytes)) == row_sha256,
            "history row bytes changed"
        );
        self.verify_contents()?;
        Ok(bytes)
    }
}
