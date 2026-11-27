//! Current-profile metadata hints only. No workspace, history or execution grant is returned.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::thread_workspace_lookup::*;
use kcoder_config::{
    PrivateDirectory,
    workspace_identity::{WorkspaceAddressLookup, WorkspaceAddressReader, WorkspaceIdentity},
};
use kcoder_state::PreparedSessionMetadata;
use std::{
    collections::{BTreeSet, HashMap},
    ffi::{OsStr, OsString},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tokio_util::sync::CancellationToken;

const MAX_PROJECTS: usize = 16_384;
const MAX_SNAPSHOTS: usize = 4;
const MAX_METADATA_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CURSORS: usize = 1024;
const LIFETIME: Duration = Duration::from_secs(60);

// Directory hints are checked for ordinary directory identity only; the subsequent
// thread lookup remains the authority for returning session metadata.
fn verify_lookup_directory(directory: &PrivateDirectory) -> Result<()> {
    directory.verify_trusted_config_directory()
}

/// Locate only the startup loader's original profile. This is not a read grant.
pub fn original_profile_root(paths: &kcoder_config::ConfigPaths) -> Result<&Path> {
    ensure!(
        paths.config_dir.is_absolute()
            && paths.user_settings == paths.config_dir.join("settings.json"),
        "THREAD_WORKSPACE_LOOKUP_PROFILE_UNAVAILABLE"
    );
    Ok(&paths.config_dir)
}

struct Snapshot {
    thread: String,
    names: Vec<OsString>,
    stamp: SystemTime,
    projects_identity: String,
    born: Instant,
    issues: BTreeSet<usize>,
    complete: bool,
}
struct Cursor {
    snapshot: String,
    offset: usize,
}

/// The App Server supplies its captured current profile, never a request path.
pub struct ProfileWorkspaceLookup {
    path: PathBuf,
    profile: PrivateDirectory,
    identity: String,
    snapshots: HashMap<String, Snapshot>,
    cursors: HashMap<String, Cursor>,
}
impl ProfileWorkspaceLookup {
    pub fn capture(profile: &Path) -> Result<Self> {
        let held = PrivateDirectory::open_existing(profile)?;
        held.verify_trusted_config_directory()?;
        let identity = held.directory_identity()?;
        Ok(Self {
            path: profile.to_owned(),
            profile: held,
            identity,
            snapshots: HashMap::new(),
            cursors: HashMap::new(),
        })
    }
    fn verify(&self, cancel: &CancellationToken) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "THREAD_WORKSPACE_LOOKUP_CANCELLED");
        self.profile.verify_trusted_config_directory()?;
        ensure!(
            self.profile.directory_identity()? == self.identity
                && PrivateDirectory::open_existing(&self.path)?.directory_identity()?
                    == self.identity,
            "THREAD_WORKSPACE_LOOKUP_PROFILE_CHANGED"
        );
        Ok(())
    }
    fn projects(&self) -> Result<Option<PrivateDirectory>> {
        let entry = match self.profile.open_entry_handle(OsStr::new("projects")) {
            Ok(value) => value,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let directory = entry.open_child_directory()?;
        verify_lookup_directory(&directory)?;
        Ok(Some(directory))
    }
    pub fn lookup(
        &mut self,
        params: ThreadWorkspaceLookupParams,
        cancel: &CancellationToken,
    ) -> Result<ThreadWorkspaceLookupResult> {
        params.validate().map_err(anyhow::Error::msg)?;
        kcoder_workspace_resources::managed_worktrees::validate_thread_id(&params.thread_id)?;
        self.verify(cancel)?;
        let expired = self
            .snapshots
            .iter()
            .filter(|(_, value)| value.born.elapsed() >= LIFETIME)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for id in expired {
            self.snapshots.remove(&id);
        }
        self.cursors
            .retain(|_, value| self.snapshots.contains_key(&value.snapshot));
        let Some(projects) = self.projects()? else {
            ensure!(
                params.cursor.is_none(),
                "THREAD_WORKSPACE_LOOKUP_CURSOR_STALE"
            );
            return Ok(result(params.thread_id, Vec::new(), 0, 0, None));
        };
        let identity = projects.directory_identity()?;
        let (snapshot_id, offset) = if let Some(cursor) = &params.cursor {
            let cursor = self
                .cursors
                .get(cursor)
                .context("THREAD_WORKSPACE_LOOKUP_CURSOR_STALE")?;
            (cursor.snapshot.clone(), cursor.offset)
        } else {
            if self.snapshots.len() >= MAX_SNAPSHOTS {
                if let Some(id) = self
                    .snapshots
                    .iter()
                    .filter(|(_, value)| value.complete)
                    .min_by_key(|(_, value)| value.born)
                    .map(|(id, _)| id.clone())
                {
                    self.snapshots.remove(&id);
                }
                self.cursors
                    .retain(|_, value| self.snapshots.contains_key(&value.snapshot));
            }
            ensure!(
                self.snapshots.len() < MAX_SNAPSHOTS,
                "THREAD_WORKSPACE_LOOKUP_CAPACITY"
            );
            let mut names = Vec::new();
            let stamp = projects.directory_metadata()?.modified()?;
            let inventory = projects.visit_entry_names_bounded(MAX_PROJECTS, |name| {
                names.push(name.to_owned());
                Ok(())
            });
            if inventory
                .as_ref()
                .is_err_and(PrivateDirectory::is_entry_budget_exhausted)
            {
                return Ok(result(params.thread_id, Vec::new(), 1, 0, None));
            }
            inventory?;
            ensure!(
                projects.directory_metadata()?.modified()? == stamp,
                "THREAD_WORKSPACE_LOOKUP_CURSOR_STALE"
            );
            names.sort();
            let id = uuid::Uuid::new_v4().to_string();
            self.snapshots.insert(
                id.clone(),
                Snapshot {
                    thread: params.thread_id.clone(),
                    names,
                    stamp,
                    projects_identity: identity.clone(),
                    born: Instant::now(),
                    issues: BTreeSet::new(),
                    complete: false,
                },
            );
            (id, 0)
        };
        let snapshot = self
            .snapshots
            .get(&snapshot_id)
            .context("THREAD_WORKSPACE_LOOKUP_CURSOR_STALE")?;
        ensure!(
            snapshot.thread == params.thread_id
                && snapshot.projects_identity == identity
                && snapshot.stamp == projects.directory_metadata()?.modified()?,
            "THREAD_WORKSPACE_LOOKUP_CURSOR_STALE"
        );
        let end = (offset + params.limit.unwrap_or(64) as usize).min(snapshot.names.len());
        let names = snapshot.names[offset..end].to_vec();
        let mut issues = Vec::new();
        let mut remaining = MAX_PAGE_BYTES;
        let mut candidates = BTreeSet::new();
        let addresses = WorkspaceIdentity::observe_addresses(&self.profile)?;
        for (index, name) in names.iter().enumerate() {
            self.verify(cancel)?;
            match self.project_hint(
                &projects,
                name,
                &params.thread_id,
                &mut remaining,
                cancel,
                &addresses,
            ) {
                Ok(Some(path)) => {
                    candidates.insert(path);
                }
                Ok(None) => {}
                Err(error) if error.to_string() == "THREAD_WORKSPACE_LOOKUP_CANCELLED" => {
                    return Err(error);
                }
                Err(_) => issues.push(offset + index),
            }
        }
        self.verify(cancel)?;
        addresses.verify(&self.profile)?;
        ensure!(
            self.projects()?
                .context("THREAD_WORKSPACE_LOOKUP_PROFILE_CHANGED")?
                .directory_identity()?
                == identity
                && self.snapshots[&snapshot_id].stamp
                    == projects.directory_metadata()?.modified()?,
            "THREAD_WORKSPACE_LOOKUP_CURSOR_STALE"
        );
        self.snapshots
            .get_mut(&snapshot_id)
            .unwrap()
            .issues
            .extend(issues);
        let issue_count = self.snapshots[&snapshot_id].issues.len() as u64;
        let next = if end < self.snapshots[&snapshot_id].names.len() {
            if let Some((token, _)) = self
                .cursors
                .iter()
                .find(|(_, value)| value.snapshot == snapshot_id && value.offset == end)
            {
                Some(token.clone())
            } else {
                ensure!(
                    self.cursors.len() < MAX_CURSORS,
                    "THREAD_WORKSPACE_LOOKUP_CAPACITY"
                );
                let token = uuid::Uuid::new_v4().to_string();
                self.cursors.insert(
                    token.clone(),
                    Cursor {
                        snapshot: snapshot_id,
                        offset: end,
                    },
                );
                Some(token)
            }
        } else {
            self.snapshots.get_mut(&snapshot_id).unwrap().complete = true;
            None
        };
        Ok(result(
            params.thread_id,
            candidates
                .into_iter()
                .map(|workspace_path| ThreadWorkspaceHintV1 { workspace_path })
                .collect(),
            issue_count,
            names.len() as u32,
            next,
        ))
    }
    fn project_hint(
        &self,
        projects: &PrivateDirectory,
        name: &OsStr,
        thread: &str,
        remaining: &mut u64,
        cancel: &CancellationToken,
        addresses: &Arc<WorkspaceAddressReader>,
    ) -> Result<Option<String>> {
        let entry = projects.open_entry_handle(name)?;
        if entry.metadata().is_file() {
            return Ok(None);
        }
        let project = entry.open_child_directory()?;
        let history_name = format!("{thread}.jsonl");
        let history = match project.open_single_link_regular_file(OsStr::new(&history_name)) {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        verify_lookup_directory(&project)?;
        kcoder_config::PortableLeaseIdentity::from_private_regular_handle(&history)?;
        let primary = match project.open_entry_handle(OsStr::new(thread)) {
            Ok(entry) => Some(entry.open_child_directory()?),
            Err(error) if missing(&error) => None,
            Err(error) => return Err(error),
        };
        if let Some(directory) = &primary {
            directory.verify_private_directory()?;
        }
        let primary_file = primary
            .as_ref()
            .map(|directory| directory.open_single_link_regular_file(OsStr::new("state.json")));
        let legacy = format!("{thread}.state.json");
        let (directory, leaf) = match primary_file {
            Some(Ok(_)) => (primary.as_ref().unwrap(), OsStr::new("state.json")),
            Some(Err(error)) if !missing(&error) => return Err(error),
            _ => (&project, OsStr::new(&legacy)),
        };
        let mut file = directory.open_single_link_regular_file(leaf)?;
        kcoder_config::PortableLeaseIdentity::from_private_regular_handle(&file)?;
        let before = file.metadata()?;
        let length = before.len();
        ensure!(
            length <= MAX_METADATA_BYTES && length <= *remaining,
            "THREAD_WORKSPACE_LOOKUP_BYTE_BUDGET"
        );
        *remaining -= length;
        let mut bytes = Vec::new();
        file.by_ref().take(length + 1).read_to_end(&mut bytes)?;
        self.verify(cancel)?;
        let current = directory.open_single_link_regular_file(leaf)?;
        ensure!(
            bytes.len() as u64 == length
                && file.metadata()?.len() == length
                && file.metadata()?.modified()? == before.modified()?
                && kcoder_config::PortableLeaseIdentity::from_private_regular_handle(&file)?
                    == kcoder_config::PortableLeaseIdentity::from_private_regular_handle(&current)?,
            "THREAD_WORKSPACE_LOOKUP_METADATA_CHANGED"
        );
        let history_path = self.path.join("projects").join(name).join(&history_name);
        let prepared = PreparedSessionMetadata::from_sidecar_bytes(
            &history_path,
            &history_path.with_extension("state.json"),
            &bytes,
        )?;
        ensure!(
            !prepared.has_native_subagent_outbox() && prepared.channel_task_source().is_none(),
            "THREAD_WORKSPACE_LOOKUP_VISIBILITY_RESTRICTED"
        );
        let cwd = prepared
            .base_cwd()
            .context("THREAD_WORKSPACE_LOOKUP_WORKSPACE_UNKNOWN")?;
        if history.metadata()?.len() == 0 {
            let storage = project.open_child(OsStr::new("client-sessions"), false)?;
            storage.verify_trusted_config_directory()?;
            let session = storage.open_child(OsStr::new(thread), false)?;
            session.verify_private_directory()?;
            let file =
                session.open_single_link_regular_file(OsStr::new(super::THREAD_METADATA_FILE))?;
            kcoder_config::PortableLeaseIdentity::from_private_regular_handle(&file)?;
            ensure!(
                file.metadata()?.len() <= super::MAX_THREAD_METADATA_BYTES,
                "THREAD_WORKSPACE_LOOKUP_CREATION_INVALID"
            );
            let mut bytes = Vec::new();
            file.take(super::MAX_THREAD_METADATA_BYTES + 1)
                .read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() as u64 <= super::MAX_THREAD_METADATA_BYTES,
                "THREAD_WORKSPACE_LOOKUP_CREATION_INVALID"
            );
            let metadata: super::ThreadClientMetadata = serde_json::from_slice(&bytes)?;
            ensure!(
                metadata.version == 1
                    && metadata.thread_id == thread
                    && super::same_workspace_form(&metadata.workspace, &cwd.to_string_lossy())
                    && metadata
                        .fields
                        .get("permissionModeAtCreation")
                        .is_some_and(Option::is_some),
                "THREAD_WORKSPACE_LOOKUP_CREATION_INVALID"
            );
        }
        ensure!(
            cwd.is_absolute(),
            "THREAD_WORKSPACE_LOOKUP_WORKSPACE_INVALID"
        );
        let paths = kcoder_config::Settings::project_data_dirs_for_read_observed(
            &self.path, addresses, cwd,
        )?;
        ensure!(
            paths.iter().any(|path| path.file_name() == Some(name)),
            "THREAD_WORKSPACE_LOOKUP_WORKSPACE_BINDING_CHANGED"
        );
        let current_cwd = match addresses.lookup(&self.profile, cwd)? {
            Some(
                WorkspaceAddressLookup::Current(location) | WorkspaceAddressLookup::Moved(location),
            ) => {
                location.verify(&self.profile)?;
                location.workspace_path().to_owned()
            }
            None => cwd.to_owned(),
        };
        let text = current_cwd
            .to_str()
            .context("THREAD_WORKSPACE_LOOKUP_WORKSPACE_INVALID")?;
        ensure!(
            !text.is_empty() && text.len() <= 4096 && !text.chars().any(char::is_control),
            "THREAD_WORKSPACE_LOOKUP_WORKSPACE_INVALID"
        );
        Ok(Some(text.to_owned()))
    }
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|value| {
        value
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
fn result(
    thread_id: String,
    candidates: Vec<ThreadWorkspaceHintV1>,
    issues: u64,
    scanned_projects: u32,
    next_cursor: Option<String>,
) -> ThreadWorkspaceLookupResult {
    ThreadWorkspaceLookupResult {
        thread_id,
        candidates,
        issue_count: issues,
        scanned_projects,
        completeness: if issues == 0 && next_cursor.is_none() {
            ThreadWorkspaceLookupCompleteness::Complete
        } else {
            ThreadWorkspaceLookupCompleteness::Partial
        },
        next_cursor,
    }
}

#[cfg(test)]
#[path = "workspace_lookup/tests.rs"]
mod tests;
