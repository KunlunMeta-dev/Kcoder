//! Session-owner cache and temporary response files; never a process-global URL cache.
use crate::{ToolError, web_content::PageContent};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
const TTL: Duration = Duration::from_secs(15 * 60);
const MAX_ENTRIES: usize = 128;
const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct CachedPage {
    pub final_url: String,
    pub status: reqwest::StatusCode,
    pub content_type: String,
    pub bytes: usize,
    pub retrieved_at: String,
    pub content: PageContent,
    pub inserted: Instant,
    touched: Instant,
}
impl CachedPage {
    fn size(&self) -> usize {
        self.content.markdown.len()
            + self.content.title.len()
            + self.final_url.len()
            + self.content_type.len()
            + self.retrieved_at.len()
    }
    pub(crate) fn new(
        final_url: String,
        status: reqwest::StatusCode,
        content_type: String,
        bytes: usize,
        retrieved_at: String,
        content: PageContent,
    ) -> Self {
        Self {
            final_url,
            status,
            content_type,
            bytes,
            retrieved_at,
            content,
            inserted: Instant::now(),
            touched: Instant::now(),
        }
    }
}
#[derive(Default)]
pub(crate) struct WebResources {
    owner: Option<kcoder_state::AppStateLifecycleIdentity>,
    cache: Mutex<HashMap<String, CachedPage>>,
    temporary: Mutex<TemporaryFiles>,
}
#[derive(Default)]
struct TemporaryFiles {
    directory: Option<kcoder_config::PrivateTempDir>,
    bytes: usize,
    entries: usize,
}
impl WebResources {
    pub(crate) fn new(state: &kcoder_state::AppState) -> Self {
        Self {
            owner: Some(state.inspection_lifecycle_identity()),
            ..Self::default()
        }
    }
    /// Return the original native owner, never a fresh binding from mutable State.
    pub(crate) fn lifecycle_owner(
        &self,
        state: &kcoder_state::AppState,
    ) -> Result<kcoder_state::AppStateLifecycleIdentity, ToolError> {
        self.check_owner(state)?;
        self.owner.clone().ok_or_else(|| {
            ToolError::Execution("Search requires an original native web response owner".into())
        })
    }

    pub(crate) fn check_owner(&self, state: &kcoder_state::AppState) -> Result<(), ToolError> {
        if self.owner.as_ref().is_none_or(|owner| owner.matches(state)) {
            Ok(())
        } else {
            Err(ToolError::Execution(
                "The web response owner does not match the current session".into(),
            ))
        }
    }

