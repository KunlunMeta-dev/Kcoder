//! Handle-relative traversal with a constant number of open leaf handles.
use super::{PrivateDirectory, validate_single_name};
use anyhow::{Context, Result};
use std::{ffi::OsStr, fs::File};

impl PrivateDirectory {
    /// Visit every leaf name through this directory handle, including non-regular entries.
    /// Exceeding the bound or any enumeration/callback error rejects the complete inventory.
    /// Callers decide which types are valid by opening entries relative to the same handle.
    pub fn visit_entry_names_bounded(
        &self,
        limit: usize,
        mut visitor: impl FnMut(&OsStr) -> Result<()>,
    ) -> Result<()> {
        anyhow::ensure!(
            (1..=65_536).contains(&limit),
            "invalid directory entry budget"
        );
        #[cfg(unix)]
        {
            for (ordinal, entry) in cap_primitives::fs::read_base_dir(&self.directory)?.enumerate()
            {
                anyhow::ensure!(ordinal < limit, "directory inventory exceeds entry budget");
                let name = entry?.file_name();
                validate_single_name(&name)?;
                visitor(&name)?;
            }
        }
        #[cfg(windows)]
        {
            // The native query copies at most limit + 1 names, rather than an unbounded list.
            let names = super::windows_native::directory_names_bounded(&self.directory, limit + 1)?;
            anyhow::ensure!(
                names.len() <= limit,
                "directory inventory exceeds entry budget"
            );
            for name in names {
                validate_single_name(&name)?;
                visitor(&name)?;
            }
        }
        Ok(())
    }

    /// Visit ordinary leaves one at a time. Opening/reading failures abort the scan
    /// rather than presenting a partial inventory as complete. The callback may
    /// borrow the verified handle; it must clone explicitly to retain one.
    pub fn visit_regular_files(
        &self,
        mut predicate: impl FnMut(&OsStr) -> bool,
        mut visitor: impl FnMut(&OsStr, &File) -> Result<()>,
    ) -> Result<()> {
        #[cfg(unix)]
        for entry in cap_primitives::fs::read_base_dir(&self.directory)? {
            let entry = entry?;
            let name = entry.file_name();
            if validate_single_name(&name).is_err() || !predicate(&name) {
                continue;
            }
            // Do not open FIFOs, sockets, directories or links. Opening the
            // selected leaf below still rechecks its type without following it.
            if !entry.file_type()?.is_file() {
                continue;
            }
            let file = self.open_regular_file(&name).with_context(|| {
                format!("failed to scan private leaf {}", name.to_string_lossy())
            })?;
            visitor(&name, &file)?;
        }
        #[cfg(windows)]
        for name in super::windows_native::directory_names(&self.directory)? {
            if validate_single_name(&name).is_err() || !predicate(&name) {
                continue;
            }
            if !self.entry_metadata(&name)?.is_file() {
                continue;
            }
            let file = self.open_regular_file(&name).with_context(|| {
                format!("failed to scan private leaf {}", name.to_string_lossy())
            })?;
            visitor(&name, &file)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_entry_inventory_is_bounded_and_reports_directories() {
        let root = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        std::fs::write(root.path().join("record"), b"record").unwrap();
        std::fs::create_dir(root.path().join("child")).unwrap();
        let mut names = Vec::new();
        directory
            .visit_entry_names_bounded(2, |name| {
                names.push(name.to_string_lossy().into_owned());
                Ok(())
            })
            .unwrap();
        names.sort();
        assert_eq!(names, ["child", "record"]);
        assert!(directory.visit_entry_names_bounded(1, |_| Ok(())).is_err());
        assert!(directory.visit_entry_names_bounded(0, |_| Ok(())).is_err());
    }

    #[test]
    fn strict_entry_inventory_stops_at_callback_failure() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..3 {
            std::fs::write(root.path().join(format!("record-{index}")), b"x").unwrap();
        }
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        let mut seen = 0;
        assert!(
            directory
                .visit_entry_names_bounded(3, |_| {
                    seen += 1;
                    anyhow::bail!("capture budget exceeded")
                })
                .is_err()
        );
        assert_eq!(seen, 1);
    }

    #[cfg(unix)]
    #[test]
    fn strict_entry_inventory_uses_pinned_handle_after_path_replacement_and_reports_links() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("current");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("original"), b"original").unwrap();
        symlink(root.path().join("absent"), path.join("link")).unwrap();
        let directory = PrivateDirectory::open_existing(&path).unwrap();
        std::fs::rename(&path, root.path().join("held")).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("replacement"), b"replacement").unwrap();
        let mut names = Vec::new();
        directory
            .visit_entry_names_bounded(2, |name| {
                names.push(name.to_string_lossy().into_owned());
                Ok(())
            })
            .unwrap();
        names.sort();
        assert_eq!(names, ["link", "original"]);
        assert!(directory.open_regular_file(OsStr::new("link")).is_err());
        assert!(directory.open_regular_file(OsStr::new("original")).is_ok());
    }

    #[test]
    fn callback_failure_aborts_without_leaking_scan_handles() {
        let root = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_or_create(root.path()).unwrap();
        for index in 0..20 {
            directory
                .atomic_replace(OsStr::new(&format!("record-{index}")), b"record")
                .unwrap();
        }
        let error = directory
            .visit_regular_files(|_| true, |_, _| anyhow::bail!("callback rejected record"))
            .unwrap_err();
        assert!(error.to_string().contains("callback rejected"));
        let mut count = 0;
        directory
            .visit_regular_files(
                |_| true,
                |_, _| {
                    count += 1;
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(count, 20);
    }

    #[cfg(unix)]
    #[test]
    fn many_records_under_low_descriptor_budget_never_return_a_partial_inventory() {
        const CHILD_ROOT: &str = "KCODER_PRIVATE_SCAN_CHILD_ROOT";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let directory = PrivateDirectory::open_existing(std::path::Path::new(&root)).unwrap();
            let mut limits = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            // SAFETY: this exact child test owns the process-wide limit changes.
            assert_eq!(
                unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limits) },
                0
            );
            limits.rlim_cur = limits.rlim_max.min(32);
            assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limits) }, 0);
            let mut count = 0;
            directory
                .visit_regular_files(
                    |_| true,
                    |_, file| {
                        assert_eq!(file.metadata()?.len(), 6);
                        count += 1;
                        Ok(())
                    },
                )
                .unwrap();
            assert_eq!(count, 200);
            // The explicitly retaining API must fail rather than hide EMFILE.
            assert!(directory.open_regular_files(|_| true).is_err());
            assert_eq!(
                directory
                    .count_regular_files_bounded(|_| true, 201)
                    .unwrap(),
                200
            );
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_or_create(root.path()).unwrap();
        for index in 0..200 {
            directory
                .atomic_replace(OsStr::new(&format!("record-{index}")), b"record")
                .unwrap();
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "private_files::regular_scan::tests::many_records_under_low_descriptor_budget_never_return_a_partial_inventory", "--test-threads=1"])
            .env(CHILD_ROOT, root.path())
            .output().unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
