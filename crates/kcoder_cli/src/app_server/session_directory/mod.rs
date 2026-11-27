//! Target-side, read-only directory facts. These values never grant peer access or execution.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{ThreadStatus, cross_session_messages::*};
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_state::{AppState, AppStateLifecycleIdentity};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

mod bound_session;
mod observation;
mod read_lookup;
pub(crate) use bound_session::cold_target;
pub(crate) use bound_session::{AdmissionMetadata, BoundPeerSession};
pub(crate) use observation::client_metadata_in;
#[cfg(test)]
pub(crate) use observation::take_observation_counts;
pub(crate) use read_lookup::ReadLookup;

const MAX_ENTRIES: usize = 16_384;
const MAX_DIRECTORY_ENTRIES: usize = 65_536;
const MAX_ROOTS: usize = 8;
const MAX_PAGES: usize = 32;
const MAX_EXAMINED_PER_PAGE: usize = 128;
const QUERY_SCAN_BUDGET: Duration = Duration::from_secs(2);
const MATCHED_PAGE_BYTES: usize = 96 * 1024;
const CURSOR_TTL: Duration = Duration::from_secs(120);
pub(crate) const MAX_STATUS_ATTEMPTS: usize = 256;
pub(crate) const MAX_STATUS_ATTEMPT_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
enum DirectoryBinding {
    State(AppStateLifecycleIdentity),
    Host(String),
}
impl DirectoryBinding {
    fn matches(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::State(a), Self::State(b)) => a.same_lifecycle(b),
            (Self::Host(a), Self::Host(b)) => a == b,
            _ => false,
        }
    }
}
enum DirectoryValidation<'a> {
    State(&'a AppState, &'a AppStateLifecycleIdentity),
    Host(&'a (dyn Fn() -> Result<()> + Send + Sync)),
}
/// Read context captured by a real host, never deserialized from peer selectors.
/// Authorization is rechecked independently; paths and titles are not grants.
pub(crate) struct DirectorySourceView<'a> {
    workspace: PathBuf,
    storage: PathBuf,
    history_directory: Option<PathBuf>,
    history_file: Option<PathBuf>,
    source_id: Option<String>,
    binding: DirectoryBinding,
    validation: DirectoryValidation<'a>,
}
impl<'a> DirectorySourceView<'a> {
    pub(crate) fn from_state(
        state: &'a AppState,
        lifecycle: &'a AppStateLifecycleIdentity,
        storage: &Path,
    ) -> Self {
        let history_file = state.history_path();
        Self {
            workspace: state.cwd(),
            storage: storage.to_owned(),
            history_directory: history_file
                .as_deref()
                .and_then(Path::parent)
                .map(Path::to_owned),
            history_file,
            source_id: Some(state.session_id()),
            binding: DirectoryBinding::State(lifecycle.clone()),
            validation: DirectoryValidation::State(state, lifecycle),
        }
    }
    /// The trusted private-route owner supplies actual destination factory roots
    /// and a binding to its authenticated source/address/authorization generation.
    /// The bootstrap State is deliberately absent and cannot become a source grant.
    pub(crate) fn from_host(
        workspace: &Path,
        storage: &Path,
        history_directory: Option<&Path>,
        binding: &str,
        verify: &'a (dyn Fn() -> Result<()> + Send + Sync),
    ) -> Result<Self> {
        ensure!(
            !binding.is_empty() && binding.len() <= 4096 && !binding.chars().any(char::is_control),
            "session_directory_host_binding_invalid"
        );
        verify()?;
        Ok(Self {
            workspace: workspace.to_owned(),
            storage: storage.to_owned(),
            history_directory: history_directory.map(Path::to_owned),
            history_file: None,
            // Remote source IDs can equal a local peer ID. Only the outer host,
            // after comparing complete addresses, may add a self exclusion.
            source_id: None,
            binding: DirectoryBinding::Host(binding.to_owned()),
            validation: DirectoryValidation::Host(verify),
        })
    }
    pub(crate) fn verify(&self) -> Result<()> {
        match &self.validation {
            DirectoryValidation::State(state, lifecycle) => ensure!(
                lifecycle.try_matches(state) == Some(true)
                    && state.cwd() == self.workspace
                    && state.history_path() == self.history_file
                    && self.source_id.as_deref() == Some(state.session_id().as_str()),
                "session_directory_source_changed"
            ),
            DirectoryValidation::Host(verify) => verify()?,
        }
        Ok(())
    }
}

