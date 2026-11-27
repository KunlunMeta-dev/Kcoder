use super::*;

impl PlanStore {
    pub fn for_workspace(workspace: &Path) -> Self {
        // The workspace is a caller-selected trust boundary and may reside under a
        // system alias such as macOS `/var -> /private/var`. Resolve only this layer,
        // then append PlanStore-managed directories. Later no-follow checks still reject links inside `.kcoder`.
        let workspace = fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        Self {
            root: workspace.join(".kcoder").join("orchestrate"),
            #[cfg(unix)]
            root_handle: Arc::new(Mutex::new(None)),
            #[cfg(windows)]
            root_lease: Arc::new(Mutex::new(None)),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn create_work(
        &self,
        display_slug: &str,
        plan: &str,
        session_id: &str,
        select_active: bool,
    ) -> anyhow::Result<WorkSnapshot> {
        validate_display_slug(display_slug)?;
        let parsed = parse_plan(plan)?;
        self.prepare_root()?;
        let _lock = self.lock_store()?;
        let mut index = self.read_index()?;
        self.cleanup_unindexed_works(&index)?;
        let work_id = format!("work_{}", Uuid::new_v4());
        let work_dir = self.work_dir(&work_id)?;
        #[cfg(windows)]
        let _parent_lease = windows_io::DirectoryLease::parent(&work_dir)?;
        create_new_directory(&work_dir).with_context(|| format!("failed to create {work_id}"))?;
        ensure_not_symlink(&work_dir)?;

        let now = Utc::now();
        let plan_sha256 = sha256(plan.as_bytes());
        let work = WorkState {
            schema_version: SCHEMA_VERSION,
            work_id: work_id.clone(),
            display_slug: display_slug.to_string(),
            status: WorkStatus::Active,
            revision: 1,
            plan_sha256: plan_sha256.clone(),
            created_at: now,
            updated_at: now,
            session_ids: vec![session_id.to_string()],
            worktree_path: None,
            goal_id: None,
            progress: parsed.progress(plan_sha256),
            acceptances: BTreeMap::new(),
        };
        self.commit_revision(&work_dir, plan, &work)?;
        maybe_fail_planstore_commit("before_index")?;

        index.works.insert(
            work_id.clone(),
            WorkIndexEntry {
                display_slug: display_slug.to_string(),
                created_at: now,
            },
        );
        if select_active {
            index.active_work_id = Some(work_id);
        }
        self.write_index(&index)?;
        Ok(WorkSnapshot {
            plan: plan.to_string(),
            work,
        })
    }

    pub fn active_work_id(&self) -> anyhow::Result<Option<String>> {
        self.prepare_root()?;
        let _lock = self.lock_store()?;
        let index = self.read_index()?;
        self.cleanup_unindexed_works(&index)?;
        if let Some(work_id) = index.active_work_id.as_deref() {
            self.validate_indexed_work(&index, work_id)?;
        }
        Ok(index.active_work_id)
    }

    pub fn select_active_work(&self, work_id: &str) -> anyhow::Result<()> {
        self.prepare_root()?;
        let _lock = self.lock_store()?;
        let mut index = match self.read_index() {
            Ok(index) => index,
            Err(_) => self.index_from_discovered_works()?,
        };
        self.validate_indexed_work(&index, work_id)?;
        self.read_work(work_id)?;
        index.active_work_id = Some(work_id.to_string());
        self.write_index(&index)
    }

    pub fn list_works(&self) -> anyhow::Result<Vec<WorkSnapshot>> {
        self.prepare_root()?;
        let _lock = self.lock_store()?;
        let index = match self.read_index() {
            Ok(index) => index,
            Err(_) => return self.discover_healthy_works(),
        };
        self.cleanup_unindexed_works(&index)?;
        index
            .works
            .keys()
            .map(|work_id| self.read_work(work_id))
            .collect()
    }

    pub(super) fn discover_healthy_works(&self) -> anyhow::Result<Vec<WorkSnapshot>> {
        let works_dir = self.io_root()?.join("works");
        #[cfg(windows)]
        let _lease = windows_io::DirectoryLease::acquire(&works_dir, false)?;
        let mut snapshots = Vec::new();
        for entry in read_directory(&works_dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if validate_work_id(&name).is_err() {
                continue;
            }
            ensure_not_symlink(&entry.path())?;
            if let Ok(snapshot) = self.read_work(&name) {
                snapshots.push(snapshot);
            }
        }
        snapshots.sort_by(|left, right| {
            left.work
                .created_at
                .cmp(&right.work.created_at)
                .then_with(|| left.work.work_id.cmp(&right.work.work_id))
        });
        Ok(snapshots)
    }

    pub(super) fn index_from_discovered_works(&self) -> anyhow::Result<StoreIndex> {
        let works = self.discover_healthy_works()?;
        if works.is_empty() {
            bail!("PlanStore index is corrupt and no healthy work can be selected");
        }
        Ok(StoreIndex {
            schema_version: SCHEMA_VERSION,
            active_work_id: None,
            works: works
                .into_iter()
                .map(|snapshot| {
                    (
                        snapshot.work.work_id,
                        WorkIndexEntry {
                            display_slug: snapshot.work.display_slug,
                            created_at: snapshot.work.created_at,
                        },
                    )
                })
                .collect(),
        })
    }

    pub fn read_active_work(&self) -> anyhow::Result<WorkSnapshot> {
        let work_id = self.active_work_id()?.ok_or(PlanStoreError::NoActiveWork)?;
        self.read_work(&work_id)
    }

    pub fn read_work(&self, work_id: &str) -> anyhow::Result<WorkSnapshot> {
        let work_dir = self.work_dir(work_id)?;
        ensure_not_symlink(&work_dir)?;
        let manifest: CurrentManifest = read_json_no_follow(&work_dir.join("current.json"))?;
        let revision_dir = work_dir
            .join("revisions")
            .join(manifest.revision.to_string());
        ensure_not_symlink(&revision_dir)?;
        let plan = read_string_no_follow(&revision_dir.join("plan.md"))?;
        let work_bytes = read_bytes_no_follow(&revision_dir.join("work.json"))?;
        if sha256(plan.as_bytes()) != manifest.plan_sha256
            || sha256(&work_bytes) != manifest.work_sha256
        {
            bail!("PlanStore manifest digest mismatch for {work_id}");
        }
        let work: WorkState = serde_json::from_slice(&work_bytes)?;
        let parsed = parse_plan(&plan)?;
        if work.work_id != work_id
            || work.revision != manifest.revision
            || work.plan_sha256 != manifest.plan_sha256
            || work.progress != parsed.progress(manifest.plan_sha256)
        {
            bail!("PlanStore revision metadata mismatch for {work_id}");
        }
        Ok(WorkSnapshot { plan, work })
    }
}
