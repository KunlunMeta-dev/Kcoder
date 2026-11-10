//! Immutable streams keep kernel-owned cleanup until all bytes have been renamed.
use super::*;
use std::{mem::size_of, os::windows::io::AsRawHandle};
use windows_sys::{
    Wdk::Storage::FileSystem::{
        FILE_CREATE, FILE_DELETE_ON_CLOSE, FILE_NON_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT,
        FILE_SYNCHRONOUS_IO_NONALERT,
    },
    Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE},
        Storage::FileSystem::{
            DELETE, FILE_DISPOSITION_FLAG_ON_CLOSE, FILE_DISPOSITION_INFO_EX,
            FileDispositionInfoEx, READ_CONTROL, SYNCHRONIZE, SetFileInformationByHandle,
            WRITE_DAC, WRITE_OWNER,
        },
    },
};

/// A complete, flushed private stream still owned by the original kernel
/// delete-on-close handle. Its identity is evidence only: a caller must bind
/// its own durable intent and original owner before publishing or recovering.
/// Dropping this value closes the exact handle and removes its temporary file.
pub struct PreparedWindowsImmutableStream {
    directory: PrivateDirectory,
    parent_identity: String,
    file: File,
    identity: PortableLeaseIdentity,
    temporary_name: OsString,
    name: OsString,
    byte_len: u64,
}

/// A published stream whose original file and parent handles remain open.
///
/// Keeping this witness alive prevents a later reopen from confusing a newly
/// allocated file with the still-open original. It is not a durable receipt,
/// does not authenticate the operation, and cannot prove identity after the
/// owning process exits. The caller must verify the original digest and keep
/// the witness and its own operation lease until the receipt commits.
pub struct PublishedWindowsImmutableStream {
    original: PreparedWindowsImmutableStream,
}

impl PublishedWindowsImmutableStream {
    pub fn identity(&self) -> &PortableLeaseIdentity {
        &self.original.identity
    }

    pub fn byte_len(&self) -> u64 {
        self.original.byte_len
    }

    /// Recheck the held original file, its held parent and the current name.
    /// This does not verify contents, the parent profile's attachment or any
    /// operation authority. The caller must check those facts separately.
    pub fn revalidate(&self) -> Result<()> {
        let original = &self.original;
        original.directory.verify_private_directory()?;
        anyhow::ensure!(
            original.directory.directory_identity()? == original.parent_identity
                && original
                    .directory
                    .portable_regular_handle_identity(&original.file)?
                    == original.identity
                && original
                    .directory
                    .portable_regular_identity(&original.name)?
                    == original.identity,
            "published immutable stream identity changed"
        );
        Ok(())
    }
}

impl PreparedWindowsImmutableStream {
    /// Native file identity to bind into the original owner's intent.
    pub fn identity(&self) -> &PortableLeaseIdentity {
        &self.identity
    }

    pub fn byte_len(&self) -> u64 {
        self.byte_len
    }

    /// Verify the held parent and original prepared file against its private
    /// temporary name without publishing the destination. This is not a
    /// content digest, operation authorization, or proof after process exit.
    pub fn revalidate_prepared(&self) -> Result<()> {
        self.directory.verify_private_directory()?;
        anyhow::ensure!(
            self.directory.directory_identity()? == self.parent_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.file)?
                    == self.identity
                && self
                    .directory
                    .portable_regular_identity(&self.temporary_name)?
                    == self.identity
                && self.file.metadata()?.len() == self.byte_len,
            "prepared immutable stream identity changed"
        );
        Ok(())
    }

    /// Publish only the leaf fixed at preparation, without replacing anything.
    /// A post-rename error is uncertain: reconcile the original saved identity
    /// and receipt rather than calling the writer again or adopting by bytes.
    /// The owner must also recheck that the held directory is still attached to
    /// the expected profile before committing a receipt.
    pub fn publish(self) -> Result<u64> {
        Ok(self.publish_held()?.byte_len())
    }

    /// Publish while retaining the original handle for the caller's receipt
    /// transaction. A crash drops this process-local proof; recovery must use
    /// independently established durable provenance or remain unknown.
    pub fn publish_held(self) -> Result<PublishedWindowsImmutableStream> {
        self.directory.verify_private_directory()?;
        anyhow::ensure!(
            self.directory.directory_identity()? == self.parent_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.file)?
                    == self.identity,
            "prepared immutable stream identity changed"
        );
        windows_native::rename_handle_relative_with_replace(
            &self.file,
            &self.directory.directory,
            &self.name,
            false,
        )?;
        // Clear the handle's on-close bit only after the complete file has its
        // final name. A crash before this point removes the owned file, including
        // a complete renamed file, so no partial archive can become committed.
        let disposition = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_ON_CLOSE,
        };
        // SAFETY: this original no-follow file owns DELETE access; the initialized
        // input buffer has the exact size required by FileDispositionInfoEx.
        anyhow::ensure!(
            unsafe {
                SetFileInformationByHandle(
                    self.file.as_raw_handle().cast(),
                    FileDispositionInfoEx,
                    (&disposition as *const FILE_DISPOSITION_INFO_EX).cast(),
                    size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
                )
            } != 0,
            std::io::Error::last_os_error()
        );
        self.directory.sync()?;
        let published = PublishedWindowsImmutableStream { original: self };
        published.revalidate()?;
        Ok(published)
    }
}

