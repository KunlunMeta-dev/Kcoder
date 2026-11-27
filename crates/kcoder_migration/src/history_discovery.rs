//! Bounded account-local inventories. Opaque selections never accept client paths.
use crate::history_sources::{
    HistoryFileSelection, HistorySourceBinding, claude_file_identity, codex_file_identity,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

mod families;
mod grouping;
mod preview;
const MAX_ENTRIES: usize = 65_536;
const MAX_SESSIONS: usize = 10_000;
const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
const LIFETIME: Duration = Duration::from_secs(600);

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    selected: HistoryFileSelection,
    summary: HistorySourceSummary,
}
#[derive(Default)]
struct PageMetadata {
    summaries: BTreeMap<String, HistorySourceSummary>,
    bytes: usize,
}

pub struct HistoryCatalog {
    displayed: Mutex<PageMetadata>,
    families: Option<families::Index>,
    id: String,
    created: Instant,
    source: MigrationSourceKind,
    entries: Vec<Entry>,
    problems: BTreeMap<String, u64>,
    cost: usize,
}

/// Native-only, pinned source selection. Capture after releasing the registry lock.
pub struct HistorySelectionGrant {
    created: Instant,
    entry: Entry,
}

/// An explicitly accepted selection, private to a durable target-owned journal.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryPendingSelection {
    entry: Entry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    received: Option<Box<crate::source_transfer::ReceivedHistoryBinding>>,
}

#[derive(Clone)]
enum Location {
    ClaudeProjects,
    ClaudeProject,
    ClaudeSession(String),
    ClaudeAgents(String),
    Codex { archived: bool, date_depth: usize },
}

struct Scanner<'a, C> {
    root: &'a Path,
    root_identity: String,
    catalog: HistoryCatalog,
    visited: usize,
    cancelled: bool,
    budget_exceeded: bool,
    check: &'a mut C,
}

