use super::*;

impl PlanStore {
    pub(super) fn mutate(
        &self,
        work_id: &str,
        expected_revision: u64,
        operation: impl FnOnce(&str, &mut WorkState) -> anyhow::Result<String>,
    ) -> anyhow::Result<WorkSnapshot> {
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let current = self.read_work(work_id)?;
        if current.work.revision != expected_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: current.work.revision,
            }
            .into());
        }
        let mut work = current.work;
        self.cleanup_uncommitted_revisions(&work_dir, work.revision)?;
        let plan = operation(&current.plan, &mut work)?;
        let parsed = parse_plan(&plan)?;
        work.revision += 1;
        work.updated_at = Utc::now();
        work.plan_sha256 = sha256(plan.as_bytes());
        work.progress = parsed.progress(work.plan_sha256.clone());
        if parsed.tasks.iter().all(|task| task.completed) {
            work.status = WorkStatus::Completed;
        } else if work.status == WorkStatus::Completed {
            work.status = WorkStatus::Active;
        }
        self.commit_revision(&work_dir, &plan, &work)?;
        Ok(WorkSnapshot { plan, work })
    }

    pub(super) fn commit_revision(
        &self,
        work_dir: &Path,
        plan: &str,
        work: &WorkState,
    ) -> anyhow::Result<()> {
        let revisions = work_dir.join("revisions");
        create_directory_no_follow(&revisions)?;
        #[cfg(windows)]
        let _lease = windows_io::DirectoryLease::acquire(&revisions, false)?;
        let revision_dir = revisions.join(work.revision.to_string());
        create_new_directory(&revision_dir)
            .with_context(|| format!("revision {} already exists", work.revision))?;
        write_new_file(&revision_dir.join("plan.md"), plan.as_bytes())?;
        maybe_fail_planstore_commit("after_plan")?;
        let work_bytes = serde_json::to_vec_pretty(work)?;
        write_new_file(&revision_dir.join("work.json"), &work_bytes)?;
        maybe_fail_planstore_commit("after_work")?;
        sync_directory(&revision_dir)?;
        let manifest = CurrentManifest {
            schema_version: SCHEMA_VERSION,
            revision: work.revision,
            plan_sha256: work.plan_sha256.clone(),
            work_sha256: sha256(&work_bytes),
        };
        maybe_fail_planstore_commit("before_current")?;
        write_json_atomic(&work_dir.join("current.json"), &manifest)?;
        sync_directory(work_dir)
    }

    pub(super) fn prepare_root(&self) -> anyhow::Result<()> {
        #[cfg(windows)]
        {
            let mut lease = self
                .root_lease
                .lock()
                .map_err(|_| anyhow::anyhow!("PlanStore root lease poisoned"))?;
            if lease.is_none() {
                *lease = Some(windows_io::DirectoryLease::acquire(&self.root, true)?);
            }
            windows_io::DirectoryLease::acquire(&self.root.join("works"), true)?;
            Ok(())
        }
        #[cfg(not(any(unix, windows)))]
        {
            bail!(
                "PlanStore requires secure handle-relative directory I/O; this platform is not supported yet"
            );
        }
        #[cfg(unix)]
        {
            if self
                .root_handle
                .lock()
                .map_err(|_| anyhow::anyhow!("PlanStore root handle lock poisoned"))?
                .is_some()
            {
                // Verify that the pinned handle and public path still identify the same inode before touching the replacement directory.
                let root = self.io_root()?;
                let works = root.join("works");
                if works.exists() {
                    ensure_not_symlink(&works)?;
                } else {
                    fs::create_dir(&works)?;
                }
                return Ok(());
            }
            create_dir_all_safe(&self.root)?;
            create_dir_all_safe(&self.root.join("works"))?;
            self.io_root()?;
            Ok(())
        }
    }

    pub(super) fn lock_store(&self) -> anyhow::Result<LockGuard> {
        LockGuard::acquire(&self.io_root()?.join("store.lock"))
    }

    pub(super) fn lock_work(&self, work_dir: &Path) -> anyhow::Result<LockGuard> {
        LockGuard::acquire(&work_dir.join("work.lock"))
    }

    pub(super) fn work_dir(&self, work_id: &str) -> anyhow::Result<PathBuf> {
        validate_work_id(work_id)?;
        self.prepare_root()?;
        Ok(self.io_root()?.join("works").join(work_id))
    }

    pub(super) fn read_index(&self) -> anyhow::Result<StoreIndex> {
        let path = self.io_root()?.join("state.json");
        if !path.exists() {
            return Ok(StoreIndex::default());
        }
        let index: StoreIndex = read_json_no_follow(&path)?;
        if index.schema_version != SCHEMA_VERSION {
            bail!(
                "unsupported PlanStore schema version {}",
                index.schema_version
            );
        }
        Ok(index)
    }

    pub(super) fn write_index(&self, index: &StoreIndex) -> anyhow::Result<()> {
        let root = self.io_root()?;
        write_json_atomic(&root.join("state.json"), index)?;
        sync_directory(&root)
    }

    pub(super) fn validate_indexed_work(
        &self,
        index: &StoreIndex,
        work_id: &str,
    ) -> anyhow::Result<()> {
        validate_work_id(work_id)?;
        if !index.works.contains_key(work_id) {
            return Err(PlanStoreError::WorkNotFound(work_id.to_string()).into());
        }
        Ok(())
    }

    pub(super) fn cleanup_unindexed_works(&self, index: &StoreIndex) -> anyhow::Result<()> {
        let works = self.io_root()?.join("works");
        #[cfg(windows)]
        let _lease = windows_io::DirectoryLease::acquire(&works, false)?;
        for entry in read_directory(&works)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if validate_work_id(&name).is_err() || index.works.contains_key(&name) {
                continue;
            }
            let path = entry.path();
            ensure_not_symlink(&path)?;
            remove_directory_tree(&path)
                .with_context(|| format!("failed to clean orphan work {name}"))?;
        }
        sync_directory(&works)
    }

    pub(super) fn cleanup_uncommitted_revisions(
        &self,
        work_dir: &Path,
        current_revision: u64,
    ) -> anyhow::Result<()> {
        let revisions = work_dir.join("revisions");
        #[cfg(windows)]
        let _lease = windows_io::DirectoryLease::acquire(&revisions, false)?;
        for entry in read_directory(&revisions)? {
            let entry = entry?;
            let Some(revision) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u64>().ok())
            else {
                continue;
            };
            if revision <= current_revision {
                continue;
            }
            let path = entry.path();
            ensure_not_symlink(&path)?;
            remove_directory_tree(&path)
                .with_context(|| format!("failed to clean uncommitted revision {revision}"))?;
        }
        sync_directory(&revisions)
    }

    #[cfg(unix)]
    pub(super) fn io_root(&self) -> anyhow::Result<PathBuf> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        use std::os::unix::io::AsRawFd;

        let mut guard = self
            .root_handle
            .lock()
            .map_err(|_| anyhow::anyhow!("PlanStore root handle lock poisoned"))?;
        if guard.is_none() {
            ensure_not_symlink(&self.root)?;
            let mut options = OpenOptions::new();
            options
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
            *guard = Some(options.open(&self.root).with_context(|| {
                format!("failed to open PlanStore root {}", self.root.display())
            })?);
        }
        let handle = guard
            .as_ref()
            .expect("PlanStore root handle initialized above");
        ensure_not_symlink(&self.root)?;
        let original = fs::metadata(&self.root)
            .with_context(|| format!("PlanStore root disappeared: {}", self.root.display()))?;
        let opened = handle.metadata()?;
        if original.dev() != opened.dev() || original.ino() != opened.ino() {
            return Err(PlanStoreError::UnsafePath(format!(
                "PlanStore root was replaced: {}",
                self.root.display()
            ))
            .into());
        }
        #[cfg(target_os = "linux")]
        let fd_root = format!("/proc/self/fd/{}", handle.as_raw_fd());
        #[cfg(target_os = "linux")]
        return Ok(PathBuf::from(fd_root));

        #[cfg(target_os = "macos")]
        {
            use std::ffi::CStr;
            use std::os::unix::ffi::OsStringExt;

            // On macOS, /dev/fd/<n> can duplicate a descriptor but cannot serve as a prefix
            // for descendant traversal. Darwin F_GETPATH resolves an open descriptor's path;
            // verify the inode again afterward so I/O cannot be redirected to another directory.
            let mut buffer = vec![0 as libc::c_char; libc::PATH_MAX as usize];
            let result =
                unsafe { libc::fcntl(handle.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
            if result == -1 {
                return Err(std::io::Error::last_os_error())
                    .context("failed to resolve macOS PlanStore root handle");
            }
            let resolved = unsafe { CStr::from_ptr(buffer.as_ptr()) };
            let resolved =
                PathBuf::from(std::ffi::OsString::from_vec(resolved.to_bytes().to_vec()));
            let resolved_metadata = fs::metadata(&resolved).with_context(|| {
                format!(
                    "resolved macOS PlanStore root disappeared: {}",
                    resolved.display()
                )
            })?;
            if resolved_metadata.dev() != opened.dev() || resolved_metadata.ino() != opened.ino() {
                return Err(PlanStoreError::UnsafePath(format!(
                    "resolved macOS PlanStore root changed: {}",
                    resolved.display()
                ))
                .into());
            }
            Ok(resolved)
        }

        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        bail!("PlanStore secure directory I/O is only supported on Linux and macOS Unix targets")
    }

    #[cfg(windows)]
    pub(super) fn io_root(&self) -> anyhow::Result<PathBuf> {
        self.prepare_root()?;
        Ok(self.root.clone())
    }

    #[cfg(not(any(unix, windows)))]
    pub(super) fn io_root(&self) -> anyhow::Result<PathBuf> {
        bail!(
            "PlanStore requires secure handle-relative directory I/O; this platform is not supported yet"
        )
    }
}