pub(crate) enum DirectoryEntry {
    Resident(String),
    // Boxed: a historical row is an order of magnitude larger than an id.
    Historical(Box<AgentMessageTarget>),
}
pub(crate) struct DirectoryPage {
    // Production callers publish `targets`; tests inspect the ordered entries.
    #[cfg(test)]
    pub entries: Vec<DirectoryEntry>,
    pub targets: Vec<AgentMessageTarget>,
    pub query: SessionDiscoveryQuery,
    pub next_cursor: Option<String>,
    pub coverage: AgentMessageDiscoveryCoverage,
    pub completeness: AgentMessageDiscoveryCompleteness,
    pub issue_count: u32,
    pub scope: Arc<DirectoryScope>,
}

struct Root {
    path: PathBuf,
    directory: Arc<PrivateDirectory>,
    identity: String,
}
impl Root {
    fn open(path: &Path) -> Result<Self> {
        let directory = Arc::new(PrivateDirectory::open_existing(path)?);
        // Existing history compatibility directories may be 0755 below a private profile.
        // Ownership and non-writability by other users are still checked without repair.
        directory.verify_trusted_config_directory()?;
        Ok(Self {
            path: path.to_owned(),
            identity: directory.directory_identity()?,
            directory,
        })
    }
    fn verify(&self) -> Result<()> {
        self.directory.verify_trusted_config_directory()?;
        let current = PrivateDirectory::open_existing(&self.path)?;
        current.verify_trusted_config_directory()?;
        ensure!(
            current.directory_identity()? == self.identity,
            "session_directory_root_changed"
        );
        Ok(())
    }
}