impl HistoryCatalog {
    /// The native caller must authorize this product root. This never searches other homes.
    pub fn discover(
        root: &Path,
        source: MigrationSourceKind,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Self> {
        ensure!(root.is_absolute(), "history_discovery_unsafe_root");
        let directory = PrivateDirectory::open_existing(root)
            .map_err(|_| anyhow::anyhow!("history_discovery_root_unavailable"))?;
        directory
            .verify_trusted_config_directory()
            .map_err(|_| anyhow::anyhow!("history_discovery_root_untrusted"))?;
        let root_identity = directory.directory_identity()?;
        let mut scanner = Scanner {
            root,
            root_identity: root_identity.clone(),
            visited: 0,
            cancelled: false,
            budget_exceeded: false,
            check: &mut check,
            catalog: Self {
                displayed: Mutex::default(),
                families: None,
                id: format!("history-{}", uuid::Uuid::new_v4().simple()),
                created: Instant::now(),
                source,
                entries: Vec::new(),
                problems: BTreeMap::new(),
                cost: 0,
            },
        };
        match source {
            MigrationSourceKind::ClaudeCode => scanner.child(
                &directory,
                Path::new(""),
                OsStr::new("projects"),
                Location::ClaudeProjects,
                true,
            ),
            MigrationSourceKind::Codex => {
                scanner.child(
                    &directory,
                    Path::new(""),
                    OsStr::new("sessions"),
                    Location::Codex {
                        archived: false,
                        date_depth: 0,
                    },
                    true,
                );
                scanner.child(
                    &directory,
                    Path::new(""),
                    OsStr::new("archived_sessions"),
                    Location::Codex {
                        archived: true,
                        date_depth: 0,
                    },
                    true,
                );
            }
        }
        ensure!(!scanner.cancelled, "history_discovery_cancelled");
        ensure!(
            PrivateDirectory::open_existing(root)?.directory_identity()? == root_identity,
            "migration_history_source_changed"
        );
        scanner.catalog.entries.sort_by(|a, b| {
            b.summary
                .modified_at_ms
                .cmp(&a.summary.modified_at_ms)
                .then_with(|| a.summary.source_handle.cmp(&b.summary.source_handle))
        });
        grouping::order(&mut scanner.catalog.entries);
        Ok(scanner.catalog)
    }

    /// Explicitly index bounded Codex metadata. Ordinary discovery remains metadata-lazy.
    pub fn discover_codex_families(
        root: &Path,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Self> {
        let mut catalog = Self::discover(root, MigrationSourceKind::Codex, &mut check)?;
        catalog.families = Some(families::Index::build(&mut catalog, &mut check)?);
        ensure!(!catalog.expired(), "history_discovery_expired");
        Ok(catalog)
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn expired(&self) -> bool {
        self.created.elapsed() >= LIFETIME
    }
    pub fn estimated_bytes(&self) -> usize {
        self.cost
    }

    /// Head/tail reads are deferred until a page is requested. At most ten leaves are sampled.
    pub fn page(
        &self,
        cursor: Option<&str>,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistorySourcePage> {
        ensure!(!self.expired(), "history_discovery_expired");
        let offset = match cursor {
            None => 0,
            Some(cursor) => {
                let (catalog, offset) = cursor
                    .rsplit_once(':')
                    .context("history_discovery_invalid_cursor")?;
                ensure!(
                    catalog == self.id && offset.len() <= 6,
                    "history_discovery_invalid_cursor"
                );
                offset
                    .parse::<usize>()
                    .map_err(|_| anyhow::anyhow!("history_discovery_invalid_cursor"))?
            }
        };
        ensure!(
            offset <= self.entries.len(),
            "history_discovery_invalid_cursor"
        );
        let end = (offset + 10).min(self.entries.len());
        let mut items = Vec::new();
        for (index, entry) in self.entries[offset..end].iter().enumerate() {
            ensure!(check(index as u64), "history_discovery_cancelled");
            if let Some(families) = &self.families {
                families.verify(entry, &mut || check(index as u64))?;
            }
            let mut summary = entry.summary.clone();
            let mut cancelled = false;
            let sampled = preview::read(&entry.selected, &mut || {
                let proceed = check(index as u64);
                cancelled |= !proceed;
                proceed
            });
            ensure!(!cancelled, "history_discovery_cancelled");
            match sampled {
                Ok(metadata) => {
                    summary.title = metadata.title;
                    summary.project = metadata.project;
                    summary.parent_session_id = if let Some(families) = &self.families {
                        families.parent(entry)
                    } else {
                        summary.parent_session_id.or(metadata.parent_session_id)
                    };
                    summary.preview_incomplete |= metadata.incomplete;
                }
                Err(_) => summary.preview_incomplete = true,
            }
            {
                let mut displayed = self
                    .displayed
                    .lock()
                    .map_err(|_| anyhow::anyhow!("history_discovery_metadata_unavailable"))?;
                let old = displayed
                    .summaries
                    .get(&summary.source_handle)
                    .map(serde_json::to_vec)
                    .transpose()?
                    .map_or(0, |value| value.len());
                let bytes = displayed.bytes - old + serde_json::to_vec(&summary)?.len();
                ensure!(
                    self.cost + bytes <= MAX_METADATA_BYTES,
                    "history_discovery_budget_exceeded"
                );
                displayed.bytes = bytes;
                displayed
                    .summaries
                    .insert(summary.source_handle.clone(), summary.clone());
            }
            items.push(summary);
        }
        Ok(HistorySourcePage {
            catalog_id: self.id.clone(),
            items,
            total_items: self.entries.len() as u64,
            next_cursor: (end < self.entries.len()).then(|| format!("{}:{end}", self.id)),
            discovery_complete: self.problems.is_empty(),
            problems: self
                .problems
                .iter()
                .map(|(code, count)| HistoryDiscoveryProblem {
                    code: code.clone(),
                    count: *count,
                })
                .collect(),
        })
    }

    pub fn selection(&self, handle: &str) -> Result<HistorySelectionGrant> {
        ensure!(!self.expired(), "history_discovery_expired");
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.summary.source_handle == handle)
            .context("history_discovery_selection_unavailable")?;
        let mut entry = entry.clone();
        if let Some(summary) = self
            .displayed
            .lock()
            .map_err(|_| anyhow::anyhow!("history_discovery_metadata_unavailable"))?
            .summaries
            .get(handle)
        {
            // Display metadata is already bounded and sampled. Selecting does not reread source bytes.
            entry.summary = summary.clone();
        }
        Ok(HistorySelectionGrant {
            created: self.created,
            entry,
        })
    }

    pub fn capture(
        &self,
        handle: &str,
        check: &mut impl FnMut(u64, u64) -> bool,
    ) -> Result<HistorySourceBinding> {
        self.selection(handle)?.capture(check)
    }
}

impl HistorySelectionGrant {
    pub(crate) fn with_uploaded_root(
        mut self,
        binding: Option<&crate::source_transfer::uploads::UploadedRootBinding>,
    ) -> Result<Self> {
        if let Some(binding) = binding {
            self.entry.selected = self.entry.selected.with_uploaded_root(binding.clone())?;
            self.entry.summary.modified_at_ms = None;
        }
        Ok(self)
    }
    /// Persist only metadata and filesystem identities; hashing belongs to the cancellable worker.
    pub fn pin(&self) -> Result<HistoryPendingSelection> {
        ensure!(
            self.created.elapsed() < LIFETIME,
            "history_discovery_expired"
        );
        ensure!(
            self.entry.summary.import_issues.is_empty(),
            "migration_history_source_budget_exceeded"
        );
        let mut entry = self.entry.clone();
        entry.selected = entry.selected.freeze()?;
        Ok(HistoryPendingSelection {
            entry,
            received: None,
        })
    }

    pub fn capture(
        &self,
        check: &mut impl FnMut(u64, u64) -> bool,
    ) -> Result<HistorySourceBinding> {
        self.pin()?.capture(check)
    }
}

impl HistoryPendingSelection {
    pub(crate) fn from_received(
        received: crate::source_transfer::ReceivedHistoryBinding,
    ) -> Result<Self> {
        let binding = received.bound();
        let selected = HistoryFileSelection::from_binding(binding)?;
        let origin = &binding.snapshot().origin;
        let summary = HistorySourceSummary {
            source_handle: selected.selection_identity()?,
            source: origin.source,
            source_session_id: origin.source_session_id.clone(),
            source_artifact_id: origin.source_artifact_id.clone(),
            parent_session_id: origin.parent_session_id.clone(),
            agent_id: None,
            bytes: selected.bytes,
            modified_at_ms: selected.modified_at_ms,
            archived: origin.archived,
            compressed: selected.compressed(),
            title: origin.title.clone(),
            project: origin.project.clone(),
            preview_incomplete: false,
            import_issues: Vec::new(),
        };
        Ok(Self {
            entry: Entry { selected, summary },
            received: Some(Box::new(received)),
        })
    }
    pub(crate) fn verify_batch_parent(&self, parent: &PrivateDirectory) -> Result<()> {
        if let Some(received) = &self.received {
            received.verify_batch_parent(parent)?;
        }
        Ok(())
    }

    pub(crate) fn verify_history_directory(&self, directory: &PrivateDirectory) -> Result<()> {
        if let Some(received) = &self.received {
            received.verify_history_directory(directory)?;
        }
        Ok(())
    }
    /// Public discovery metadata only; the pinned root and source handles remain private.
    pub fn summary(&self) -> &HistorySourceSummary {
        &self.entry.summary
    }
    pub(crate) fn bound_bytes(&self) -> u64 {
        self.entry.selected.bytes
    }

    /// Stable frozen input identity, independent of a transient discovery handle.
    pub(crate) fn batch_fingerprint(&self) -> Result<String> {
        use sha2::{Digest, Sha256};
        if let Some(received) = &self.received {
            ensure!(
                self.matches_binding(received.bound()),
                "source_transfer_binding_changed"
            );
            return Ok(format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    "received-history-batch-source/1",
                    received,
                    &self.entry.selected,
                ))?)
            ));
        }
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "history-batch-source/1",
                &self.entry.selected,
                self.source(),
                &self.entry.summary.source_session_id,
                &self.entry.summary.source_artifact_id,
                &self.entry.summary.parent_session_id,
                self.entry.summary.archived,
                self.entry.summary.compressed,
            ))?)
        ))
    }

    pub fn source(&self) -> MigrationSourceKind {
        self.entry.summary.source
    }

    pub fn selection_identity(&self) -> Result<String> {
        use sha2::{Digest, Sha256};
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                self.entry.selected.selection_identity()?,
                self.source(),
                &self.entry.summary.source_session_id,
                &self.entry.summary.source_artifact_id,
            ))?)
        ))
    }

    pub(crate) fn matches_binding(&self, binding: &HistorySourceBinding) -> bool {
        self.entry.selected.matches_binding(binding)
            && binding.snapshot().origin.source == self.source()
            && binding.snapshot().origin.source_session_id == self.entry.summary.source_session_id
            && binding.snapshot().origin.source_artifact_id == self.entry.summary.source_artifact_id
    }

    pub fn capture(
        &self,
        check: &mut impl FnMut(u64, u64) -> bool,
    ) -> Result<HistorySourceBinding> {
        if let Some(received) = &self.received {
            ensure!(
                self.matches_binding(received.bound()),
                "source_transfer_binding_changed"
            );
            return received.capture(check);
        }
        let entry = &self.entry;
        let mut cancelled = false;
        let sampled = preview::read_pinned(&entry.selected, &mut || {
            let proceed = check(0, entry.selected.bytes);
            cancelled |= !proceed;
            proceed
        });
        ensure!(!cancelled, "history_discovery_cancelled");
        let metadata = sampled.unwrap_or(preview::Preview {
            title: None,
            project: None,
            incomplete: true,
            parent_session_id: None,
        });
        let summary = &entry.summary;
        ensure!(
            summary.import_issues.is_empty(),
            "migration_history_source_budget_exceeded"
        );
        entry.selected.capture(
            ExternalHistoryOrigin {
                source: summary.source,
                source_instance: "selected-history-root".into(),
                source_session_id: summary.source_session_id.clone(),
                source_artifact_id: summary.source_artifact_id.clone(),
                source_format: "jsonl".into(),
                adapter_revision: "raw/1".into(),
                title: metadata.title,
                created_at: None,
                updated_at: None,
                project: metadata.project,
                archived: summary.archived,
                parent_session_id: summary
                    .parent_session_id
                    .clone()
                    .or(metadata.parent_session_id),
            },
            check,
        )
    }
}

