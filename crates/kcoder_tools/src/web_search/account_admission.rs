//! Native profile admission. Slot files remain in place; only held OS locks confer a lease.
use super::SearchFailure;
use crate::ToolContext;
use kcoder_config::PrivateDirectory;
use kcoder_state::{AppState, AppStateIdentity};
use kcoder_types::web_search::WebSearchErrorKind;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    ffi::OsStr,
    fs::File,
    path::Path,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub const ACTIVE_LIMIT: usize = 4;
pub const QUEUED_LIMIT: usize = 32;
const POLL_INTERVAL: Duration = Duration::from_millis(20);

pub struct AccountPermit {
    _slot: File,
    _directory: Arc<PrivateDirectory>,
}
#[derive(Clone, Copy)]
enum RequestKind {
    Search,
    Page,
}
impl RequestKind {
    fn active_slot(self) -> &'static str {
        match self {
            Self::Search => "active",
            Self::Page => "page-active",
        }
    }
}
struct OwnerQueue {
    identity: AppStateIdentity,
    tickets: VecDeque<u64>,
}
#[derive(Default)]
struct FairQueue {
    next: u64,
    owners: VecDeque<OwnerQueue>,
}
impl FairQueue {
    fn register(&mut self, state: &AppState) -> Result<u64, SearchFailure> {
        let ticket = self.next;
        self.next = self.next.checked_add(1).ok_or_else(overloaded)?;
        if let Some(owner) = self
            .owners
            .iter_mut()
            .find(|owner| owner.identity.matches(state))
        {
            owner.tickets.push_back(ticket);
        } else {
            self.owners.push_back(OwnerQueue {
                identity: state.inspection_identity(),
                tickets: VecDeque::from([ticket]),
            });
        }
        Ok(ticket)
    }
    fn is_front(&self, ticket: u64) -> bool {
        self.owners.front().and_then(|owner| owner.tickets.front()) == Some(&ticket)
    }
    fn remove(&mut self, ticket: u64, rotate: bool) {
        let Some(index) = self
            .owners
            .iter()
            .position(|owner| owner.tickets.contains(&ticket))
        else {
            return;
        };
        let mut owner = self.owners.remove(index).expect("located owner");
        owner.tickets.retain(|value| *value != ticket);
        if !owner.tickets.is_empty() {
            if rotate {
                self.owners.push_back(owner);
            } else {
                self.owners.insert(index, owner);
            }
        }
    }
}
type SharedQueue = Arc<Mutex<FairQueue>>;
fn local_queue(identity: String) -> SharedQueue {
    static QUEUES: OnceLock<Mutex<HashMap<String, Weak<Mutex<FairQueue>>>>> = OnceLock::new();
    let mut queues = QUEUES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    queues.retain(|_, queue| queue.strong_count() > 0);
    if let Some(queue) = queues.get(&identity).and_then(Weak::upgrade) {
        return queue;
    }
    let queue = Arc::new(Mutex::new(FairQueue::default()));
    queues.insert(identity, Arc::downgrade(&queue));
    queue
}
struct Waiting {
    queue: SharedQueue,
    ticket: u64,
    _lease: File,
}
impl Drop for Waiting {
    fn drop(&mut self) {
        self.queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(self.ticket, false);
    }
}
fn unavailable() -> SearchFailure {
    SearchFailure::new(
        WebSearchErrorKind::PolicyDenied,
        "Native web admission storage is unavailable or unsafe",
        false,
    )
}
fn overloaded() -> SearchFailure {
    SearchFailure::new(
        WebSearchErrorKind::RateLimited,
        "Web request capacity is reached",
        false,
    )
}
fn interrupted(kind: WebSearchErrorKind) -> SearchFailure {
    SearchFailure::new(kind, "Web admission was stopped before dispatch", false)
}
fn directory(settings: &Path) -> Result<Arc<PrivateDirectory>, SearchFailure> {
    if !settings.is_absolute()
        || settings
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(unavailable());
    }
    let parent = settings.parent().ok_or_else(unavailable)?;
    let filename = settings.file_name().ok_or_else(unavailable)?;
    let root = match PrivateDirectory::open_existing(parent) {
        Ok(root) => root,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            PrivateDirectory::open_or_create(parent).map_err(|_| unavailable())?
        }
        Err(_) => return Err(unavailable()),
    };
    root.verify_trusted_config_directory()
        .map_err(|_| unavailable())?;
    let admission = root
        .open_child(OsStr::new("web-search-admission-v1"), true)
        .map_err(|_| unavailable())?;
    admission
        .verify_private_directory()
        .map_err(|_| unavailable())?;
    let key = format!("{:x}", Sha256::digest(filename.as_encoded_bytes()));
    let profile = admission
        .open_child(OsStr::new(&key), true)
        .map_err(|_| unavailable())?;
    profile
        .verify_private_directory()
        .map_err(|_| unavailable())?;
    Ok(Arc::new(profile))
}
fn slot(
    directory: &PrivateDirectory,
    kind: &str,
    limit: usize,
) -> Result<Option<File>, SearchFailure> {
    for index in 0..limit {
        if let Some(file) = directory
            .try_exclusive_lock(OsStr::new(&format!("{kind}-{index}.lock")))
            .map_err(|_| unavailable())?
        {
            return Ok(Some(file));
        }
    }
    Ok(None)
}