/// Bound to actual host objects and held namespaces, never constructed from a request's IDs.
/// Scope identity proves where facts were read; the caller still supplies current authorization.
pub(crate) struct DirectoryScope {
    workspace: PathBuf,
    workspace_identity: String,
    storage: PathBuf,
    history: Option<PathBuf>,
    history_file: Option<PathBuf>,
    roots: Vec<Arc<Root>>,
    artifacts: Vec<Arc<Root>>,
    incomplete: u32,
}
impl DirectoryScope {
    fn capture_view(view: &DirectorySourceView<'_>) -> Result<Self> {
        view.verify()?;
        let workspace = dunce::canonicalize(&view.workspace)?;
        let workspace_identity =
            PrivateDirectory::open_existing(&workspace)?.directory_identity()?;
        let storage = view.storage.clone();
        let history = view.history_directory.clone();
        let mut paths = Vec::new();
        let mut unreadable_profile_roots = false;
        if let Some(parent) = history.as_deref() {
            paths.push(parent.to_owned());
            match kcoder_config::Settings::project_data_dirs_for_read(&view.workspace) {
                Ok(projects) => {
                    if let Some(primary) =
                        projects.iter().find(|project| parent.starts_with(project))
                    {
                        paths =
                            kcoder_thread_metadata::history_scan_roots(parent, primary, &projects);
                    }
                }
                Err(_) => unreadable_profile_roots = true,
            }
        }
        let mut roots = Vec::new();
        let mut incomplete =
            u32::from(paths.len() > MAX_ROOTS) + u32::from(unreadable_profile_roots);
        for path in paths.into_iter().take(MAX_ROOTS) {
            match Root::open(&path) {
                Ok(root) => {
                    if !roots
                        .iter()
                        .any(|existing: &Arc<Root>| existing.identity == root.identity)
                    {
                        roots.push(Arc::new(root));
                    }
                }
                Err(error) if missing(&error) => {}
                Err(_) => incomplete = incomplete.saturating_add(1),
            }
        }
        if history.is_some() && roots.is_empty() {
            incomplete = incomplete.saturating_add(1);
        }
        let mut artifacts = Vec::new();
        let mut artifact_paths = vec![storage.clone()];
        // These are documented producer layouts under the actual selected history/workspace,
        // not another user's HOME or a caller-supplied storage path.
        artifact_paths.extend(roots.iter().map(|root| root.path.join("client-sessions")));
        artifact_paths.push(workspace.join(".kcoder").join("sessions"));
        for path in artifact_paths {
            if artifacts.iter().any(|root: &Arc<Root>| root.path == path) {
                continue;
            }
            match Root::open(&path) {
                Ok(root) => {
                    if !artifacts
                        .iter()
                        .any(|existing: &Arc<Root>| existing.identity == root.identity)
                    {
                        artifacts.push(Arc::new(root));
                    }
                }
                Err(error) if missing(&error) => {}
                Err(_) => incomplete = incomplete.saturating_add(1),
            }
        }
        Ok(Self {
            workspace,
            workspace_identity,
            storage,
            history,
            history_file: view.history_file.clone(),
            roots,
            artifacts,
            incomplete,
        })
    }
    pub(crate) fn recorded_last_turn(&self, id: &str) -> Result<Option<AgentMessageLastTurn>> {
        observation::last_turn(self, id)
    }
    pub(crate) fn verify(
        &self,
        origin: &QueryEngine,
        owner: &AppStateLifecycleIdentity,
    ) -> Result<()> {
        self.verify_view(&DirectorySourceView::from_state(
            &origin.state,
            owner,
            &origin.client_storage_root(),
        ))
    }
    pub(crate) fn verify_view(&self, view: &DirectorySourceView<'_>) -> Result<()> {
        view.verify()?;
        ensure!(
            self.storage == view.storage
                && self.history == view.history_directory
                && self.history_file == view.history_file,
            "session_directory_scope_changed"
        );
        let workspace = dunce::canonicalize(&view.workspace)?;
        ensure!(
            workspace == self.workspace
                && PrivateDirectory::open_existing(&workspace)?.directory_identity()?
                    == self.workspace_identity,
            "session_directory_workspace_changed"
        );
        for root in self.roots.iter().chain(self.artifacts.iter()) {
            root.verify()?;
        }
        Ok(())
    }
}

#[derive(Clone)]
struct Candidate {
    id: String,
    root: Arc<Root>,
    nested: bool,
}
impl Candidate {
    fn parent(&self) -> Result<Arc<PrivateDirectory>> {
        self.root.verify()?;
        if self.nested {
            let child = self
                .root
                .directory
                .open_child(OsStr::new(&self.id), false)?;
            child.verify_trusted_config_directory()?;
            Ok(Arc::new(child))
        } else {
            Ok(self.root.directory.clone())
        }
    }
    fn verify_parent(&self, parent: &PrivateDirectory) -> Result<()> {
        self.root.verify()?;
        let current = if self.nested {
            self.root
                .directory
                .open_child(OsStr::new(&self.id), false)?
        } else {
            PrivateDirectory::open_existing(&self.root.path)?
        };
        ensure!(
            current.directory_identity()? == parent.directory_identity()?,
            "session_directory_parent_changed"
        );
        Ok(())
    }
    fn path(&self) -> PathBuf {
        let parent = if self.nested {
            self.root.path.join(&self.id)
        } else {
            self.root.path.clone()
        };
        parent.join(format!("{}.jsonl", self.id))
    }
}
struct Snapshot {
    scope: Arc<DirectoryScope>,
    owner: DirectoryBinding,
    ids: Vec<String>,
    candidates: BTreeMap<String, Candidate>,
    issues: u32,
    observed_issues: HashSet<usize>,
    query: SessionDiscoveryQuery,
    created: Instant,
}
impl Snapshot {
    fn observation_issue(&mut self, index: usize) {
        if self.observed_issues.insert(index) {
            self.issues = self.issues.saturating_add(1);
        }
    }
}