impl<C: FnMut(u64) -> bool> Scanner<'_, C> {
    fn problem(&mut self, code: &str) {
        *self.catalog.problems.entry(code.into()).or_default() += 1;
    }
    fn child(
        &mut self,
        parent: &PrivateDirectory,
        relative: &Path,
        name: &OsStr,
        location: Location,
        optional: bool,
    ) {
        if self.cancelled || self.budget_exceeded {
            return;
        }
        match parent.open_child(name, false) {
            Ok(directory) => {
                if directory.verify_trusted_config_directory().is_err() {
                    self.problem("history_discovery_unsafe_entry");
                    return;
                }
                self.walk(&directory, &relative.join(name), location);
            }
            Err(error)
                if optional
                    && error.chain().any(|cause| {
                        cause
                            .downcast_ref::<std::io::Error>()
                            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                    }) => {}
            Err(_) => self.problem("history_discovery_unsafe_or_unreadable_directory"),
        }
    }
    fn walk(&mut self, directory: &PrivateDirectory, relative: &Path, location: Location) {
        if relative.components().count() >= 16 {
            self.problem("history_discovery_depth_exceeded");
            return;
        }
        let result = directory.visit_entry_names_bounded(MAX_ENTRIES, |name| {
            self.visited += 1;
            if self.visited > MAX_ENTRIES {
                self.budget_exceeded = true;
                anyhow::bail!("budget");
            }
            if !(self.check)(self.visited as u64) {
                self.cancelled = true;
                anyhow::bail!("cancelled");
            }
            if self.cancelled || self.budget_exceeded {
                anyhow::bail!("stopped");
            }
            let metadata = match directory.entry_metadata(name) {
                Ok(metadata) => metadata,
                Err(_) => {
                    self.problem("history_discovery_unsafe_entry");
                    return Ok(());
                }
            };
            if metadata.file_type().is_symlink() {
                self.problem("history_discovery_unsafe_entry");
                return Ok(());
            }
            if metadata.is_dir() {
                let next = match &location {
                    Location::ClaudeProjects => Some(Location::ClaudeProject),
                    Location::ClaudeProject => name
                        .to_str()
                        .and_then(canonical_uuid)
                        .map(Location::ClaudeSession),
                    Location::ClaudeSession(session) if name == OsStr::new("subagents") => {
                        Some(Location::ClaudeAgents(session.clone()))
                    }
                    Location::ClaudeAgents(session) => {
                        Some(Location::ClaudeAgents(session.clone()))
                    }
                    Location::Codex {
                        archived,
                        date_depth,
                    } if *date_depth < 3
                        && name.to_str().is_some_and(|name| {
                            name.len() == if *date_depth == 0 { 4 } else { 2 }
                                && name.bytes().all(|b| b.is_ascii_digit())
                        }) =>
                    {
                        Some(Location::Codex {
                            archived: *archived,
                            date_depth: date_depth + 1,
                        })
                    }
                    _ => None,
                };
                if let Some(next) = next {
                    self.child(directory, relative, name, next, false);
                }
            } else if metadata.is_file() && history_filename(name) {
                self.file(directory, relative, name, &location);
            } else if history_filename(name) {
                self.problem("history_discovery_unsafe_entry");
            }
            Ok(())
        });
        if result.is_err() && !self.cancelled && !self.budget_exceeded {
            self.problem("history_discovery_directory_incomplete");
        }
        if self.budget_exceeded {
            self.catalog
                .problems
                .entry("history_discovery_budget_exceeded".into())
                .or_insert(1);
        }
    }
    fn file(
        &mut self,
        directory: &PrivateDirectory,
        relative: &Path,
        name: &OsStr,
        location: &Location,
    ) {
        let path = relative.join(name);
        let identity = match location {
            Location::ClaudeProject => name
                .to_str()
                .and_then(|name| {
                    name.strip_suffix(".jsonl.zst")
                        .or_else(|| name.strip_suffix(".jsonl"))
                })
                .and_then(canonical_uuid)
                .map(|id| (id, None, None, None, false)),
            Location::ClaudeAgents(session) => name
                .to_str()
                .and_then(|name| name.strip_prefix("agent-"))
                .and_then(|name| {
                    name.strip_suffix(".jsonl.zst")
                        .or_else(|| name.strip_suffix(".jsonl"))
                })
                .filter(|id| !id.is_empty() && id.len() <= 4096)
                .map(|id| {
                    (
                        session.clone(),
                        None,
                        Some(session.clone()),
                        Some(id.into()),
                        false,
                    )
                }),
            Location::Codex { archived, .. } => codex_file_identity(&path)
                .map(|(thread, physical)| (thread, Some(physical), None, None, *archived)),
            _ => return,
        };
        let Some((session, mut artifact, parent, agent, archived)) = identity else {
            self.problem("history_discovery_unrecognized_filename");
            return;
        };
        if self.catalog.source == MigrationSourceKind::ClaudeCode {
            artifact = claude_file_identity(&path);
            if artifact.is_none() {
                self.problem("history_discovery_unrecognized_filename");
                return;
            }
        }
        let selected = match directory.directory_identity().and_then(|parent_identity| {
            HistoryFileSelection::inspect(self.root, &path, &self.root_identity, &parent_identity)
        }) {
            Ok(selected) => selected,
            Err(_) => {
                self.problem("history_discovery_unsafe_entry");
                return;
            }
        };
        let cost = selected.cost()
            + session.len()
            + artifact.as_ref().map_or(0, String::len)
            + parent.as_ref().map_or(0, String::len)
            + agent.as_ref().map_or(0, String::len);
        if self.catalog.entries.len() >= MAX_SESSIONS
            || self.catalog.cost + cost > MAX_METADATA_BYTES
        {
            self.budget_exceeded = true;
            self.problem("history_discovery_budget_exceeded");
            return;
        }
        let compressed = selected.compressed();
        self.catalog.cost += cost;
        self.catalog.entries.push(Entry {
            summary: HistorySourceSummary {
                source_handle: format!("history-source-{}", uuid::Uuid::new_v4().simple()),
                source: self.catalog.source,
                source_session_id: session,
                source_artifact_id: artifact,
                parent_session_id: parent,
                agent_id: agent,
                bytes: selected.bytes,
                modified_at_ms: selected.modified_at_ms,
                archived,
                compressed,
                title: None,
                project: None,
                preview_incomplete: false,
                import_issues: if selected.bytes > EXTERNAL_HISTORY_MAX_BYTES {
                    vec!["migration_history_source_budget_exceeded".into()]
                } else {
                    Vec::new()
                },
            },
            selected,
        });
    }
}