/// None means the host supplied no profile authority; the caller retains its workspace gate.
/// No account path is inferred from HOME, environment, model input, or a session workspace.
pub async fn acquire(
    ctx: &ToolContext,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<Option<AccountPermit>, SearchFailure> {
    acquire_kind(ctx, cancel, deadline, RequestKind::Search).await
}

async fn acquire_kind(
    ctx: &ToolContext,
    cancel: &CancellationToken,
    deadline: Instant,
    kind: RequestKind,
) -> Result<Option<AccountPermit>, SearchFailure> {
    if cancel.is_cancelled() {
        return Err(interrupted(WebSearchErrorKind::Cancelled));
    }
    let Some(settings) = ctx.settings_persistence_path.as_deref() else {
        return Ok(None);
    };
    if deadline <= Instant::now() {
        return Err(interrupted(WebSearchErrorKind::Timeout));
    }
    let directory = directory(settings)?;
    let queue = local_queue(format!(
        "{}:{}",
        directory.directory_identity().map_err(|_| unavailable())?,
        kind.active_slot()
    ));
    let lease = slot(&directory, "queued", QUEUED_LIMIT)?;
    // Ready capacity does not need a waiting slot. A saturated search queue
    // must not prevent an independent page read from using available capacity.
    {
        let queue = queue.lock().unwrap_or_else(|p| p.into_inner());
        if queue.owners.is_empty()
            && let Some(file) = slot(&directory, kind.active_slot(), ACTIVE_LIMIT)?
        {
            if cancel.is_cancelled() {
                return Err(interrupted(WebSearchErrorKind::Cancelled));
            }
            return Ok(Some(AccountPermit {
                _slot: file,
                _directory: directory,
            }));
        }
    }
    let lease = lease.ok_or_else(overloaded)?;
    let ticket = queue
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .register(&ctx.state)?;
    let waiting = Waiting {
        queue,
        ticket,
        _lease: lease,
    };
    loop {
        if cancel.is_cancelled() {
            return Err(interrupted(WebSearchErrorKind::Cancelled));
        }
        if deadline <= Instant::now() {
            return Err(interrupted(WebSearchErrorKind::Timeout));
        }
        {
            let mut queue = waiting.queue.lock().unwrap_or_else(|p| p.into_inner());
            if queue.is_front(waiting.ticket)
                && let Some(file) = slot(&directory, kind.active_slot(), ACTIVE_LIMIT)?
            {
                if cancel.is_cancelled() {
                    return Err(interrupted(WebSearchErrorKind::Cancelled));
                }
                queue.remove(waiting.ticket, true);
                drop(queue);
                drop(waiting);
                return Ok(Some(AccountPermit {
                    _slot: file,
                    _directory: directory,
                }));
            }
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(interrupted(WebSearchErrorKind::Cancelled)),
            _ = tokio::time::sleep_until(deadline) => return Err(interrupted(WebSearchErrorKind::Timeout)),
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
        }
    }
}

pub(crate) struct PagePermit {
    _account: Option<AccountPermit>,
    _fallback: Option<tokio::sync::OwnedSemaphorePermit>,
}
struct FallbackQueue<'a>(&'a std::sync::atomic::AtomicUsize);
impl Drop for FallbackQueue<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
pub(crate) async fn acquire_page(
    ctx: &ToolContext,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PagePermit, crate::ToolError> {
    let map_error = |error: SearchFailure| match error.kind {
        WebSearchErrorKind::Cancelled => crate::ToolError::Aborted,
        _ => crate::ToolError::Execution(error.message),
    };
    if let Some(account) = acquire_kind(ctx, cancel, deadline, RequestKind::Page)
        .await
        .map_err(map_error)?
    {
        return Ok(PagePermit {
            _account: Some(account),
            _fallback: None,
        });
    }
    // SDK contexts without native profile authority still have a bounded
    // process-local gate; never derive another account's path from HOME.
    static ACTIVE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    static QUEUED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let active = ACTIVE
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(ACTIVE_LIMIT)))
        .clone();
    let permit = match active.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            QUEUED
                .fetch_update(
                    std::sync::atomic::Ordering::AcqRel,
                    std::sync::atomic::Ordering::Acquire,
                    |n| (n < QUEUED_LIMIT).then_some(n + 1),
                )
                .map_err(|_| map_error(overloaded()))?;
            let _queued = FallbackQueue(&QUEUED);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(crate::ToolError::Aborted),
                result = tokio::time::timeout_at(deadline, active.acquire_owned()) => {
                    result.map_err(|_| map_error(interrupted(WebSearchErrorKind::Timeout)))?
                        .map_err(|_| map_error(unavailable()))?
                }
            }
        }
    };
    Ok(PagePermit {
        _account: None,
        _fallback: Some(permit),
    })
}

#[cfg(test)]
#[path = "account_admission_tests.rs"]
mod tests;