type DirectoryProjection<'a> = &'a mut dyn FnMut(
    &DirectoryEntry,
    Option<&AgentMessageTarget>,
) -> Result<Option<AgentMessageTarget>>;

fn filtered(query: &SessionDiscoveryQuery) -> bool {
    query.title.is_some()
        || query.query.is_some()
        || query.target_id.is_some()
        || query.status.is_some()
        || query.presence.is_some()
        || query.allowed_mode.is_some()
}

#[derive(Default)]
pub(crate) struct SessionDirectory {
    pages: HashMap<String, Snapshot>,
}

impl SessionDirectory {
    /// Exact bounded lookup using the same held-directory/source observations as
    /// paging. Absence is returned only after every required root was readable.
    /// This fact is not a delivery permit or a replacement for current policy.
    pub(crate) fn lookup_view(
        &self,
        view: &DirectorySourceView<'_>,
        id: &str,
        excluded_ids: &HashSet<String>,
    ) -> Result<Option<AgentMessageTarget>> {
        Ok(self
            .lookup_bound_view(view, id, excluded_ids)?
            .map(|bound| bound.row))
    }

    /// The management host can retain the exact original history and metadata
    /// sources for a native permission observation. This never grants execution.
    pub(crate) fn lookup_bound_view(
        &self,
        view: &DirectorySourceView<'_>,
        id: &str,
        excluded_ids: &HashSet<String>,
    ) -> Result<Option<BoundPeerSession>> {
        self.lookup_bound_view_inner(view, id, excluded_ids, true, false)
    }

    /// Admission needs current metadata and original handles, not the attempt ledger.
    pub(crate) fn lookup_bound_metadata_view(
        &self,
        view: &DirectorySourceView<'_>,
        id: &str,
        allow_unmaterialized: bool,
    ) -> Result<Option<BoundPeerSession>> {
        self.lookup_bound_view_inner(view, id, &HashSet::new(), false, allow_unmaterialized)
    }