impl PrivateDirectory {
    /// Publish an immutable stream without leaving a named partial on process exit.
    /// Unsupported delete-disposition semantics fail closed; an existing target is
    /// never replaced. This does not grant recovery or deletion of any other entry.
    pub fn publish_crash_safe_immutable_stream(
        &self,
        name: &OsStr,
        reader: &mut impl std::io::Read,
    ) -> Result<u64> {
        self.prepare_crash_safe_immutable_stream(name, reader)?
            .publish()
    }

    /// Prepare and flush a complete stream without publishing its final name.
    /// The returned object owns the original file until `publish` or drop.
    pub fn prepare_crash_safe_immutable_stream(
        &self,
        name: &OsStr,
        reader: &mut impl std::io::Read,
    ) -> Result<PreparedWindowsImmutableStream> {
        validate_single_name(name)?;
        self.verify_private_directory()?;
        let parent_identity = self.directory_identity()?;
        let (file, temporary_name) = self.create_kernel_cleaned_stream(name)?;
        secure_private_handle(&file, false)?;
        let bytes = std::io::copy(reader, &mut &file)?;
        file.sync_all()?;
        let identity = self.portable_regular_handle_identity(&file)?;
        self.verify_private_directory()?;
        anyhow::ensure!(
            self.directory_identity()? == parent_identity,
            "prepared immutable stream parent changed"
        );
        Ok(PreparedWindowsImmutableStream {
            directory: self.duplicate_handle()?,
            parent_identity,
            file,
            identity,
            temporary_name,
            name: name.to_os_string(),
            byte_len: bytes,
        })
    }

