//! Native Source-to-host requests with held roots/image and same-connection replies.
use crate::native_component_parent::NativeComponentParentAuthority;
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_native_scope::service_identity::remote_installation::{file_identity, program_pin};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::File,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

pub const NATIVE_HOST_REPLY_ID_PREFIX: &str = "native-remote-host-";
const MAX_PENDING: usize = 8;
const MAX_REQUESTS: u64 = 4096;
const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
type Pending = Arc<Mutex<BTreeMap<String, oneshot::Sender<Value>>>>;

/// This holds only the original host byte lane. It cannot create a Source
/// Accepted/budget owner, approve a receiver or deserialize Native authority.
pub struct NativeRemoteHostClient {
    parent: Arc<dyn NativeComponentParentAuthority>,
    profile: PrivateDirectory,
    profile_path: PathBuf,
    workspace: PrivateDirectory,
    workspace_path: PathBuf,
    own_image: File,
    own_path: PathBuf,
    own_pin: (String, String),
    outgoing: mpsc::Sender<Value>,
    pending: Pending,
    next_id: AtomicU64,
    namespace: String,
    closed: CancellationToken,
}
impl std::fmt::Debug for NativeRemoteHostClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NativeRemoteHostClient { private_connection }")
    }
}

pub struct NativeRemoteHostConnectionGuard(Arc<NativeRemoteHostClient>);
impl Drop for NativeRemoteHostConnectionGuard {
    fn drop(&mut self) {
        self.0.close();
    }
}
impl NativeRemoteHostClient {
    /// Ordinary sessions must not hash a large executable for a disabled lane.
    /// Only the private profile's explicit SSH peer configuration requests it.
    pub fn capture_if_configured(
        parent: Arc<dyn NativeComponentParentAuthority>,
        settings_path: &dyn Fn() -> Option<PathBuf>,
        workspace_path: &dyn Fn() -> PathBuf,
        outgoing: mpsc::Sender<Value>,
    ) -> Result<Option<Arc<Self>>> {
        let path = settings_path().context("REMOTE_HOST_PROFILE_REQUIRED")?;
        let profile = PrivateDirectory::open_existing(
            path.parent().context("REMOTE_HOST_PROFILE_REQUIRED")?,
        )?;
        profile.verify_private_directory()?;
        let snapshot = match profile.read_source_document_snapshot(
            std::ffi::OsStr::new("settings.json"),
            8 * 1024 * 1024,
            || profile.verify_private_directory().is_ok(),
        ) {
            Ok(snapshot) => snapshot,
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let settings = kcoder_config::integrations::remotes::RemoteIntegrationSettings::from_native_profile_snapshot(snapshot.bytes())?;
        if !settings.enabled || !settings.native_ssh_peers.iter().any(|peer| peer.enabled) {
            return Ok(None);
        }
        Self::capture_after_verified_parent(parent, settings_path, workspace_path, outgoing)
            .map(Some)
    }
    pub fn connection_guard(self: &Arc<Self>) -> NativeRemoteHostConnectionGuard {
        NativeRemoteHostConnectionGuard(self.clone())
    }
    /// Only the connection root passes its original actual capture and private
    /// outbound lane. A source-management permit or a JSON parent cannot call it.
    pub fn capture_after_verified_parent(
        parent: Arc<dyn NativeComponentParentAuthority>,
        settings_path: &dyn Fn() -> Option<PathBuf>,
        workspace_path: &dyn Fn() -> PathBuf,
        outgoing: mpsc::Sender<Value>,
    ) -> Result<Arc<Self>> {
        let path = settings_path().context("REMOTE_HOST_PROFILE_REQUIRED")?;
        let profile_path = path
            .parent()
            .context("REMOTE_HOST_PROFILE_REQUIRED")?
            .to_owned();
        let profile = PrivateDirectory::open_existing(&profile_path)?;
        profile.verify_private_directory()?;
        let workspace_path = workspace_path().canonicalize()?;
        let workspace = PrivateDirectory::open_existing(&workspace_path)?;
        parent.verify_native_component_roots(&profile, &workspace)?;
        let own_path = std::env::current_exe()?;
        #[cfg(target_os = "linux")]
        let own_image = File::open("/proc/self/exe")?;
        #[cfg(windows)]
        let own_image = {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            };
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&own_path)?
        };
        #[cfg(not(any(target_os = "linux", windows)))]
        let own_image = File::open(&own_path)?;
        let own_pin = program_pin(&own_image)?;
        let value = Arc::new(Self {
            parent,
            profile,
            profile_path,
            workspace,
            workspace_path,
            own_image,
            own_path,
            own_pin,
            outgoing,
            pending: Arc::default(),
            next_id: AtomicU64::new(1),
            namespace: format!(
                "{NATIVE_HOST_REPLY_ID_PREFIX}{}-",
                uuid::Uuid::new_v4().simple()
            ),
            closed: CancellationToken::new(),
        });
        value.verify_owner()?;
        Ok(value)
    }
    pub fn verify_owner(&self) -> Result<()> {
        ensure!(!self.closed.is_cancelled(), "REMOTE_HOST_CONNECTION_CLOSED");
        self.parent
            .verify_native_component_roots(&self.profile, &self.workspace)?;
        ensure!(
            PrivateDirectory::open_existing(&self.profile_path)?.directory_identity()?
                == self.profile.directory_identity()?
                && PrivateDirectory::open_existing(&self.workspace_path)?.directory_identity()?
                    == self.workspace.directory_identity()?,
            "REMOTE_HOST_ROOT_OWNER_CHANGED"
        );
        ensure!(
            file_identity(&self.own_image)? == self.own_pin.0
                && file_identity(&File::open(&self.own_path)?)? == self.own_pin.0,
            "REMOTE_HOST_SOURCE_IMAGE_CHANGED"
        );
        Ok(())
    }
    /// Route before ordinary interaction replies. Gateway must reject this ID
    /// namespace from every ordinary client, including response-only frames.
    pub fn route_response(&self, frame: &Value) -> bool {
        let Some(id) = frame
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| id.starts_with(NATIVE_HOST_REPLY_ID_PREFIX))
        else {
            return false;
        };
        if !id.starts_with(&self.namespace) || frame.get("method").is_some() {
            return true;
        }
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
        let Some(sender) = sender else {
            return true;
        };
        let valid = self.verify_owner().is_ok()
            && frame.is_object()
            && frame["jsonrpc"] == "2.0"
            && (frame.get("result").is_some() ^ frame.get("error").is_some())
            && serde_json::to_vec(frame).is_ok_and(|bytes| bytes.len() <= MAX_FRAME_BYTES);
        if valid {
            let _ = sender.send(frame.clone());
        }
        true
    }
    #[cfg(feature = "test-oracle")]
    pub fn pending_is_empty_for_test(&self) -> bool {
        self.pending.lock().unwrap().is_empty()
    }

    pub fn close(&self) {
        self.closed.cancel();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }
    /// Internal transport only. The accepted-turn binder retains the actual
    /// Source budget/operation and performs its own checks around this request.
    pub async fn request(
        &self,
        method: NativeHostMethod,
        params: Value,
        deadline: tokio::time::Instant,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.verify_owner()?;
        ensure!(
            tokio::time::Instant::now() < deadline,
            "REMOTE_HOST_ORIGINAL_DEADLINE_EXPIRED"
        );
        let number = self.next_id.fetch_add(1, Ordering::Relaxed);
        ensure!(number <= MAX_REQUESTS, "REMOTE_HOST_REQUEST_CAPACITY");
        let id = format!("{}{number}", self.namespace);
        let frame = json!({"jsonrpc":"2.0","id":id,"method":method.wire_name(),"params":params});
        ensure!(
            serde_json::to_vec(&frame)?.len() <= MAX_FRAME_BYTES,
            "REMOTE_HOST_FRAME_TOO_LARGE"
        );
        let (send, receive) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            ensure!(pending.len() < MAX_PENDING, "REMOTE_HOST_PENDING_CAPACITY");
            pending.insert(id.clone(), send);
        }
        let _registration = PendingRequest {
            pending: self.pending.clone(),
            id,
        };
        let exchange = async {
            self.verify_owner()?;
            self.outgoing
                .send(frame)
                .await
                .context("REMOTE_HOST_OUTCOME_REQUIRES_ORIGINAL_READ")?;
            let response = receive
                .await
                .context("REMOTE_HOST_OUTCOME_REQUIRES_ORIGINAL_READ")?;
            self.verify_owner()?;
            ensure!(
                response.get("error").is_none(),
                "REMOTE_HOST_OUTCOME_REQUIRES_ORIGINAL_READ"
            );
            response
                .get("result")
                .cloned()
                .context("REMOTE_HOST_INVALID_RECEIPT")
        };
        tokio::select! {
            biased;
            _ = self.closed.cancelled() => anyhow::bail!("REMOTE_HOST_OUTCOME_REQUIRES_ORIGINAL_READ"),
            _ = cancel.cancelled() => anyhow::bail!("REMOTE_HOST_OUTCOME_REQUIRES_ORIGINAL_READ"),
            _ = tokio::time::sleep_until(deadline) => anyhow::bail!("REMOTE_HOST_OUTCOME_REQUIRES_ORIGINAL_READ"),
            result = exchange => result,
        }
    }
}
impl Drop for NativeRemoteHostClient {
    fn drop(&mut self) {
        self.close();
    }
}
#[derive(Clone, Copy)]
pub enum NativeHostMethod {
    ReadOriginal,
    Open,
    Exchange,
    Close,
}
impl NativeHostMethod {
    fn wire_name(self) -> &'static str {
        match self {
            Self::ReadOriginal => "server/nativeRemote/readOriginal",
            Self::Open => "server/nativeRemote/open",
            Self::Exchange => "server/nativeRemote/exchange",
            Self::Close => "server/nativeRemote/close",
        }
    }
}
struct PendingRequest {
    pending: Pending,
    id: String,
}
impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.id);
    }
}
