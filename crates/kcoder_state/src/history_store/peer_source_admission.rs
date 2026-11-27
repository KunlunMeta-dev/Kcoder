//! Positive native history facts for a previously admitted peer operation. These never grant access.
use super::*;
use crate::{AppState, AppStateLifecycleIdentity};
use kcoder_config::PortableLeaseIdentity;
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
#[error("peer_source_history_empty_uncommitted")]
pub struct PeerSourceHistoryEmptyUncommitted {
    metadata_only: bool,
}

/// Serializable facts only. A cold host must additionally own the exact native
/// lease/scope and recheck current configuration, tools and permissions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSourceHistoryReference {
    version: u32,
    thread_id: String,
    history_path: PathBuf,
    parent_identity: String,
    control_identity: String,
    mutation_lock: PortableLeaseIdentity,
    body_file: PortableLeaseIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_session_lease: Option<PortableLeaseIdentity>,
    incarnation: uuid::Uuid,
    body_generation: uuid::Uuid,
    admitted_committed_bytes: u64,
}
impl PeerSourceHistoryReference {
    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }
    pub fn history_path(&self) -> &Path {
        &self.history_path
    }
    pub fn native_session_lease_identity(&self) -> Option<&PortableLeaseIdentity> {
        self.native_session_lease.as_ref()
    }
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.version == 1
                && kcoder_types::cross_session_messages::valid_agent_message_id(&self.thread_id)
                && self.history_path.is_absolute()
                && [&self.parent_identity, &self.control_identity]
                    .into_iter()
                    .all(|value| !value.is_empty()
                        && value.len() <= 4096
                        && !value.chars().any(char::is_control)),
            "peer_source_history_reference_invalid"
        );
        Ok(())
    }
}

/// Non-deserializable proof minted only by a live State's original writer binding.
pub struct PeerSourceAdmissionHistoryWitness {
    state: AppState,
    owner: AppStateLifecycleIdentity,
    source: HistorySource,
    reference: PeerSourceHistoryReference,
}
impl PeerSourceAdmissionHistoryWitness {
    pub fn reference(&self) -> &PeerSourceHistoryReference {
        &self.reference
    }
    pub fn verify_current(&self) -> Result<()> {
        anyhow::ensure!(
            self.owner.try_matches(&self.state) == Some(true),
            "peer_source_admission_owner_changed"
        );
        let inner = self
            .state
            .inner
            .try_read()
            .map_err(|_| anyhow::anyhow!("peer_source_admission_state_busy"))?;
        anyhow::ensure!(
            inner.session_id == self.reference.thread_id
                && inner
                    .history_source
                    .as_ref()
                    .is_some_and(|source| source.shares_binding(&self.source)),
            "peer_source_admission_source_changed"
        );
        drop(inner);
        let binding = self
            .source
            .binding
            .try_lock()
            .map_err(|_| anyhow::anyhow!("peer_source_admission_binding_busy"))?;
        let current = read_reference(&self.source.path, &self.reference.thread_id, Some(&binding))?;
        reference_extends(&current, &self.reference)
    }
}
fn reference_extends(
    current: &PeerSourceHistoryReference,
    admitted: &PeerSourceHistoryReference,
) -> Result<()> {
    admitted.validate()?;
    anyhow::ensure!(
        current.version == admitted.version
            && current.thread_id == admitted.thread_id
            && current.history_path == admitted.history_path
            && current.parent_identity == admitted.parent_identity
            && current.control_identity == admitted.control_identity
            && current.mutation_lock == admitted.mutation_lock
            && current.body_file == admitted.body_file
            && current.native_session_lease == admitted.native_session_lease
            && current.incarnation == admitted.incarnation
            && current.body_generation == admitted.body_generation
            && current.admitted_committed_bytes >= admitted.admitted_committed_bytes,
        "peer_source_admission_history_changed"
    );
    Ok(())
}
fn read_reference(
    path: &Path,
    thread_id: &str,
    binding: Option<&SourceBinding>,
) -> Result<PeerSourceHistoryReference> {
    let (directory, name) = open_parent_with_create(path, false)?;
    directory.verify_trusted_config_directory()?;
    let control_name = source_directory_name(&name)?;
    let control = match directory.open_child(&control_name, false) {
        Ok(control) => control,
        Err(error) if missing(&error) => match directory.open_single_link_regular_file(&name) {
            Err(error) if missing(&error) => {
                return Err(PeerSourceHistoryEmptyUncommitted {
                    metadata_only: false,
                }
                .into());
            }
            _ => anyhow::bail!("peer_source_history_has_no_native_control"),
        },
        Err(error) => return Err(error),
    };
    control.verify_trusted_config_directory()?;
    let lock = directory.open_single_link_regular_file(OsStr::new(MUTATION_LOCK))?;
    FileExt::try_lock_shared(&lock).context("peer_source_history_writer_busy")?;
    let lock = PrivateFileLock::from_locked(lock);
    let record =
        read_source_record(&directory, &name)?.context("peer_source_history_control_missing")?;
    if let Some(binding) = binding {
        binding.verify(Some(&record))?;
    }
    anyhow::ensure!(!record.deleted, "peer_source_history_deleted");
    let commit = record
        .commit
        .as_ref()
        .context("peer_source_history_committed_boundary_unknown")?;
    commit.check_ready()?;
    let bytes = match commit.committed_bytes {
        Some(bytes) => bytes,
        None => match directory.open_single_link_regular_file(&name) {
            Err(error) if missing(&error) => {
                return Err(PeerSourceHistoryEmptyUncommitted {
                    metadata_only: true,
                }
                .into());
            }
            _ => anyhow::bail!("peer_source_history_committed_boundary_unknown"),
        },
    };
    let body = directory.open_single_link_regular_file(&name)?;
    anyhow::ensure!(
        body.metadata()?.len() == bytes,
        "peer_source_history_body_boundary_changed"
    );
    let parent_identity = directory.directory_identity()?;
    let control_identity = control.directory_identity()?;
    let lease_name = Path::new(&name).with_extension("lease").into_os_string();
    let native_lease = match directory.open_single_link_regular_file(&lease_name) {
        Ok(file) => Some(file),
        Err(error) if missing(&error) => None,
        Err(error) => return Err(error),
    };
    let native_session_lease = native_lease
        .as_ref()
        .map(|file| directory.portable_regular_handle_identity(file))
        .transpose()?;
    let canonical_parent = dunce::canonicalize(
        path.parent()
            .context("peer_source_history_parent_missing")?,
    )?;
    let reference = PeerSourceHistoryReference {
        version: 1,
        thread_id: thread_id.into(),
        history_path: canonical_parent.join(&name),
        parent_identity,
        control_identity,
        mutation_lock: directory.portable_regular_handle_identity(&lock)?,
        body_file: directory.portable_regular_handle_identity(&body)?,
        native_session_lease,
        incarnation: record.incarnation,
        body_generation: commit.generation,
        admitted_committed_bytes: bytes,
    };
    reference.validate()?;
    anyhow::ensure!(
        PrivateDirectory::open_existing(&canonical_parent)?.directory_identity()?
            == reference.parent_identity
            && directory
                .open_child(&control_name, false)?
                .directory_identity()?
                == reference.control_identity
            && directory.portable_regular_identity(OsStr::new(MUTATION_LOCK))?
                == reference.mutation_lock
            && directory.portable_regular_identity(&name)? == reference.body_file
            && match &reference.native_session_lease {
                Some(identity) => directory.portable_regular_identity(&lease_name)? == *identity,
                None =>
                    matches!(directory.open_single_link_regular_file(&lease_name),Err(error) if missing(&error)),
            }
            && read_source_record(&directory, &name)?.as_ref() == Some(&record),
        "peer_source_history_observation_changed"
    );
    Ok(reference)
}