    pub(crate) fn cached(&self, key: &str) -> Option<CachedPage> {
        let mut cache = self.cache.lock().ok()?;
        let now = Instant::now();
        cache.retain(|_, v| now.duration_since(v.inserted) <= TTL);
        let entry = cache.get_mut(key)?;
        entry.touched = now;
        Some(entry.clone())
    }
    pub(crate) fn store(&self, key: String, page: CachedPage) {
        if !matches!(page.content.state, "read" | "partial")
            || !page.status.is_success()
            || page.size() > MAX_BYTES
        {
            return;
        }
        let Ok(mut cache) = self.cache.lock() else {
            return;
        };
        let now = Instant::now();
        cache.retain(|_, v| now.duration_since(v.inserted) <= TTL);
        cache.remove(&key);
        while cache.len() >= MAX_ENTRIES
            || cache.values().map(CachedPage::size).sum::<usize>() + page.size() > MAX_BYTES
        {
            let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, v)| v.touched)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            cache.remove(&oldest);
        }
        cache.insert(key, page);
    }
    pub(crate) fn persist(&self, bytes: &[u8], extension: &str) -> Result<PathBuf, ToolError> {
        let mut temp = self
            .temporary
            .lock()
            .map_err(|_| ToolError::Execution("The response owner is unavailable".into()))?;
        if temp.entries >= MAX_ENTRIES || temp.bytes.saturating_add(bytes.len()) > MAX_BYTES {
            return Err(ToolError::Execution(
                "The session binary response storage limit has been reached".into(),
            ));
        }
        if temp.directory.is_none() {
            temp.directory = Some(
                kcoder_config::create_private_temp_dir("kcoder-web-content").map_err(|_| {
                    ToolError::Execution(
                        "The private response directory could not be created".into(),
                    )
                })?,
            );
        }
        let path = temp.directory.as_ref().unwrap().path().join(format!(
            "{}.{}",
            uuid::Uuid::new_v4(),
            extension
        ));
        let directory = kcoder_config::PrivateDirectory::open_or_create(path.parent().unwrap())
            .map_err(|_| {
                ToolError::Execution("The private response directory is unavailable".into())
            })?;
        directory
            .atomic_publish_from_reader(
                path.file_name().unwrap(),
                &mut std::io::Cursor::new(bytes),
                false,
                || Ok(None),
            )
            .map_err(|_| ToolError::Execution("The binary response could not be saved".into()))?;
        temp.bytes += bytes.len();
        temp.entries += 1;
        Ok(path)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn page(text: &str) -> CachedPage {
        CachedPage::new(
            "https://example.com".into(),
            reqwest::StatusCode::OK,
            "text/plain".into(),
            text.len(),
            "2026-10-31T00:00:00Z".into(),
            PageContent {
                title: String::new(),
                markdown: text.into(),
                state: "read",
                truncated: false,
                encoding: "UTF-8".into(),
            },
        )
    }
    #[test]
    fn owner_isolated_bounded_lru_and_expiring() {
        let owner = WebResources::default();
        let peer = WebResources::default();
        owner.store("private".into(), page("owner"));
        assert!(peer.cached("private").is_none());
        for i in 0..MAX_ENTRIES {
            owner.store(i.to_string(), page("x"));
        }
        assert!(owner.cached("private").is_none());
        assert_eq!(owner.cache.lock().unwrap().len(), MAX_ENTRIES);
        owner.cached("0");
        owner.store("next".into(), page("x"));
        assert!(owner.cached("0").is_some());
        assert!(owner.cached("1").is_none());
        let mut old = page("expired");
        old.inserted = Instant::now() - TTL - Duration::from_secs(1);
        owner.store("expired".into(), old);
        assert!(owner.cached("expired").is_none());
    }
    #[test]
    fn binary_files_are_private_and_cleaned_only_with_their_owner() {
        let owner = WebResources::default();
        let peer = WebResources::default();
        let path = owner.persist(b"pdf", "pdf").unwrap();
        let peerpath = peer.persist(b"peer", "bin").unwrap();
        assert!(path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(owner);
        assert!(!path.exists());
        assert!(peerpath.exists());
        drop(peer);
        assert!(!peerpath.exists());
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::{
        ToolContext,
        web_network::{WebNetworkAuthority, WebSessionResources},
    };
    #[test]
    fn switching_the_state_session_rotates_resources_without_deleting_a_live_previous_owner() {
        let root = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(root.path());
        let shared = WebSessionResources::new(&state);
        let previous = ToolContext::new(state.clone()).with_web_session_resources(shared.clone());
        let old_path = previous.web_resources.persist(b"previous", "bin").unwrap();
        let authority = WebNetworkAuthority::new(&state);
        authority
            .grant_origin("http://127.0.0.1:1234", Duration::from_secs(60))
            .unwrap();
        state.start_new_session().unwrap();
        let current = ToolContext::new(state).with_web_session_resources(shared);
        let current_path = current.web_resources.persist(b"current", "bin").unwrap();
        assert!(old_path.exists());
        assert_ne!(old_path.parent(), current_path.parent());
        assert!(previous.web_resources.check_owner(&current.state).is_err());
        drop(previous);
        assert!(!old_path.exists());
        assert!(current_path.exists());
    }
}