    fn lookup_bound_view_inner(
        &self,
        view: &DirectorySourceView<'_>,
        id: &str,
        excluded_ids: &HashSet<String>,
        include_last_turn: bool,
        allow_unmaterialized: bool,
    ) -> Result<Option<BoundPeerSession>> {
        view.verify()?;
        ensure!(
            kcoder_types::cross_session_messages::valid_agent_message_id(id)
                && kcoder_workspace_resources::managed_worktrees::validate_thread_id(id).is_ok(),
            "session_directory_invalid_target"
        );
        ensure!(
            !excluded_ids.contains(id),
            "session_directory_target_excluded"
        );
        let scope = DirectoryScope::capture_view(view)?;
        ensure!(scope.incomplete == 0, "session_directory_lookup_incomplete");
        let mut candidates = BTreeMap::new();
        let mut ambiguous = HashSet::new();
        let mut issues = 0;
        let mut orphaned_artifacts = false;
        let filename = format!("{id}.jsonl");
        for root in &scope.roots {
            root.verify()?;
            match root
                .directory
                .open_single_link_regular_file(OsStr::new(&filename))
            {
                Ok(_) => insert_candidate(
                    &mut candidates,
                    &mut ambiguous,
                    Candidate {
                        id: id.to_owned(),
                        root: root.clone(),
                        nested: false,
                    },
                    &mut issues,
                ),
                Err(error) if missing(&error) => {
                    match root
                        .directory
                        .open_single_link_regular_file(OsStr::new(&format!("{id}.state.json")))
                    {
                        Ok(_) => orphaned_artifacts = true,
                        Err(error) if missing(&error) => {}
                        Err(error) => return Err(error),
                    }
                    match root.directory.open_child(OsStr::new(id), false) {
                        Ok(child) => {
                            child.verify_trusted_config_directory()?;
                            orphaned_artifacts = true;
                        }
                        Err(error) if missing(&error) => {}
                        Err(error) => return Err(error),
                    }
                }
                Err(error) => return Err(error),
            }
        }
        for root in &scope.artifacts {
            root.verify()?;
            let child = match root.directory.open_child(OsStr::new(id), false) {
                Ok(child) => child,
                Err(error) if missing(&error) => continue,
                Err(error) => return Err(error),
            };
            child.verify_trusted_config_directory()?;
            match child.open_single_link_regular_file(OsStr::new(&filename)) {
                Ok(_) => insert_candidate(
                    &mut candidates,
                    &mut ambiguous,
                    Candidate {
                        id: id.to_owned(),
                        root: root.clone(),
                        nested: true,
                    },
                    &mut issues,
                ),
                Err(error) if missing(&error) => orphaned_artifacts = true,
                Err(error) => return Err(error),
            }
        }
        ensure!(
            issues == 0 && ambiguous.is_empty(),
            "session_directory_target_ambiguous"
        );
        let scope = Arc::new(scope);
        let result = match candidates.get(id) {
            Some(candidate) => match if include_last_turn {
                observation::observe(&scope, candidate)?
            } else {
                observation::observe_metadata(&scope, candidate)?
            } {
                Some(row) => Some(BoundPeerSession::capture(
                    scope.clone(),
                    candidate.clone(),
                    row,
                )?),
                None => None,
            },
            None => {
                ensure!(
                    !orphaned_artifacts || allow_unmaterialized,
                    "session_directory_target_history_unavailable"
                );
                None
            }
        };
        scope.verify_view(view)?;
        Ok(result)
    }
    #[cfg(test)]
    pub(crate) fn page_view(
        &mut self,
        view: &DirectorySourceView<'_>,
        cursor: Option<&str>,
        resident_ids: &[String],
        excluded_ids: &HashSet<String>,
    ) -> Result<DirectoryPage> {
        self.page_view_inner(
            view,
            cursor,
            resident_ids,
            excluded_ids,
            &SessionDiscoveryQuery::default(),
            None,
        )
    }

    /// Project only the current candidate, with metadata from the same held scope.
    /// A projection failure propagates; an unavailable row keeps discovery partial.
    pub(crate) fn page_view_query<F>(
        &mut self,
        view: &DirectorySourceView<'_>,
        cursor: Option<&str>,
        resident_ids: &[String],
        excluded_ids: &HashSet<String>,
        query: &SessionDiscoveryQuery,
        mut project: F,
    ) -> Result<DirectoryPage>
    where
        F: FnMut(
            &DirectoryEntry,
            Option<&AgentMessageTarget>,
        ) -> Result<Option<AgentMessageTarget>>,
    {
        self.page_view_inner(
            view,
            cursor,
            resident_ids,
            excluded_ids,
            query,
            Some(&mut project),
        )
    }

