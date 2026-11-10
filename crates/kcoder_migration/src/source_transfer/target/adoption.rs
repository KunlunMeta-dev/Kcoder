//! A distinct receiving scan owns its original selectors, preview IDs and cancellation domain.
use super::*;
use kcoder_config::VerifiedPrivateLease;
use std::collections::BTreeMap;
#[cfg(test)]
thread_local! {
    pub(crate) static FAIL_AFTER_PREVIEW_PUBLICATION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(crate) static AFTER_ADOPTION_CHECKPOINT_READ: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
mod instructions;
mod model;
mod plugins;
mod worker;
pub use instructions::ReceivedInstructionAdoptionMapping;
use model::*;
pub use model::{
    ReceivedAdoptionControl, ReceivedAdoptionJob, ReceivedAdoptionPhase, ReceivedAdoptionScope,
    ReceivedAdoptionSelection, ReceivedAdoptionState, ReceivedAdoptionWorkerState,
    ReceivedProjectMapping,
};

pub struct ReceivedAdoptionLease {
    directory: PrivateDirectory,
    _guard: VerifiedPrivateLease,
    intent: Intent,
}
impl ReceivedAdoptionLease {
    fn verify(&self) -> Result<()> {
        ensure!(
            self.directory
                .portable_regular_handle_identity(self._guard.file())?
                == *self._guard.identity()
                && self
                    .directory
                    .portable_regular_identity(OsStr::new("writer.lock"))?
                    == *self._guard.identity(),
            "source_transfer_adoption_unknown"
        );
        Ok(())
    }
}
impl IncomingTransfers {
    fn adoption_name(request: &str, adoption: &str) -> String {
        format!("adoption-{request}-{adoption}")
    }
    fn adoption_directory(
        &self,
        request: &str,
        adoption: &str,
    ) -> Result<Option<PrivateDirectory>> {
        valid_uuid(adoption)?;
        let (root, _, grant) = self.grant(request)?;
        let child = Self::adoption_name(request, adoption);
        let Some(anchor) = grant.adoptions.get(adoption) else {
            return match root.open_child(OsStr::new(&child), false) {
                Err(error) if missing(&error) => Ok(None),
                _ => anyhow::bail!("source_transfer_adoption_unknown"),
            };
        };
        let expected = anchor
            .as_ref()
            .context("source_transfer_adoption_unknown")?;
        let directory = root.open_child(OsStr::new(&child), false)?;
        directory.verify_private_directory()?;
        let anchor: Anchor =
            load(&directory, "binding.json")?.context("source_transfer_adoption_unknown")?;
        ensure!(
            anchor == *expected
                && anchor.owner == self.store.identity
                && anchor.directory == directory.directory_identity()?
                && anchor.request == request,
            "source_transfer_adoption_unknown"
        );
        let journal = Self::adoption_journal(&directory)?;
        ensure!(
            journal.intent.request == request
                && journal.intent.adoption == adoption
                && journal.intent.profile_identity == self.store.identity
                && journal.intent.target == self.store.authority
                && anchor.binding == digest(&journal.intent)?,
            "source_transfer_adoption_unknown"
        );
        control(&directory)?;
        drop(try_operation_lease(&directory, "writer.lock")?);
        drop(try_operation_lease(&directory, "control.lock")?);
        Ok(Some(directory))
    }
    fn adoption_journal(directory: &PrivateDirectory) -> Result<Journal> {
        let journal: Journal =
            load(directory, "adoption.json")?.context("source_transfer_adoption_unknown")?;
        ensure!(
            journal.version == 1
                && !journal.intent.groups.is_empty()
                && journal.intent.groups.len() <= 4
                && journal.intent.selections.len() <= 64
                && !journal.intent.selections.is_empty()
                && journal.publications.len() == journal.intent.groups.len()
                && journal.published.len() == journal.intent.groups.len()
                && journal.completed_sources as usize <= journal.intent.selections.len(),
            "source_transfer_adoption_unknown"
        );
        valid_uuid(&journal.intent.request)?;
        valid_uuid(&journal.intent.adoption)?;
        instructions::validate(&journal.intent.instruction_mappings)?;
        ensure!(
            journal
                .intent
                .instruction_mappings
                .iter()
                .all(|mapping| journal
                    .intent
                    .selections
                    .iter()
                    .any(|selection| selection.entry_id == mapping.entry_id))
                && (journal.intent.instruction_mappings.is_empty()
                    || journal.intent.project.is_some()),
            "source_transfer_adoption_unknown"
        );
        let selected = journal
            .intent
            .selections
            .iter()
            .map(|entry| entry.entry_id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let grouped = journal
            .intent
            .groups
            .iter()
            .flat_map(|group| group.entries.iter().map(String::as_str))
            .collect::<Vec<_>>();
        ensure!(
            selected.len() == journal.intent.selections.len()
                && grouped.len() == selected.len()
                && grouped
                    .into_iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    == selected
                && journal
                    .published
                    .iter()
                    .zip(&journal.publications)
                    .all(|(published, publication)| !published || publication.is_some())
                && journal
                    .publications
                    .iter()
                    .flatten()
                    .all(|publication| valid_sha(&publication.sha256))
                && (journal.phase != ReceivedAdoptionPhase::PreviewReady
                    || journal.published.iter().all(|published| *published)
                        && journal.completed_sources as usize == selected.len()),
            "source_transfer_adoption_unknown"
        );
        Ok(journal)
    }
    pub fn read_adoption(
        &self,
        request: &str,
        adoption: &str,
    ) -> Result<Option<ReceivedAdoptionState>> {
        valid_uuid(adoption)?;
        let (_, _, grant) = self.grant(request)?;
        let known = grant.adoptions.contains_key(adoption);
        let result = (|| {
            let Some(directory) = self.adoption_directory(request, adoption)? else {
                return Ok(None);
            };
            Ok(Some(self.adoption_state(&directory)?))
        })();
        match result {
            Ok(value) => Ok(value),
            Err(_) if known => Ok(Some(ReceivedAdoptionState {
                adoption_id: adoption.into(),
                request_id: request.into(),
                phase: ReceivedAdoptionPhase::Unknown,
                worker_state: ReceivedAdoptionWorkerState::Unknown,
                control: None,
                cancel_requested: None,
                jobs: Vec::new(),
                total_sources: 0,
                completed_sources: 0,
                blocked_items: 0,
                error_code: Some("source_transfer_adoption_unknown".into()),
            })),
            Err(error) => Err(error),
        }
    }
    fn adoption_state(&self, directory: &PrivateDirectory) -> Result<ReceivedAdoptionState> {
        // A free writer lease pins a stopped observation. If a short worker
        // releases between checkpoint reads, reread under that real lease;
        // never combine an old Prepared checkpoint with a new stopped fact.
        let mut stopped = try_operation_lease(directory, "writer.lock")?;
        let mut journal = Self::adoption_journal(directory)?;
        #[cfg(test)]
        if let Some(after_read) =
            AFTER_ADOPTION_CHECKPOINT_READ.with(|slot| slot.borrow_mut().take())
        {
            after_read();
        }
        if stopped.is_none() {
            stopped = try_operation_lease(directory, "writer.lock")?;
            if stopped.is_some() {
                journal = Self::adoption_journal(directory)?;
            }
        }
        let running = stopped.is_none();
        let control = control(directory)?.state(false);
        let mut phase = journal.phase;
        if control.cancelled {
            phase = if running {
                ReceivedAdoptionPhase::CancelRequested
            } else {
                ReceivedAdoptionPhase::Cancelled
            };
        } else if !running && phase == ReceivedAdoptionPhase::Scanning {
            phase = ReceivedAdoptionPhase::Interrupted;
        }
        let store = crate::store::MigrationStore::open_existing(&self.store.profile)?;
        let mut jobs = Vec::new();
        for (index, group) in journal.intent.groups.iter().enumerate() {
            let mut ready = false;
            if journal.publications[index].is_some() {
                match store.verify_received_batch(&group.job_id, &journal.intent.proof(index)?) {
                    Ok(job) => {
                        if !journal.published[index] {
                            let identity = PrivateDirectory::open_existing(&self.store.profile)?
                                .open_child(OsStr::new("migrations"), false)?;
                            let expected = journal.publications[index].as_ref().unwrap();
                            ensure!(
                                job.sequence == 1
                                    && digest(&job)? == expected.sha256
                                    && identity.portable_regular_identity(OsStr::new(&format!(
                                        "{}.json",
                                        group.job_id
                                    )))? == expected.identity,
                                "source_transfer_adoption_unknown"
                            );
                        }
                        ready = true;
                    }
                    Err(_) => {
                        phase = ReceivedAdoptionPhase::Unknown;
                    }
                }
            }
            jobs.push(ReceivedAdoptionJob {
                source: group.source,
                job_id: group.job_id.clone(),
                target_scope: if group.project {
                    ReceivedAdoptionScope::CurrentWorkspace
                } else {
                    ReceivedAdoptionScope::User
                },
                preview_ready: ready,
            });
        }
        Ok(ReceivedAdoptionState {
            adoption_id: journal.intent.adoption,
            request_id: journal.intent.request,
            phase,
            worker_state: if running {
                ReceivedAdoptionWorkerState::Running
            } else {
                ReceivedAdoptionWorkerState::Stopped
            },
            control: Some(ReceivedAdoptionControl {
                sequence: control.sequence,
                cancel_watermark: control.cancel_watermark,
            }),
            cancel_requested: Some(control.cancelled),
            jobs,
            total_sources: journal.intent.selections.len() as u32,
            completed_sources: journal.completed_sources,
            blocked_items: journal.blocked_items,
            error_code: if phase == ReceivedAdoptionPhase::Unknown {
                Some("source_transfer_adoption_unknown".into())
            } else {
                journal.error_code
            },
        })
    }
    pub fn prepare_adoption(
        &self,
        request: &str,
        adoption: &str,
        manifest_sha256: &str,
        selections: Vec<ReceivedAdoptionSelection>,
        project: Option<ReceivedProjectTarget>,
    ) -> Result<(ReceivedAdoptionState, Option<ReceivedAdoptionLease>)> {
        self.prepare_adoption_with_instructions(
            request,
            adoption,
            manifest_sha256,
            selections,
            project,
            Vec::new(),
        )
    }
    pub fn prepare_adoption_with_instructions(
        &self,
        request: &str,
        adoption: &str,
        manifest_sha256: &str,
        mut selections: Vec<ReceivedAdoptionSelection>,
        project: Option<ReceivedProjectTarget>,
        instruction_mappings: Vec<ReceivedInstructionAdoptionMapping>,
    ) -> Result<(ReceivedAdoptionState, Option<ReceivedAdoptionLease>)> {
        valid_uuid(adoption)?;
        let instruction_mappings = instructions::canonical(instruction_mappings)?;
        ensure!(
            !selections.is_empty() && selections.len() <= 64,
            "source_transfer_adoption_selection_limit"
        );
        selections.sort_by(|a, b| a.entry_id.cmp(&b.entry_id));
        ensure!(
            selections
                .windows(2)
                .all(|w| w[0].entry_id != w[1].entry_id),
            "source_transfer_adoption_duplicate_selection"
        );
        let (root, name, _) = self.grant(request)?;
        let _grant_lock = lease(&root, "grants.lock")?;
        if let Some(directory) = self.adoption_directory(request, adoption)? {
            let journal = Self::adoption_journal(&directory)?;
            ensure!(
                journal.intent.receipt.manifest_sha256 == manifest_sha256
                    && journal.intent.selections == selections
                    && journal.intent.project == project
                    && journal.intent.instruction_mappings == instruction_mappings,
                "source_transfer_adoption_binding_changed"
            );
            return Ok((self.adoption_state(&directory)?, None));
        }
        self.validate_instruction_intent(
            request,
            manifest_sha256,
            &selections,
            project.as_ref(),
            &instruction_mappings,
        )?;
        let mut groups: BTreeMap<(u8, bool), Group> = BTreeMap::new();
        let mut receipt = None;
        let mut project_needed = false;
        for selection in &selections {
            let selected = self.received_binding(request, manifest_sha256, &selection.entry_id)?;
            receipt = Some(selected.receipt().clone());
            let (source, mapped_project) = match &selected.entry().content {
                TransferContent::ProjectInventory { source, .. } => (*source, false),
                TransferContent::InstructionBundle { source, .. } => {
                    ensure!(
                        instruction_mappings
                            .iter()
                            .any(|mapping| mapping.entry_id == selection.entry_id),
                        "source_transfer_scoped_instructions_update_required"
                    );
                    (*source, true)
                }
                TransferContent::ConfigurationInventory {
                    source,
                    source_scope,
                    ..
                } => (*source, configuration_project_scoped(source_scope)),
                TransferContent::WorkAsset { source, scope, .. } => (
                    *source,
                    matches!(
                        scope,
                        kcoder_config::imported_context::ImportedContextScope::Project { .. }
                    ),
                ),
                TransferContent::History { snapshot, .. } => (snapshot.origin.source, false),
                TransferContent::PluginPackage { origin, .. } => (
                    origin.source,
                    matches!(origin.scope.as_str(), "project" | "local"),
                ),
            };
            ensure!(
                mapped_project == selection.project_mapping.is_some(),
                "source_transfer_project_mapping_required"
            );
            project_needed |= mapped_project;
            let settings_project = mapped_project
                && matches!(
                    selected.entry().content,
                    TransferContent::ConfigurationInventory { .. }
                        | TransferContent::PluginPackage { .. }
                );
            let kind = if source == kcoder_types::migration::MigrationSourceKind::ClaudeCode {
                0
            } else {
                1
            };
            groups
                .entry((kind, settings_project))
                .or_insert_with(|| Group {
                    source,
                    project: settings_project,
                    entries: Vec::new(),
                    job_id: format!("mig-{}", uuid::Uuid::new_v4().simple()),
                })
                .entries
                .push(selection.entry_id.clone());
        }
        ensure!(
            project_needed == project.is_some(),
            "source_transfer_project_mapping_required"
        );
        if let Some(project) = &project {
            project.verify(&self.store.profile)?;
        }
        let intent = Intent {
            request: request.into(),
            adoption: adoption.into(),
            receipt: receipt.context("source_transfer_not_ready")?,
            selections,
            instruction_mappings,
            project,
            profile: self.store.profile.clone(),
            profile_identity: self.store.identity.clone(),
            target: self.store.authority.clone(),
            groups: groups.into_values().collect(),
        };
        crate::instruction_sources::portable::bounded_encode(
            &intent,
            super::super::model::MAX_METADATA_BYTES as usize,
        )?;
        let (_, _, mut grant) = self.grant(request)?;
        ensure!(
            grant.adoptions.len() < 256,
            "source_transfer_adoption_limit"
        );
        let mut stored_adoptions = 0usize;
        root.visit_entry_names_bounded(4096, |entry| {
            if entry
                .to_str()
                .is_some_and(|name| name.starts_with("adoption-"))
            {
                stored_adoptions += 1;
            }
            Ok(())
        })?;
        ensure!(stored_adoptions < 256, "source_transfer_adoption_limit");
        grant.adoptions.insert(adoption.into(), None);
        save(&root, &name, &grant)?;
        let directory =
            root.create_private_child(OsStr::new(&Self::adoption_name(request, adoption)))?;
        let writer = lease(&directory, "writer.lock")?;
        let controller = lease(&directory, "control.lock")?;
        let anchor = Anchor {
            owner: self.store.identity.clone(),
            directory: directory.directory_identity()?,
            request: request.into(),
            binding: digest(&intent)?,
            writer: directory.portable_regular_identity(OsStr::new("writer.lock"))?,
            controller: directory.portable_regular_identity(OsStr::new("control.lock"))?,
        };
        exact(&directory, "binding.json", &anchor)?;
        exact(&directory, "control.json", &Control::default())?;
        let count = intent.groups.len();
        let journal = Journal {
            version: 1,
            intent: intent.clone(),
            phase: ReceivedAdoptionPhase::Prepared,
            completed_sources: 0,
            blocked_items: 0,
            error_code: None,
            publications: vec![None; count],
            published: vec![false; count],
        };
        save(&directory, "adoption.json", &journal)?;
        grant.adoptions.insert(adoption.into(), Some(anchor));
        save(&root, &name, &grant)?;
        drop(controller);
        drop(writer);
        let owner = operation_lease(&directory, "writer.lock")?;
        let state = self.adoption_state(&directory)?;
        Ok((
            state,
            Some(ReceivedAdoptionLease {
                directory,
                _guard: owner,
                intent,
            }),
        ))
    }
    pub fn adoption_project(
        &self,
        request: &str,
        adoption: &str,
    ) -> Result<Option<ReceivedProjectTarget>> {
        let directory = self
            .adoption_directory(request, adoption)?
            .context("source_transfer_adoption_untracked")?;
        Ok(Self::adoption_journal(&directory)?.intent.project)
    }
    pub fn cancel_adoption(
        &self,
        request: &str,
        adoption: &str,
        command: &str,
    ) -> Result<ReceivedAdoptionState> {
        let directory = self
            .adoption_directory(request, adoption)?
            .context("source_transfer_adoption_untracked")?;
        cancel(&directory, command)?;
        self.adoption_state(&directory)
    }
    pub fn resume_adoption(
        &self,
        request: &str,
        adoption: &str,
        expected: ReceivedAdoptionControl,
    ) -> Result<(ReceivedAdoptionState, ReceivedAdoptionLease)> {
        let directory = self
            .adoption_directory(request, adoption)?
            .context("source_transfer_adoption_untracked")?;
        let owner = operation_lease(&directory, "writer.lock")?;
        ensure!(
            self.adoption_state(&directory)?.phase != ReceivedAdoptionPhase::Unknown,
            "source_transfer_adoption_unknown"
        );
        let _controller = operation_lease(&directory, "control.lock")?;
        let mut control = control(&directory)?;
        ensure!(
            control.sequence == expected.sequence && control.cancelled == expected.cancel_watermark,
            "source_transfer_revision_conflict"
        );
        let mut journal = Self::adoption_journal(&directory)?;
        ensure!(
            journal.phase != ReceivedAdoptionPhase::Unknown,
            "source_transfer_adoption_unknown"
        );
        control.sequence = control
            .sequence
            .checked_add(1)
            .context("source_transfer_revision_exhausted")?;
        control.acknowledged = control.cancelled;
        save(&directory, "control.json", &control)?;
        journal.phase = ReceivedAdoptionPhase::Prepared;
        journal.error_code = None;
        save(&directory, "adoption.json", &journal)?;
        drop(_controller);
        let state = self.adoption_state(&directory)?;
        Ok((
            state,
            ReceivedAdoptionLease {
                directory,
                _guard: owner,
                intent: journal.intent,
            },
        ))
    }
}