    fn create_kernel_cleaned_stream(&self, name: &OsStr) -> Result<(File, OsString)> {
        for _ in 0..64 {
            let sequence = TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let temporary = OsString::from(format!(
                ".{}.{}.{}.tmp",
                name.to_string_lossy(),
                std::process::id(),
                sequence
            ));
            match windows_native::nt_create_relative(
                &self.directory,
                &temporary,
                GENERIC_READ
                    | GENERIC_WRITE
                    | READ_CONTROL
                    | WRITE_DAC
                    | WRITE_OWNER
                    | DELETE
                    | SYNCHRONIZE,
                FILE_CREATE,
                FILE_NON_DIRECTORY_FILE
                    | FILE_SYNCHRONOUS_IO_NONALERT
                    | FILE_OPEN_REPARSE_POINT
                    | FILE_DELETE_ON_CLOSE,
            ) {
                Ok(file) => return Ok((file, temporary)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        anyhow::bail!("failed to allocate an owned immutable stream")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    const HELPER: &str = "private_files::windows_stream_publication::tests::stream_child";

    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn owned_test_directory() -> std::io::Result<tempfile::TempDir> {
        match std::env::var_os("KCODER_IMMUTABLE_TEST_ROOT") {
            Some(root) => tempfile::tempdir_in(root),
            None => tempfile::tempdir(),
        }
    }

    #[test]
    fn prepared_revalidation_pins_the_unpublished_file_and_rejects_replacement() -> Result<()> {
        let root = owned_test_directory()?;
        let directory = PrivateDirectory::open_or_create(root.path())?;
        let prepared = directory
            .prepare_crash_safe_immutable_stream(OsStr::new("result.bin"), &mut &b""[..])?;
        prepared.revalidate_prepared()?;
        assert!(!root.path().join("result.bin").exists());
        let original_name = prepared.temporary_name.clone();
        windows_native::rename_handle_relative_with_replace(
            &prepared.file,
            &directory.directory,
            OsStr::new("moved.tmp"),
            false,
        )?;
        directory.atomic_replace(&original_name, b"")?;
        assert!(prepared.revalidate_prepared().is_err());
        assert!(!root.path().join("result.bin").exists());
        Ok(())
    }

    #[test]
    fn prepared_revalidation_detects_a_changed_length() -> Result<()> {
        let root = owned_test_directory()?;
        let directory = PrivateDirectory::open_or_create(root.path())?;
        let prepared = directory
            .prepare_crash_safe_immutable_stream(OsStr::new("result.bin"), &mut &b""[..])?;
        prepared.revalidate_prepared()?;
        std::io::Write::write_all(&mut &prepared.file, b"changed")?;
        assert!(prepared.revalidate_prepared().is_err());
        assert!(!root.path().join("result.bin").exists());
        Ok(())
    }

    #[test]
    fn prepared_stream_pins_identity_and_never_replaces_an_existing_leaf() -> Result<()> {
        let root = owned_test_directory()?;
        let directory = PrivateDirectory::open_or_create(root.path())?;
        let prepared = directory.prepare_crash_safe_immutable_stream(
            OsStr::new("result.bin"),
            &mut &b"original bytes"[..],
        )?;
        let original_identity = prepared.identity().clone();
        assert_eq!(prepared.byte_len(), 14);
        assert!(!root.path().join("result.bin").exists());
        assert_eq!(prepared.publish()?, 14);
        assert_eq!(
            directory.portable_regular_identity(OsStr::new("result.bin"))?,
            original_identity
        );
        let other = directory.prepare_crash_safe_immutable_stream(
            OsStr::new("result.bin"),
            &mut &b"original bytes"[..],
        )?;
        assert_ne!(other.identity(), &original_identity);
        assert!(other.publish().is_err());
        assert_eq!(
            directory.portable_regular_identity(OsStr::new("result.bin"))?,
            original_identity
        );
        assert_eq!(
            std::fs::read(root.path().join("result.bin"))?,
            b"original bytes"
        );
        assert_eq!(std::fs::read_dir(root.path())?.count(), 1);
        Ok(())
    }

    #[test]
    fn published_witness_keeps_the_original_and_rejects_same_bytes_at_a_replaced_name() -> Result<()>
    {
        let root = owned_test_directory()?;
        let directory = PrivateDirectory::open_or_create(root.path())?;
        let prepared = directory.prepare_crash_safe_immutable_stream(
            OsStr::new("result.bin"),
            &mut &b"original bytes"[..],
        )?;
        let original_identity = prepared.identity().clone();
        let published = prepared.publish_held()?;
        assert_eq!(published.identity(), &original_identity);
        assert_eq!(published.byte_len(), 14);
        published.revalidate()?;

        // Keep the real handle open while replacing its old name with a new
        // object carrying exactly the same bytes. Identity must still fail.
        windows_native::rename_handle_relative_with_replace(
            &published.original.file,
            &published.original.directory.directory,
            OsStr::new("moved.bin"),
            false,
        )?;
        directory.publish_crash_safe_immutable_stream(
            OsStr::new("result.bin"),
            &mut &b"original bytes"[..],
        )?;
        assert_eq!(
            std::fs::read(root.path().join("result.bin"))?,
            b"original bytes"
        );
        assert_ne!(
            directory.portable_regular_identity(OsStr::new("result.bin"))?,
            original_identity
        );
        assert_eq!(published.original.file.metadata()?.len(), 14);
        assert!(published.revalidate().is_err());
        Ok(())
    }

    #[test]
    fn dropping_a_prepared_stream_removes_only_the_owned_temporary() -> Result<()> {
        let root = owned_test_directory()?;
        let directory = PrivateDirectory::open_or_create(root.path())?;
        std::fs::write(root.path().join("unowned.txt"), b"preserve")?;
        let prepared = directory.prepare_crash_safe_immutable_stream(
            OsStr::new("unpublished.bin"),
            &mut &b"prepared bytes"[..],
        )?;
        assert!(!root.path().join("unpublished.bin").exists());
        drop(prepared);
        assert_eq!(std::fs::read(root.path().join("unowned.txt"))?, b"preserve");
        assert_eq!(std::fs::read_dir(root.path())?.count(), 1);
        Ok(())
    }

    #[test]
    fn killed_owner_preserves_the_actual_prepared_identity_at_each_publication_boundary()
    -> Result<()> {
        for phase in ["prepared", "published"] {
            let root = owned_test_directory()?;
            let directory = PrivateDirectory::open_or_create(root.path())?;
            std::fs::write(root.path().join("unowned.txt"), b"preserve")?;
            let ready = root.path().join("child-ready");
            let intent = root.path().join("child-intent.json");
            let mut child = OwnedChild(
                Command::new(std::env::current_exe()?)
                    .args(["--ignored", "--exact", HELPER, "--nocapture"])
                    .env("KCODER_STREAM_TEST_ROOT", root.path())
                    .env("KCODER_STREAM_TEST_PHASE", phase)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::inherit())
                    .spawn()?,
            );
            let deadline = Instant::now() + Duration::from_secs(15);
            while !ready.exists() {
                anyhow::ensure!(
                    child.0.try_wait()?.is_none(),
                    "owned stream child exited before {phase}"
                );
                anyhow::ensure!(Instant::now() < deadline, "owned stream child timed out");
                std::thread::sleep(Duration::from_millis(20));
            }
            let identity: PortableLeaseIdentity = serde_json::from_slice(&std::fs::read(&intent)?)?;
            child.0.kill()?;
            child.0.wait()?;
            std::fs::remove_file(&ready)?;
            std::fs::remove_file(&intent)?;
            assert_eq!(std::fs::read(root.path().join("unowned.txt"))?, b"preserve");
            if phase == "prepared" {
                assert!(!root.path().join("source.bin").exists());
                assert_eq!(std::fs::read_dir(root.path())?.count(), 1);
            } else {
                assert_eq!(
                    std::fs::read(root.path().join("source.bin"))?,
                    b"complete bytes"
                );
                assert_eq!(
                    directory.portable_regular_identity(OsStr::new("source.bin"))?,
                    identity
                );
                assert_eq!(std::fs::read_dir(root.path())?.count(), 2);
            }
        }
        Ok(())
    }

    #[test]
    fn process_exit_removes_partial_stream_and_complete_publication_is_no_replace() -> Result<()> {
        let root = owned_test_directory()?;
        let directory = PrivateDirectory::open_or_create(root.path())?;
        std::fs::write(root.path().join("unowned.tmp"), b"user-owned bytes")?;
        let ready = root.path().join("child-ready");
        let mut child = OwnedChild(
            Command::new(std::env::current_exe()?)
                .args(["--ignored", "--exact", HELPER, "--nocapture"])
                .env("KCODER_STREAM_TEST_ROOT", root.path())
                .env_remove("KCODER_STREAM_TEST_PHASE")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?,
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        while !ready.exists() {
            anyhow::ensure!(
                child.0.try_wait()?.is_none(),
                "owned stream child exited before partial write"
            );
            anyhow::ensure!(
                Instant::now() < deadline,
                "owned stream child did not reach partial write"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        child.0.kill()?;
        child.0.wait()?;
        std::fs::remove_file(&ready)?;
        let names = std::fs::read_dir(root.path())?
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(names, [OsStr::new("unowned.tmp")]);
        assert_eq!(
            std::fs::read(root.path().join("unowned.tmp"))?,
            b"user-owned bytes"
        );
        assert_eq!(
            directory.publish_crash_safe_immutable_stream(
                OsStr::new("source.bin"),
                &mut &b"complete bytes"[..]
            )?,
            14
        );
        assert_eq!(
            std::fs::read(root.path().join("source.bin"))?,
            b"complete bytes"
        );
        assert!(
            directory
                .publish_crash_safe_immutable_stream(
                    OsStr::new("source.bin"),
                    &mut &b"replacement"[..]
                )
                .is_err()
        );
        assert_eq!(
            std::fs::read(root.path().join("source.bin"))?,
            b"complete bytes"
        );
        assert_eq!(std::fs::read_dir(root.path())?.count(), 2);
        Ok(())
    }

    #[test]
    #[ignore = "owned child process selected only by the parent crash test"]
    fn stream_child() -> Result<()> {
        struct PausedStream {
            root: PathBuf,
            wrote: bool,
        }
        impl Read for PausedStream {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if !self.wrote {
                    self.wrote = true;
                    buffer[0] = 42;
                    return Ok(1);
                }
                std::fs::write(self.root.join("child-ready"), b"partial stream")?;
                loop {
                    std::thread::park();
                }
            }
        }
        let root = PathBuf::from(
            std::env::var_os("KCODER_STREAM_TEST_ROOT").context("owned test root required")?,
        );
        let directory = PrivateDirectory::open_existing(&root)?;
        if let Ok(phase) = std::env::var("KCODER_STREAM_TEST_PHASE") {
            anyhow::ensure!(matches!(phase.as_str(), "prepared" | "published"));
            let prepared = directory.prepare_crash_safe_immutable_stream(
                OsStr::new("source.bin"),
                &mut &b"complete bytes"[..],
            )?;
            std::fs::write(
                root.join("child-intent.json"),
                serde_json::to_vec(prepared.identity())?,
            )?;
            if phase == "published" {
                prepared.publish()?;
            }
            std::fs::write(root.join("child-ready"), phase.as_bytes())?;
            loop {
                std::thread::park();
            }
        }
        directory.publish_crash_safe_immutable_stream(
            OsStr::new("source.bin"),
            &mut PausedStream { root, wrote: false },
        )?;
        anyhow::bail!("parent must terminate this owned stream child")
    }
}