fn canonical_uuid(value: &str) -> Option<String> {
    (value.len() == 36)
        .then(|| uuid::Uuid::parse_str(value).ok().map(|id| id.to_string()))
        .flatten()
}
fn history_filename(name: &OsStr) -> bool {
    Path::new(name).extension() == Some(OsStr::new("jsonl"))
        || Path::new(name)
            .file_stem()
            .is_some_and(|stem| Path::new(stem).extension() == Some(OsStr::new("jsonl")))
            && Path::new(name).extension() == Some(OsStr::new("zst"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_catalogs_reject_pages_and_selections_before_accessing_sources() {
        let catalog = HistoryCatalog {
            displayed: Mutex::default(),
            families: None,
            id: "expired".into(),
            created: Instant::now() - LIFETIME - Duration::from_secs(1),
            source: MigrationSourceKind::Codex,
            entries: Vec::new(),
            problems: BTreeMap::new(),
            cost: 0,
        };
        assert!(
            catalog
                .page(None, |_| panic!("expired catalog must not scan"))
                .is_err()
        );
        assert!(
            catalog
                .capture("any", &mut |_, _| panic!(
                    "expired grant must not read sources"
                ))
                .is_err()
        );
    }
    #[test]
    fn a_detached_selection_grant_still_expires_before_capture() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("projects/p");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("11111111-1111-4111-8111-111111111111.jsonl"),
            b"{}\n",
        )
        .unwrap();
        let catalog =
            HistoryCatalog::discover(root.path(), MigrationSourceKind::ClaudeCode, |_| true)
                .unwrap();
        let mut grant = catalog
            .selection(&catalog.entries[0].summary.source_handle)
            .unwrap();
        grant.created = Instant::now() - LIFETIME - Duration::from_secs(1);
        assert!(
            grant
                .capture(&mut |_, _| panic!("expired grant must not read"))
                .is_err()
        );
    }
}