/// Read-only native control/file verification. No lock, directory, body or
/// control is initialized or repaired, and no history body hash is computed.
pub fn verify_peer_source_history_reference(
    path: &Path,
    reference: &PeerSourceHistoryReference,
) -> Result<()> {
    reference.validate()?;
    let current = read_reference(path, &reference.thread_id, None)?;
    reference_extends(&current, reference)
}
impl AppState {
    pub fn peer_source_admission_history(
        &self,
        owner: &AppStateLifecycleIdentity,
    ) -> Result<PeerSourceAdmissionHistoryWitness> {
        let (source, thread_id, empty) = {
            let inner = self
                .inner
                .try_read()
                .map_err(|_| anyhow::anyhow!("peer_source_admission_state_busy"))?;
            anyhow::ensure!(
                owner.matches_locked(self, &inner) && inner.history_write_fault.is_none(),
                "peer_source_admission_owner_changed"
            );
            (
                inner
                    .history_source
                    .clone()
                    .context("peer_source_admission_history_unbound")?,
                inner.session_id.clone(),
                !inner.conversation_started && inner.messages.is_empty(),
            )
        };
        let binding = source
            .binding
            .try_lock()
            .map_err(|_| anyhow::anyhow!("peer_source_admission_binding_busy"))?;
        let reference = match read_reference(&source.path, &thread_id, Some(&binding)) {
            Ok(reference) => reference,
            Err(error)
                if error
                    .downcast_ref::<PeerSourceHistoryEmptyUncommitted>()
                    .is_some_and(|unsupported| {
                        !empty || (binding.initialized && !unsupported.metadata_only)
                    }) =>
            {
                anyhow::bail!("peer_source_admission_original_history_missing")
            }
            Err(error) => return Err(error),
        };
        drop(binding);
        let witness = PeerSourceAdmissionHistoryWitness {
            state: self.clone(),
            owner: owner.clone(),
            source,
            reference,
        };
        witness.verify_current()?;
        Ok(witness)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn original_native_facts_are_read_only_and_survive_append_and_real_compaction() {
        let root = kcoder_config::create_private_temp_dir("peer-source-history-facts").unwrap();
        let state = AppState::new(root.path());
        let path = root.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state.add_message(kcoder_types::Message::user_text("Original source task"));
        state.flush_history().await.unwrap();
        let owner = state.inspection_lifecycle_identity();
        let witness = state.peer_source_admission_history(&owner).unwrap();
        let reference = witness.reference().clone();
        let control = path.with_extension("hctl").join(SOURCE_RECORD_FILE);
        let before = (
            fs::read(&path).unwrap(),
            fs::read(&control).unwrap(),
            fs::read(root.path().join(MUTATION_LOCK)).unwrap(),
        );
        for _ in 0..5 {
            witness.verify_current().unwrap();
            verify_peer_source_history_reference(&path, &reference).unwrap();
        }
        assert_eq!(
            before,
            (
                fs::read(&path).unwrap(),
                fs::read(&control).unwrap(),
                fs::read(root.path().join(MUTATION_LOCK)).unwrap()
            ),
            "warm facts never rewrite source bytes or controls"
        );
        state.add_message(kcoder_types::Message::assistant_text(
            "A normal later append",
        ));
        state.flush_history().await.unwrap();
        verify_peer_source_history_reference(&path, &reference).unwrap();
        state
            .set_messages_after_compaction(
                vec![kcoder_types::Message::compaction_text(
                    "A real compact summary",
                )],
                crate::CompactionTranscriptEvent {
                    trigger: crate::CompactionTrigger::Manual,
                    pre_tokens: 1000,
                    post_tokens: 10,
                    summary: "A real compact summary".into(),
                },
            )
            .await
            .unwrap();
        witness.verify_current().unwrap();
        verify_peer_source_history_reference(&path, &reference).unwrap();
        let source = state.read_inner().history_source.clone().unwrap();
        source.replace(b"replacement generation\n").unwrap();
        assert!(verify_peer_source_history_reference(&path, &reference).is_err());
        assert!(witness.verify_current().is_err());
    }
    #[tokio::test]
    async fn empty_missing_corrupt_control_and_replaced_physical_history_never_mint_facts() {
        let root = kcoder_config::create_private_temp_dir("peer-source-history-negative").unwrap();
        let state = AppState::new(root.path());
        let path = root.path().join(format!("{}.jsonl", state.session_id()));
        state.with_deferred_history_path(&path);
        let error = state
            .peer_source_admission_history(&state.inspection_lifecycle_identity())
            .err()
            .unwrap();
        assert!(
            error
                .downcast_ref::<PeerSourceHistoryEmptyUncommitted>()
                .is_some()
        );
        assert!(!path.exists() && !path.with_extension("hctl").exists());
        state.add_message(kcoder_types::Message::user_text("Native source body"));
        state.flush_history().await.unwrap();
        let witness = state
            .peer_source_admission_history(&state.inspection_lifecycle_identity())
            .unwrap();
        let reference = witness.reference().clone();
        let contents = fs::read(&path).unwrap();
        fs::rename(&path, root.path().join("original-held.jsonl")).unwrap();
        fs::write(&path, &contents).unwrap();
        assert!(
            verify_peer_source_history_reference(&path, &reference).is_err(),
            "same bytes under the same name are not the original file"
        );
        let control = path.with_extension("hctl").join(SOURCE_RECORD_FILE);
        fs::write(&control, b"{").unwrap();
        assert!(
            state
                .peer_source_admission_history(&state.inspection_lifecycle_identity())
                .is_err()
        );
        assert_eq!(
            fs::read(&control).unwrap(),
            b"{",
            "bad native controls are never repaired by observation"
        );
    }
    #[tokio::test]
    async fn original_native_session_lock_leaf_cannot_be_replaced_or_silently_added() {
        let root = kcoder_config::create_private_temp_dir("peer-source-lease-facts").unwrap();
        let state = AppState::new(root.path());
        let path = root.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state.add_message(kcoder_types::Message::user_text("Known original body"));
        state.flush_history().await.unwrap();
        let without = state
            .peer_source_admission_history(&state.inspection_lifecycle_identity())
            .unwrap();
        assert!(
            without
                .reference()
                .native_session_lease_identity()
                .is_none()
        );
        let parent = PrivateDirectory::open_existing(root.path()).unwrap();
        let lease = path.with_extension("lease");
        parent
            .open_read_write_file(lease.file_name().unwrap(), true)
            .unwrap();
        assert!(without.verify_current().is_err());
        let original = state
            .peer_source_admission_history(&state.inspection_lifecycle_identity())
            .unwrap();
        assert!(
            original
                .reference()
                .native_session_lease_identity()
                .is_some()
        );
        fs::rename(&lease, root.path().join("original.lease")).unwrap();
        parent
            .open_read_write_file(lease.file_name().unwrap(), true)
            .unwrap();
        assert!(original.verify_current().is_err());
        fs::remove_file(&lease).unwrap();
        assert!(verify_peer_source_history_reference(&path, original.reference()).is_err());
        assert!(!lease.exists());
    }
}
