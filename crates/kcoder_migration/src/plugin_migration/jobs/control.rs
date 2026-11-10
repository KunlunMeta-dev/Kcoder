//! Independent cancellation watermarks never take the worker's long-running lease.
use super::*;
use kcoder_config::{PortableLeaseIdentity, PrivateLeaseMode, VerifiedPrivateLease};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Control {
    version: u8,
    owner: String,
    operation_id: String,
    pub(super) requested: bool,
    revision: u64,
}
pub(super) fn read_control(dir: &PrivateDirectory, job: &Job) -> Result<Control> {
    if job.writer_identity.is_none() && job.control_identity.is_none() {
        return Ok(Control {
            version: 1,
            owner: job.owner.clone(),
            operation_id: job.operation_id.clone(),
            requested: false,
            revision: 0,
        });
    }
    ensure!(
        job.writer_identity.is_some() && job.control_identity.is_some(),
        "plugin_migration_control_unavailable"
    );
    let file = dir.open_regular_file_snapshot(OsStr::new("control.json"))?;
    ensure!(
        file.metadata()?.len() <= 4096,
        "plugin_migration_control_unavailable"
    );
    let mut data = Vec::new();
    file.take(4097).read_to_end(&mut data)?;
    let control: Control = serde_json::from_slice(&data)
        .map_err(|_| anyhow::anyhow!("plugin_migration_control_unavailable"))?;
    ensure!(
        data.len() <= 4096
            && control.version == 1
            && control.owner == job.owner
            && control.operation_id == job.operation_id,
        "plugin_migration_control_changed"
    );
    Ok(control)
}
fn write_control(dir: &PrivateDirectory, control: &Control) -> Result<()> {
    dir.atomic_replace(OsStr::new("control.json"), &serde_json::to_vec(control)?)
}
pub(super) fn initialize(dir: &PrivateDirectory, job: &mut Job) -> Result<()> {
    let _control = dir
        .try_exclusive_lock(OsStr::new("control.lock"))?
        .context("plugin_migration_busy")?;
    job.writer_identity = Some(dir.portable_regular_identity(OsStr::new("writer.lock"))?);
    job.control_identity = Some(dir.portable_regular_identity(OsStr::new("control.lock"))?);
    write_control(
        dir,
        &Control {
            version: 1,
            owner: job.owner.clone(),
            operation_id: job.operation_id.clone(),
            requested: false,
            revision: 0,
        },
    )
}
fn lease(
    dir: &PrivateDirectory,
    name: &str,
    identity: &PortableLeaseIdentity,
) -> Result<Option<VerifiedPrivateLease>> {
    dir.try_existing_portable_lock(OsStr::new(name), identity, PrivateLeaseMode::Exclusive)
}
struct Probe {
    root: PathBuf,
    profile: PathBuf,
    owner: String,
    profile_identity: String,
    job_id: String,
    cache: std::sync::Mutex<Option<(std::time::Instant, bool)>>,
}
impl Probe {
    fn stopped(&self) -> bool {
        let Ok(mut cache) = self.cache.lock() else {
            return true;
        };
        if let Some((at, value)) = *cache
            && at.elapsed() < std::time::Duration::from_millis(25)
        {
            return value;
        }
        let value = (|| -> Result<bool> {
            let profile = PrivateDirectory::open_existing(&self.profile)?;
            ensure!(
                profile.directory_identity()? == self.profile_identity,
                "plugin_migration_profile_changed"
            );
            let dir = PrivateDirectory::open_existing(&self.root)?;
            ensure!(
                dir.directory_identity()? == self.owner,
                "plugin_migration_owner_changed"
            );
            let job = read_job(&dir)?;
            ensure!(
                job.operation_id == self.job_id && job.owner == self.owner,
                "plugin_migration_owner_changed"
            );
            Ok(read_control(&dir, &job)?.requested)
        })()
        .unwrap_or(true);
        *cache = Some((std::time::Instant::now(), value));
        value
    }
}
impl PluginMigrationStore {
    pub(super) fn project(
        &self,
        dir: &PrivateDirectory,
        mut job: Job,
    ) -> Result<PluginMigrationView> {
        let control = read_control(dir, &job)?;
        if !job.imported
            && (control.requested
                || matches!(
                    job.stage,
                    PluginMigrationStage::Capturing
                        | PluginMigrationStage::Applying
                        | PluginMigrationStage::Undoing
                ))
            && !self.running(&job.operation_id)?
        {
            job.stage = if control.requested {
                PluginMigrationStage::Cancelled
            } else {
                PluginMigrationStage::OutcomeUnknown
            };
        }
        let mut result = view(job);
        result.cancel_requested = control.requested;
        result.cancel_revision = control.revision;
        Ok(result)
    }
    pub(super) fn controlled(
        &self,
        job: &Job,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginCancellationToken> {
        ensure!(
            job.writer_identity.is_some() && job.control_identity.is_some(),
            "plugin_migration_legacy_control_unavailable"
        );
        let probe = Probe {
            root: self.root.join(DIRECTORY).join(&job.operation_id),
            profile: self.root.clone(),
            owner: job.owner.clone(),
            profile_identity: self.profile.clone(),
            job_id: job.operation_id.clone(),
            cache: std::sync::Mutex::new(None),
        };
        Ok(cancel.clone().with_probe(move || probe.stopped()))
    }
    pub fn running(&self, id: &str) -> Result<bool> {
        let (dir, job) = self.load(id)?;
        let expected = job
            .writer_identity
            .as_ref()
            .context("plugin_migration_legacy_control_unavailable")?;
        Ok(lease(&dir, "writer.lock", expected)?.is_none())
    }
    pub fn cancel(&self, id: &str, sequence: u64) -> Result<PluginMigrationView> {
        let (dir, job) = self.load(id)?;
        self.authorize_consumer(&job, None)?;
        ensure!(job.sequence == sequence, "plugin_migration_stale_sequence");
        let expected = job
            .control_identity
            .as_ref()
            .context("plugin_migration_legacy_control_unavailable")?;
        let _control = lease(&dir, "control.lock", expected)?.context("plugin_migration_busy")?;
        let mut control = read_control(&dir, &job)?;
        if !control.requested {
            control.requested = true;
            control.revision = control
                .revision
                .checked_add(1)
                .context("plugin_migration_sequence_exhausted")?;
            write_control(&dir, &control)?
        }
        drop(_control);
        self.read(id, &PluginCancellationToken::default())
    }
    pub fn resume(&self, id: &str, sequence: u64) -> Result<PluginMigrationView> {
        self.resume_owned(id, sequence, None)
    }
    pub(crate) fn resume_received_owned(
        &self,
        id: &str,
        sequence: u64,
        preview: &str,
    ) -> Result<PluginMigrationView> {
        self.resume_owned(id, sequence, Some(preview))
    }
    fn resume_owned(
        &self,
        id: &str,
        sequence: u64,
        preview: Option<&str>,
    ) -> Result<PluginMigrationView> {
        let (dir, mut job) = self.load(id)?;
        self.authorize_received_capture(&job, preview)?;
        let _writer = Self::locked(&dir, &job)?;
        ensure!(job.sequence == sequence, "plugin_migration_stale_sequence");
        self.observe(&mut job, &PluginCancellationToken::default())?;
        ensure!(
            self.scope_ready(&job) && job.stage != PluginMigrationStage::Pending,
            "plugin_migration_pending_resolution_required"
        );
        ensure!(
            job.imported
                || job
                    .pending
                    .iter()
                    .all(|code| code == "plugin_capture_not_complete"),
            "plugin_migration_pending_resolution_required"
        );
        ensure!(
            job.stage != PluginMigrationStage::Undone,
            "plugin_migration_already_retired"
        );
        self.verify_target_project(&job)?;
        let _control = lease(
            &dir,
            "control.lock",
            job.control_identity
                .as_ref()
                .context("plugin_migration_legacy_control_unavailable")?,
        )?
        .context("plugin_migration_busy")?;
        let mut control = read_control(&dir, &job)?;
        control.requested = false;
        control.revision = control
            .revision
            .checked_add(1)
            .context("plugin_migration_sequence_exhausted")?;
        write_control(&dir, &control)?;
        if !job.imported {
            job.stage = if job.package.is_some() {
                PluginMigrationStage::Ready
            } else {
                PluginMigrationStage::Prepared
            };
            job.pending.retain(|s| s != "plugin_capture_not_complete");
        }
        job.failure_code = None;
        increment(&mut job)?;
        save(&dir, &job)?;
        self.project(&dir, job)
    }
    pub fn list(&self, cursor: Option<&str>) -> Result<(Vec<PluginMigrationView>, Option<String>)> {
        self.verify()?;
        let mut ids = vec![];
        self.directory
            .visit_entry_names_bounded(MAX_JOBS + 2, |name| {
                if let Some(id) = name.to_str()
                    && operation(id).is_ok()
                {
                    ids.push(id.to_string())
                }
                Ok(())
            })?;
        ensure!(
            ids.len() <= MAX_JOBS,
            "plugin_migration_operation_budget_exceeded"
        );
        ids.sort();
        let identity = hash(&(self.profile.as_str(), self.owner.as_str(), &ids))?;
        let offset = match cursor {
            None => 0,
            Some(value) => {
                let (found, index) = value
                    .split_once(':')
                    .context("plugin_migration_invalid_cursor")?;
                ensure!(found == identity, "plugin_migration_list_changed");
                index
                    .parse::<usize>()
                    .map_err(|_| anyhow::anyhow!("plugin_migration_invalid_cursor"))?
            }
        };
        ensure!(
            offset <= ids.len() && offset % 10 == 0,
            "plugin_migration_invalid_cursor"
        );
        let end = (offset + 10).min(ids.len());
        let mut items = vec![];
        for id in &ids[offset..end] {
            items.push(self.read(id, &PluginCancellationToken::default())?)
        }
        Ok((
            items,
            (end < ids.len()).then(|| format!("{identity}:{end}")),
        ))
    }
}
pub(super) enum WriterLease {
    Legacy { _file: File },
    Verified { _entry: VerifiedPrivateLease },
}
impl PluginMigrationStore {
    pub(super) fn locked(dir: &PrivateDirectory, job: &Job) -> Result<WriterLease> {
        match &job.writer_identity {
            Some(expected) => {
                // A readonly status probe can briefly hold this same verified lease.
                // Retry only acquisition; no callback or publication is replayed.
                for attempt in 0..64 {
                    if let Some(entry) = lease(dir, "writer.lock", expected)? {
                        return Ok(WriterLease::Verified { _entry: entry });
                    }
                    if attempt < 63 {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                }
                Err(anyhow::anyhow!("plugin_migration_busy"))
            }
            None => Ok(WriterLease::Legacy {
                _file: Self::lock(dir)?,
            }),
        }
    }
}