    fn page_view_inner(
        &mut self,
        view: &DirectorySourceView<'_>,
        cursor: Option<&str>,
        resident_ids: &[String],
        excluded_ids: &HashSet<String>,
        requested: &SessionDiscoveryQuery,
        mut project: Option<DirectoryProjection<'_>>,
    ) -> Result<DirectoryPage> {
        let started = Instant::now();
        requested.validate().map_err(anyhow::Error::msg)?;
        view.verify()?;
        self.pages
            .retain(|_, page| page.created.elapsed() < CURSOR_TTL);
        let (token, offset, inherited_limit) = if let Some(cursor) = cursor {
            let mut parts = cursor.split(':');
            let token = parts.next().context("session_directory_invalid_cursor")?;
            let offset = parts
                .next()
                .context("session_directory_invalid_cursor")?
                .parse::<usize>()
                .context("session_directory_invalid_cursor")?;
            let limit = parts
                .next()
                .map(str::parse::<usize>)
                .transpose()
                .context("session_directory_invalid_cursor")?;
            ensure!(parts.next().is_none(), "session_directory_invalid_cursor");
            if let Some(limit) = limit {
                ensure!(
                    (1..=256).contains(&limit),
                    "session_directory_invalid_cursor"
                );
            }
            (token.to_owned(), offset, limit)
        } else {
            let scope = Arc::new(DirectoryScope::capture_view(view)?);
            scope.verify_view(view)?;
            let mut candidates = BTreeMap::new();
            let mut issues = scope.incomplete;
            let mut ambiguous = HashSet::new();
            for root in &scope.roots {
                let from_index = Self::indexed_ids(&scope, root);
                if let Ok(Some(ids)) = from_index {
                    for id in ids {
                        if kcoder_workspace_resources::managed_worktrees::validate_thread_id(&id)
                            .is_err()
                        {
                            issues = issues.saturating_add(1);
                            continue;
                        }
                        insert_candidate(
                            &mut candidates,
                            &mut ambiguous,
                            Candidate {
                                id,
                                root: root.clone(),
                                nested: false,
                            },
                            &mut issues,
                        );
                    }
                } else {
                    if root
                        .directory
                        .visit_entry_names_bounded(MAX_DIRECTORY_ENTRIES, |name| {
                            let Some(name) = name.to_str() else {
                                issues = issues.saturating_add(1);
                                return Ok(());
                            };
                            let suffix = if cfg!(windows) {
                                name.to_ascii_lowercase()
                            } else {
                                name.to_owned()
                            };
                            if !suffix.ends_with(".jsonl") || suffix.ends_with(".exit.jsonl") {
                                return Ok(());
                            }
                            let value = &name[..name.len() - 6];
                            if kcoder_workspace_resources::managed_worktrees::validate_thread_id(
                                value,
                            )
                            .is_err()
                            {
                                issues = issues.saturating_add(1);
                                return Ok(());
                            }
                            if candidates.len() >= MAX_ENTRIES {
                                anyhow::bail!("session_directory_capacity_exceeded");
                            }
                            insert_candidate(
                                &mut candidates,
                                &mut ambiguous,
                                Candidate {
                                    id: value.to_owned(),
                                    root: root.clone(),
                                    nested: false,
                                },
                                &mut issues,
                            );
                            Ok(())
                        })
                        .is_err()
                    {
                        issues = issues.saturating_add(1);
                    }
                }
            }
            // Tests, restored private hosts and the TUI may use a per-session history
            // layout. Enumerate only one known artifact level, never arbitrary subtrees.
            for root in &scope.artifacts {
                if root
                    .directory
                    .visit_entry_names_bounded(MAX_DIRECTORY_ENTRIES, |name| {
                        let Some(id) = name.to_str() else {
                            return Ok(());
                        };
                        if kcoder_workspace_resources::managed_worktrees::validate_thread_id(id)
                            .is_err()
                        {
                            return Ok(());
                        }
                        if ambiguous.contains(id) {
                            return Ok(());
                        }
                        let metadata = root.directory.entry_metadata(name)?;
                        if !metadata.is_dir() {
                            if metadata.file_type().is_symlink() {
                                issues = issues.saturating_add(1);
                            }
                            return Ok(());
                        }
                        let child = match root.directory.open_child(name, false) {
                            Ok(child) => child,
                            Err(_) => {
                                issues = issues.saturating_add(1);
                                return Ok(());
                            }
                        };
                        let filename = format!("{id}.jsonl");
                        match child.open_single_link_regular_file(OsStr::new(&filename)) {
                            Ok(_) => {}
                            Err(error) if missing(&error) => return Ok(()),
                            Err(_) => {
                                issues = issues.saturating_add(1);
                                return Ok(());
                            }
                        }
                        if candidates.len() >= MAX_ENTRIES {
                            anyhow::bail!("session_directory_capacity_exceeded");
                        }
                        insert_candidate(
                            &mut candidates,
                            &mut ambiguous,
                            Candidate {
                                id: id.to_owned(),
                                root: root.clone(),
                                nested: true,
                            },
                            &mut issues,
                        );
                        Ok(())
                    })
                    .is_err()
                {
                    issues = issues.saturating_add(1);
                }
            }
            let mut ids = candidates.keys().cloned().collect::<Vec<_>>();
            ids.extend(resident_ids.iter().cloned());
            ids.retain(|id| {
                view.source_id.as_ref() != Some(id)
                    && !excluded_ids.contains(id)
                    && (!ambiguous.contains(id) || resident_ids.contains(id))
            });
            ids.sort();
            ids.dedup();
            scope.verify_view(view)?;
            if self.pages.len() >= MAX_PAGES
                && let Some(oldest) = self
                    .pages
                    .iter()
                    .min_by_key(|(_, page)| page.created)
                    .map(|(key, _)| key.clone())
            {
                self.pages.remove(&oldest);
            }
            let token = uuid::Uuid::new_v4().simple().to_string();
            self.pages.insert(
                token.clone(),
                Snapshot {
                    scope,
                    owner: view.binding.clone(),
                    ids,
                    candidates,
                    issues,
                    observed_issues: HashSet::new(),
                    query: requested.clone(),
                    created: Instant::now(),
                },
            );
            (token, 0, None)
        };
        let snapshot = self
            .pages
            .get_mut(&token)
            .context("session_directory_invalid_cursor")?;
        ensure!(
            snapshot.owner.matches(&view.binding),
            "session_directory_invalid_cursor"
        );
        snapshot.scope.verify_view(view)?;
        ensure!(
            offset <= snapshot.ids.len() && (offset < snapshot.ids.len() || offset == 0),
            "session_directory_invalid_cursor"
        );
        let mut inherited = snapshot.query.clone();
        if let Some(limit) = inherited_limit {
            inherited.limit = Some(limit);
        }
        let query = inherited
            .for_continuation(requested)
            .map_err(anyhow::Error::msg)?;
        let searching = filtered(&query);
        ensure!(
            project.is_some() || !searching,
            "session_directory_projection_required"
        );
        let page_size = query.page_size();
        let title_query = SessionDiscoveryQuery {
            title: query.title.clone(),
            query: query.query.clone(),
            ..Default::default()
        };
        let mut entries = Vec::new();
        let mut targets = Vec::new();
        let mut matched_bytes = 2usize;
        let mut index = offset;
        let end = offset
            .saturating_add(if searching {
                MAX_ENTRIES
            } else {
                MAX_EXAMINED_PER_PAGE.max(page_size)
            })
            .min(snapshot.ids.len());
        let mut budget_limited = false;
        while index < end && entries.len() < page_size {
            if index > offset && (index - offset).is_multiple_of(16) {
                view.verify()?;
                if started.elapsed() >= QUERY_SCAN_BUDGET {
                    budget_limited = true;
                    break;
                }
            }
            let position = index;
            let id = snapshot.ids[index].clone();
            index += 1;
            if excluded_ids.contains(&id) {
                continue;
            }
            let resident = resident_ids.contains(&id);
            if !resident && (title_query.title.is_some() || title_query.query.is_some()) {
                // Resident titles come from the current host projection. Saved titles are
                // independently validated metadata, never conversation text or authority.
                match observation::title_matches(&snapshot.scope, &id, &title_query) {
                    Ok(true) => {}
                    Ok(false) => continue,
                    Err(_) => {
                        snapshot.observation_issue(position);
                        continue;
                    }
                }
            }
            let mut history = if !resident || project.is_some() {
                if let Some(candidate) = snapshot.candidates.get(&id) {
                    let observed = if project.is_some() {
                        observation::observe_metadata(&snapshot.scope, candidate)
                    } else {
                        observation::observe(&snapshot.scope, candidate)
                    };
                    match observed {
                        Ok(row) => row,
                        Err(_) => {
                            snapshot.observation_issue(position);
                            None
                        }
                    }
                } else {
                    None
                }
            } else {
                None
            };
            let entry = if resident {
                DirectoryEntry::Resident(id.clone())
            } else if let Some(row) = history.take() {
                DirectoryEntry::Historical(Box::new(row))
            } else {
                continue;
            };
            if let Some(project) = project.as_mut() {
                let metadata = match &entry {
                    DirectoryEntry::Historical(row) => Some(row.as_ref()),
                    DirectoryEntry::Resident(_) => history.as_ref(),
                };
                let Some(mut row) = project(&entry, metadata)? else {
                    snapshot.observation_issue(position);
                    continue;
                };
                ensure!(row.thread_id == id, "session_directory_projection_changed");
                if !row.matches_query(&query) {
                    continue;
                }
                // Attempt ledgers are irrelevant to filtering. Read them only after
                // current host facts and delivery modes actually match this page.
                match snapshot.scope.recorded_last_turn(&id) {
                    Ok(last_turn) => row.last_turn = last_turn,
                    Err(_) => {
                        snapshot.observation_issue(position);
                        if !resident {
                            continue;
                        }
                        row.last_turn = None;
                    }
                }
                let bytes = serde_json::to_vec(&row)?.len().saturating_add(1);
                if matched_bytes.saturating_add(bytes) > MATCHED_PAGE_BYTES {
                    if targets.is_empty() {
                        // An oversized identity cannot be truncated into a different target.
                        snapshot.observation_issue(position);
                        continue;
                    }
                    // This candidate was not published and remains first on the next page.
                    index = position;
                    break;
                }
                matched_bytes = matched_bytes.saturating_add(bytes);
                targets.push(row);
            }
            entries.push(entry);
        }
        if searching && index == end && index < snapshot.ids.len() {
            budget_limited = true;
        }
        snapshot.scope.verify_view(view)?;
        let next_cursor =
            (index < snapshot.ids.len()).then(|| format!("{token}:{index}:{}", query.page_size()));
        let completeness = if snapshot.issues > 0 || budget_limited {
            AgentMessageDiscoveryCompleteness::Partial
        } else if next_cursor.is_some() {
            AgentMessageDiscoveryCompleteness::Indexing
        } else {
            AgentMessageDiscoveryCompleteness::Complete
        };
        Ok(DirectoryPage {
            #[cfg(test)]
            entries,
            targets,
            query,
            next_cursor,
            coverage: if snapshot.scope.history.is_some() {
                AgentMessageDiscoveryCoverage::WorkspaceHistory
            } else {
                AgentMessageDiscoveryCoverage::ResidentOnly
            },
            completeness,
            issue_count: snapshot.issues,
            scope: snapshot.scope.clone(),
        })
    }
    fn indexed_ids(scope: &DirectoryScope, root: &Root) -> Result<Option<Vec<String>>> {
        let Some(mut catalog) = kcoder_state::history_index::TrackedHistoryCatalog::open(
            &scope.storage,
            &root.path,
            &kcoder_state::history_index::workspace_catalog_scope(&root.path, &scope.workspace)?,
            false,
        )?
        else {
            return Ok(None);
        };
        Ok(catalog.read_ready(MAX_ENTRIES)?.map(|snapshot| {
            snapshot
                .sessions
                .into_iter()
                .map(|row| row.session_id)
                .collect()
        }))
    }
}
fn insert_candidate(
    candidates: &mut BTreeMap<String, Candidate>,
    ambiguous: &mut HashSet<String>,
    candidate: Candidate,
    issues: &mut u32,
) {
    if ambiguous.contains(&candidate.id) {
        return;
    }
    if let Some(previous) = candidates.get(&candidate.id) {
        if previous.path() != candidate.path() {
            candidates.remove(&candidate.id);
            ambiguous.insert(candidate.id);
            *issues = issues.saturating_add(1);
        }
    } else {
        candidates.insert(candidate.id.clone(), candidate);
    }
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
