//! Prepare is bounded metadata IO; copying belongs to an explicitly owned worker.
use super::*;
const MAX_RESERVED: u64 = 4 * 1024 * 1024 * 1024;
fn target(
    candidate: &PluginMigrationCandidate,
    name: Option<&str>,
    project: Option<&kcoder_plugins::PluginProjectBinding>,
) -> Result<Option<String>> {
    let Some(binding) = &candidate.binding else {
        return Ok(None);
    };
    let namespace = if let Some(project) = project {
        hash(&(
            "mapped-plugin/1",
            binding.kind,
            &binding.source_id,
            &binding.source_scope,
            &binding.version,
            binding
                .uploaded
                .as_ref()
                .map(|source| source.logical_identity())
                .or_else(|| binding.project.as_ref().map(|source| source.identity())),
            project.identity(),
        ))?
    } else if let Some(uploaded) = &binding.uploaded {
        hash(&(
            "uploaded-plugin-target/1",
            uploaded.logical_identity(),
            &binding.source_id,
            &binding.source_scope,
            &binding.version,
        ))?
    } else if let Some(received) = &binding.received {
        hash(&(
            "received-plugin-target/1",
            received.logical_identity()?,
            &binding.version,
            &binding.source_scope,
        ))?
    } else {
        hash(&(binding.kind, &binding.source_id, &binding.source_scope))?
    };
    let original = binding.source_id.parse::<PluginId>()?;
    Ok(Some(
        format!(
            "{}@migrated-{}",
            name.unwrap_or(original.plugin_name()),
            &namespace[..16]
        )
        .parse::<PluginId>()?
        .to_string(),
    ))
}
impl PluginMigrationStore {
    pub fn prepare(
        &self,
        id: &str,
        candidate: &PluginMigrationCandidate,
    ) -> Result<PluginMigrationView> {
        self.prepare_named(id, candidate, None)
    }
    pub fn prepare_named(
        &self,
        id: &str,
        candidate: &PluginMigrationCandidate,
        name: Option<&str>,
    ) -> Result<PluginMigrationView> {
        self.prepare_mapped(id, candidate, name, None)
    }
    /// Native caller authorizes the destination independently of the source project's label.
    pub fn prepare_mapped(
        &self,
        id: &str,
        candidate: &PluginMigrationCandidate,
        name: Option<&str>,
        project: Option<&kcoder_plugins::PluginProjectBinding>,
    ) -> Result<PluginMigrationView> {
        operation(id)?;
        self.verify()?;
        if let Some(project) = project {
            project.verify_for_profile(&self.root)?;
        }
        let desired = target(candidate, name, project)?;
        if let Some(received) = candidate
            .binding
            .as_ref()
            .and_then(|binding| binding.received.as_ref())
        {
            received.verify_preview()?;
            received.verify_mapping(&self.root, project)?;
        }
        let mut pending = candidate.pending.clone();
        if project.is_some()
            && matches!(candidate.scope.as_str(), "project" | "local")
            && candidate.binding.as_ref().is_some_and(|source| {
                source.project.is_some() || source.received.is_some() || source.uploaded.is_some()
            })
        {
            pending.retain(|code| code != "plugin_project_mapping_required");
        }
        let _catalog = self
            .directory
            .try_exclusive_lock(OsStr::new("catalog.lock"))?
            .context("plugin_migration_busy")?;
        match self.load(id) {
            Ok((dir, job)) => {
                ensure!(
                    job.candidate == candidate.id
                        && job.target == desired
                        && job.target_project.as_deref() == project,
                    "plugin_migration_request_changed"
                );
                return self.project(&dir, job);
            }
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
        let mut count = 0;
        self.directory
            .visit_entry_names_bounded(MAX_JOBS + 2, |name| {
                if name.to_str().is_some_and(|s| operation(s).is_ok()) {
                    count += 1
                }
                Ok(())
            })?;
        ensure!(
            count < MAX_JOBS,
            "plugin_migration_operation_budget_exceeded"
        );
        let dir = self.directory.create_private_child(OsStr::new(id))?;
        let _writer = dir
            .try_exclusive_lock(OsStr::new("writer.lock"))?
            .context("plugin_migration_busy")?;
        let mut job = Job {
            version: 1,
            owner: dir.directory_identity()?,
            profile: self.profile.clone(),
            operation_id: id.into(),
            sequence: 0,
            stage: if pending.is_empty() && candidate.binding.is_some() {
                PluginMigrationStage::Prepared
            } else {
                PluginMigrationStage::Pending
            },
            candidate: candidate.id.clone(),
            source: candidate.source,
            name: candidate.name.clone(),
            installed_version: candidate.installed_version.clone(),
            scope: candidate.scope.clone(),
            source_enabled: candidate.source_enabled,
            binding: candidate.binding.clone(),
            target: desired,
            package: None,
            package_owner: None,
            capabilities: vec![],
            pending,
            readiness: vec![],
            imported: false,
            writer_identity: None,
            control_identity: None,
            package_relative: None,
            intended: None,
            attempts: 0,
            reservation: 0,
            claim: None,
            target_project: project.cloned().map(Box::new),
            failure_code: None,
        };
        control::initialize(&dir, &mut job)?;
        save(&dir, &job)?;
        self.project(&dir, job)
    }
    pub fn plan(
        &self,
        id: &str,
        candidate: &PluginMigrationCandidate,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginMigrationView> {
        cancelled(cancel)?;
        let prepared = self.prepare(id, candidate)?;
        if prepared.stage == PluginMigrationStage::Prepared {
            self.capture(id, prepared.sequence, cancel)
        } else {
            self.read(id, cancel)
        }
    }
    pub(super) fn reserve(
        &self,
        dir: &PrivateDirectory,
        job: &mut Job,
        revision: &PluginPackageRevision,
    ) -> Result<()> {
        let wanted = revision
            .bytes
            .checked_add((revision.files as u64).saturating_mul(512))
            .and_then(|bytes| bytes.checked_mul(3))
            .context("plugin_migration_staging_budget_exceeded")?;
        let _catalog = self
            .directory
            .try_exclusive_lock(OsStr::new("catalog.lock"))?
            .context("plugin_migration_busy")?;
        let mut total = 0u64;
        self.directory
            .visit_entry_names_bounded(MAX_JOBS + 2, |name| {
                if let Some(id) = name.to_str()
                    && operation(id).is_ok()
                    && id != job.operation_id
                {
                    let (_, other) = self.load(id)?;
                    total = total
                        .checked_add(other.reservation)
                        .context("plugin_migration_staging_budget_exceeded")?;
                }
                Ok(())
            })?;
        ensure!(
            total
                .checked_add(wanted)
                .is_some_and(|total| total <= MAX_RESERVED),
            "plugin_migration_staging_budget_exceeded"
        );
        job.reservation = job.reservation.max(wanted);
        save(dir, job)
    }
    pub fn capture(
        &self,
        id: &str,
        sequence: u64,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginMigrationView> {
        self.capture_owned(id, sequence, None, cancel)
    }
    pub(crate) fn capture_received_owned(
        &self,
        id: &str,
        sequence: u64,
        preview: &str,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginMigrationView> {
        self.capture_owned(id, sequence, Some(preview), cancel)
    }
    fn capture_owned(
        &self,
        id: &str,
        sequence: u64,
        preview: Option<&str>,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginMigrationView> {
        let (dir, mut job) = self.load(id)?;
        self.authorize_received_capture(&job, preview)?;
        let _writer = Self::locked(&dir, &job)?;
        ensure!(job.sequence == sequence, "plugin_migration_stale_sequence");
        ensure!(
            !control::read_control(&dir, &job)?.requested,
            "plugin_migration_cancelled"
        );
        if job.package.is_some() {
            return self.project(&dir, job);
        }
        ensure!(
            matches!(
                job.stage,
                PluginMigrationStage::Prepared
                    | PluginMigrationStage::OutcomeUnknown
                    | PluginMigrationStage::Capturing
            ),
            "plugin_migration_plan_not_ready"
        );
        self.verify_target_project(&job)?;
        cancelled(cancel)?;
        let checked = self.controlled(&job, cancel)?;
        job.stage = PluginMigrationStage::Capturing;
        job.failure_code = None;
        increment(&mut job)?;
        save(&dir, &job)?;
        let result: Result<()> = (|| {
            // A completed owned copy may have lost only the final capture acknowledgement.
            if let Some(expected) = job.intended.as_ref()
                && job.package_owner.is_some()
            {
                let path = self.package(&job)?;
                if let Ok(found) =
                    migration::package_revision(&path, InstallLimits::default(), &checked)
                    && found == *expected
                {
                    job.pending
                        .retain(|code| code != "plugin_capture_not_complete");
                    job.package = Some(found);
                    job.stage = PluginMigrationStage::Ready;
                    return Ok(());
                }
            }
            let binding = job
                .binding
                .as_ref()
                .context("plugin_migration_source_missing")?
                .clone();
            if let Some(received) = &binding.received {
                return self.capture_received(&dir, &mut job, received, &checked);
            }
            let source = binding.verify()?;
            let temporary =
                kcoder_config::create_private_temp_dir("kcoder-plugin-migration-inspect")?;
            let frozen = temporary.path().join("package");
            PrivateDirectory::open_existing(temporary.path())?
                .create_private_child(OsStr::new("package"))?;
            let revision =
                migration::snapshot_package(&source, &frozen, InstallLimits::default(), &checked)?;
            binding.verify_uploaded_copy(&frozen, &checked)?;
            let inspection = migration::inspect_package(&frozen, &checked)?;
            job.capabilities = inspection.capabilities;
            job.readiness = inspection.readiness;
            job.pending = inspection.pending;
            if !inspection.compatible {
                job.stage = PluginMigrationStage::Pending;
                return Ok(());
            }
            ensure!(
                inspection.name == binding.source_id.parse::<PluginId>()?.plugin_name(),
                "plugin_migration_manifest_identity_changed"
            );
            if let Some(expected) = &job.intended {
                ensure!(*expected == revision, "plugin_migration_source_changed")
            }
            self.reserve(&dir, &mut job, &revision)?;
            ensure!(
                job.attempts < 2,
                "plugin_migration_capture_retry_budget_exceeded"
            );
            job.attempts += 1;
            let relative = format!("package-{}", job.attempts);
            let package = dir.create_private_child(OsStr::new(&relative))?;
            job.package_owner = Some(package.directory_identity()?);
            job.package_relative = Some(relative);
            job.intended = Some(revision.clone());
            save(&dir, &job)?;
            let captured = migration::snapshot_package(
                &frozen,
                &self.package(&job)?,
                InstallLimits::default(),
                &checked,
            )?;
            ensure!(captured == revision, "plugin_migration_source_changed");
            binding.verify()?;
            ensure!(
                migration::package_revision(&source, InstallLimits::default(), &checked)?
                    == revision,
                "plugin_migration_source_changed"
            );
            self.verify_target_project(&job)?;
            cancelled(&checked)?;
            job.package = Some(captured);
            job.stage = PluginMigrationStage::Ready;
            Ok(())
        })();
        if let Err(error) = result {
            job.failure_code = Some(super::super::errors::error_code(&error).into());
            job.stage = match control::read_control(&dir, &job) {
                Ok(control) if control.requested || cancel.is_cancelled() => {
                    PluginMigrationStage::Cancelled
                }
                _ => PluginMigrationStage::OutcomeUnknown,
            };
            if !job
                .pending
                .iter()
                .any(|s| s == "plugin_capture_not_complete")
            {
                job.pending.push("plugin_capture_not_complete".into())
            }
            save(&dir, &job)?;
            return Err(error);
        }
        save(&dir, &job)?;
        self.project(&dir, job)
    }
}
