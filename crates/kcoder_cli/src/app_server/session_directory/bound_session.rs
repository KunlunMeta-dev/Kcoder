//! Actual held history facts. Neither this descriptor nor its metadata is an access grant.
use super::*;
use kcoder_config::PortableLeaseIdentity;
use std::fs::File;
pub(crate) mod cold_target;

/// The same metadata roots are fenced for live, unmaterialized and cold targets.
pub(crate) struct AdmissionMetadata {
    scope: Arc<DirectoryScope>,
    id: String,
    _locks: Vec<File>,
}
impl AdmissionMetadata {
    pub(crate) fn verify(
        &self,
        view: &DirectorySourceView<'_>,
    ) -> Result<Option<kcoder_thread_metadata::ThreadClientMetadata>> {
        self.scope.verify_view(view)?;
        let metadata = observation::client_metadata(&self.scope, &self.id)?;
        self.scope.verify_view(view)?;
        Ok(metadata)
    }
}
impl SessionDirectory {
    pub(crate) fn lock_admission_metadata(
        view: &DirectorySourceView<'_>,
        id: &str,
    ) -> Result<AdmissionMetadata> {
        let scope = Arc::new(DirectoryScope::capture_view(view)?);
        ensure!(scope.incomplete == 0, "session_directory_lookup_incomplete");
        let mut roots = scope.artifacts.iter().collect::<Vec<_>>();
        roots.sort_by(|a, b| a.path.cmp(&b.path));
        let mut locks = Vec::new();
        for root in roots {
            root.verify()?;
            locks.extend(
                kcoder_thread_metadata::try_acquire_thread_lifecycle_locks_at_root(
                    &root.path,
                    &[id],
                )?,
            );
            root.verify()?;
        }
        scope.verify_view(view)?;
        Ok(AdmissionMetadata {
            scope,
            id: id.to_owned(),
            _locks: locks,
        })
    }
}

pub(crate) struct BoundPeerSession {
    scope: Arc<DirectoryScope>,
    candidate: Candidate,
    history: File,
    identity: PortableLeaseIdentity,
    pub(super) row: AgentMessageTarget,
}
impl BoundPeerSession {
    pub(super) fn capture(
        scope: Arc<DirectoryScope>,
        candidate: Candidate,
        row: AgentMessageTarget,
    ) -> Result<Self> {
        let parent = candidate.parent()?;
        let history =
            parent.open_single_link_regular_file(OsStr::new(&format!("{}.jsonl", candidate.id)))?;
        let identity = PortableLeaseIdentity::from_regular_handle(&history)?;
        Ok(Self {
            scope,
            candidate,
            history,
            identity,
            row,
        })
    }
    pub(crate) fn verify(&self, view: &DirectorySourceView<'_>) -> Result<()> {
        self.scope.verify_view(view)?;
        let parent = self.candidate.parent()?;
        self.candidate.verify_parent(&parent)?;
        let current = parent
            .open_single_link_regular_file(OsStr::new(&format!("{}.jsonl", self.candidate.id)))?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(&current)? == self.identity
                && PortableLeaseIdentity::from_regular_handle(&self.history)? == self.identity,
            "peer_source_history_replaced"
        );
        Ok(())
    }
    pub(crate) fn history_path(&self) -> PathBuf {
        self.candidate.path()
    }
    /// A passive read lease never restores or becomes the target's writer owner.
    pub(crate) fn admission_read_lease(
        &self,
        view: &DirectorySourceView<'_>,
    ) -> Result<Option<File>> {
        self.verify(view)?;
        let parent = self.candidate.parent()?;
        let file = match parent
            .open_single_link_regular_file(OsStr::new(&format!("{}.lease", self.candidate.id)))
        {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        fs2::FileExt::try_lock_shared(&file)?;
        self.verify(view)?;
        Ok(Some(file))
    }
    pub(crate) fn verify_admission_read_lease(
        &self,
        view: &DirectorySourceView<'_>,
        held: &File,
    ) -> Result<()> {
        self.verify(view)?;
        let parent = self.candidate.parent()?;
        let current = parent
            .open_single_link_regular_file(OsStr::new(&format!("{}.lease", self.candidate.id)))?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(held)?
                == PortableLeaseIdentity::from_regular_handle(&current)?,
            "peer_message_target_lease_changed"
        );
        self.verify(view)
    }
    pub(crate) fn metadata(
        &self,
        view: &DirectorySourceView<'_>,
    ) -> Result<kcoder_state::PreparedSessionMetadata> {
        self.verify(view)?;
        let parent = self.candidate.parent()?;
        let result = observation::metadata(&self.candidate, &parent)?;
        self.verify(view)?;
        Ok(result)
    }
    pub(crate) fn client_metadata(
        &self,
        view: &DirectorySourceView<'_>,
    ) -> Result<Option<kcoder_thread_metadata::ThreadClientMetadata>> {
        self.verify(view)?;
        let result = observation::client_metadata(&self.scope, &self.candidate.id)?;
        self.verify(view)?;
        Ok(result)
    }
    pub(crate) fn observation(&self) -> &AgentMessageTarget {
        &self.row
    }
}
