//! Immutable archive publication must not leave an unowned partial file after a crash.
use super::*;

pub(super) fn publish_archive_file(
    directory: &PrivateDirectory,
    name: &OsStr,
    reader: &mut impl Read,
) -> Result<u64> {
    #[cfg(target_os = "linux")]
    {
        // Reuse the existing no-follow private O_TMPFILE publisher. The kernel
        // removes an interrupted unnamed inode; no scanned filename is adopted
        // or deleted during recovery. Publication never replaces another file.
        let entry = directory.create_anonymous_private_entry()?;
        let bytes = std::io::copy(reader, &mut entry.file())?;
        entry.file().sync_all()?;
        directory.publish_anonymous_private_entry(&entry, name)?;
        directory.sync()?;
        Ok(bytes)
    }
    #[cfg(windows)]
    {
        directory.publish_crash_safe_immutable_stream(name, reader)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        directory.atomic_publish_from_reader(name, reader, false, || Ok(None))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn interrupted_stream_has_no_named_partial_and_preserves_unowned_siblings() -> Result<()> {
        struct Interrupted<'a> {
            root: &'a Path,
            wrote: bool,
        }
        impl Read for Interrupted<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if !self.wrote {
                    self.wrote = true;
                    buffer[0] = 42;
                    return Ok(1);
                }
                let names = std::fs::read_dir(self.root)?
                    .map(|entry| entry.unwrap().file_name())
                    .collect::<Vec<_>>();
                assert_eq!(names, [OsStr::new("unowned.tmp")]);
                Err(std::io::Error::other("owned stream interrupted"))
            }
        }
        let root = tempfile::tempdir()?;
        std::fs::write(root.path().join("unowned.tmp"), b"user-owned bytes")?;
        let directory = PrivateDirectory::open_or_create(root.path())?;
        assert!(
            publish_archive_file(
                &directory,
                OsStr::new("source.bin"),
                &mut Interrupted {
                    root: root.path(),
                    wrote: false
                }
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read(root.path().join("unowned.tmp"))?,
            b"user-owned bytes"
        );
        assert_eq!(std::fs::read_dir(root.path())?.count(), 1);
        assert_eq!(
            publish_archive_file(
                &directory,
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
            publish_archive_file(
                &directory,
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
}
