//! Current-source verification over an owned local Native carrier, never a queue-label allow verdict.
use super::*;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
#[path = "endpoint/admission.rs"]
mod admission;
use super::target_admission::TargetAdmissionRequest;
pub(crate) use admission::admit_peer_target;

const MAX_FRAME: usize = 128 * 1024;
const IO_BUDGET: Duration = Duration::from_millis(750);
const ADMISSION_IO_BUDGET: Duration = Duration::from_secs(5);
/// Only a kernel-confirmed missing local carrier permits a separate cold-source check.
#[derive(Debug)]
pub(crate) struct OriginalSourceUnavailable;
impl std::fmt::Display for OriginalSourceUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("peer_source_endpoint_absent")
    }
}
impl std::error::Error for OriginalSourceUnavailable {}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u32,
    source: SessionAddressV1,
    nonce: String,
    query: Option<OriginalSourceCheck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    admission: Option<TargetAdmissionRequest>,
    #[serde(default, skip_serializing_if = "is_false")]
    capabilities: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}
impl Request {
    fn validate(&self, expected: &SessionAddressV1) -> Result<()> {
        ensure!(
            self.version == 1
                && &self.source == expected
                && valid_agent_message_id(&self.nonce)
                && !(self.query.is_some() && self.admission.is_some()),
            // Capability probes never combine with an operation or admission.
            "peer_source_request_invalid"
        );
        ensure!(
            !self.capabilities || (self.query.is_none() && self.admission.is_none()),
            "peer_source_request_invalid"
        );
        if let Some(admission) = &self.admission {
            admission.validate()?;
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Response {
    version: u32,
    source: SessionAddressV1,
    nonce: String,
    operation: Option<PeerRouterOperationV1>,
    status: Option<kcoder_app_protocol::cross_session_messages::AgentMessageTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receipt: Option<AgentMessageReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capabilities: Option<Vec<String>>,
    unavailable: bool,
}
async fn source_response(
    owner: Arc<RwLock<Arc<BoundPeerSource>>>,
    expected: SessionAddressV1,
    request: Request,
) -> Result<Response> {
    request.validate(&expected)?;
    let original = owner
        .read()
        .map_err(|_| anyhow::anyhow!("peer_source_busy"))?
        .clone();
    let checked = original.clone();
    let mut capabilities = None;
    let (operation, status, receipt) = if request.capabilities {
        capabilities = Some(
            tokio::task::spawn_blocking(move || checked.service().message_capabilities())
                .await??
                .capabilities,
        );
        (None, None, None)
    } else if let Some(admission) = request.admission {
        (None, None, Some(checked.admit_target(admission).await?))
    } else if let Some(query) = request.query {
        (
            tokio::task::spawn_blocking(move || checked.check_original(&query))
                .await
                .ok()
                .and_then(Result::ok),
            None,
            None,
        )
    } else {
        (
            None,
            tokio::task::spawn_blocking(move || checked.observe_status())
                .await
                .ok()
                .and_then(Result::ok),
            None,
        )
    };
    let current = {
        let slot = owner
            .read()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?;
        Arc::ptr_eq(&original, &*slot)
    };
    ensure!(
        current && original.check_owner().is_ok(),
        "peer_source_handoff_generation_changed"
    );
    Ok(Response {
        version: 1,
        source: expected,
        nonce: request.nonce,
        unavailable: operation.is_none()
            && status.is_none()
            && receipt.is_none()
            && capabilities.is_none(),
        operation,
        status,
        receipt,
        capabilities,
    })
}

pub(crate) struct PeerSourceEndpoint {
    source: Arc<RwLock<Arc<BoundPeerSource>>>,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    _registration: super::registry::Registration,
}
impl Drop for PeerSourceEndpoint {
    fn drop(&mut self) {
        if let Ok(source) = self.source.read() {
            source.revoke();
        }
        self.cancel.cancel();
        self.task.abort();
    }
}
impl PeerSourceEndpoint {
    pub(crate) fn bind(source: Arc<BoundPeerSource>) -> Result<Self> {
        #[cfg(target_os = "linux")]
        {
            linux::bind(source)
        }
        #[cfg(windows)]
        {
            windows::bind(source)
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = source;
            anyhow::bail!("peer_source_native_carrier_unavailable")
        }
    }
    pub(crate) fn source(&self) -> Result<Arc<BoundPeerSource>> {
        Ok(self
            .source
            .read()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?
            .clone())
    }
    pub(crate) fn refresh(
        &self,
        engine: &QueryEngine,
        lease: NativeSessionLeaseWitness,
    ) -> Result<()> {
        let old = self.source()?;
        // Close the old allow path before inspecting replacement settings.
        // Immutable admission facts are copied only after exact owner checks.
        old.active.store(false, Ordering::Release);
        let new = match BoundPeerSource::capture(engine, old.service().clone(), lease) {
            Ok(new) => new,
            Err(error) => {
                old.revoke();
                return Err(error);
            }
        };
        if let Err(error) = old.transfer_facts(&new) {
            old.revoke();
            new.revoke();
            return Err(error);
        }
        let mut slot = self
            .source
            .write()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?;
        ensure!(
            Arc::ptr_eq(&old, &*slot),
            "peer_source_handoff_generation_changed"
        );
        old.revoke();
        *slot = new.clone();
        if let Err(error) = new.service().register_live_source(new.clone()) {
            new.revoke();
            return Err(error);
        }
        Ok(())
    }
    pub(super) fn replace_bound_source(&self, new: Arc<BoundPeerSource>) -> Result<()> {
        let old = self.source()?;
        ensure!(
            old.address_identity == new.address_identity,
            "peer_source_handoff_address_changed"
        );
        old.transfer_facts(&new)?;
        let mut slot = self
            .source
            .write()
            .map_err(|_| anyhow::anyhow!("peer_source_busy"))?;
        ensure!(
            Arc::ptr_eq(&old, &*slot),
            "peer_source_handoff_generation_changed"
        );
        old.revoke();
        *slot = new.clone();
        if let Err(error) = new.service().register_live_source(new.clone()) {
            new.revoke();
            return Err(error);
        }
        Ok(())
    }
    pub(crate) async fn close(mut self) {
        if let Ok(source) = self.source.read() {
            source.revoke();
        }
        self.cancel.cancel();
        let task = std::mem::replace(&mut self.task, tokio::spawn(async {}));
        let _ = task.await;
    }
}

/// Call only on an owned blocking worker. This performs no writes, model calls or replay.
pub(crate) fn check_original_source(
    service: &PeerMessageService,
    source: &SessionAddressV1,
    query: &OriginalSourceCheck,
) -> Result<PeerRouterOperationV1> {
    service.require_enabled(false)?;
    ensure!(
        service.identity()?.contains(source),
        "peer_source_remote_route_required"
    );
    query.validate()?;
    if let Some(live) = service.local_source(source)? {
        let authority = service.authority()?;
        let operation = authority
            .store()?
            .find_source_operation(
                source,
                &kcoder_app_protocol::cross_session_messages::AgentMessageGetParams {
                    message_id: None,
                    client_message_id: Some(query.client_message_id.clone()),
                },
            )?
            .context("peer_source_original_operation_unavailable")?;
        let claims = &operation.attestation.claims;
        ensure!(
            claims.source_address == *source
                && claims.destination == query.destination
                && claims.client_message_id == query.client_message_id
                && claims.mode == query.mode
                && claims.expected_turn_id == query.expected_turn_id
                && claims.body_sha256 == query.body_sha256,
            "peer_source_original_operation_changed"
        );
        let verified = live.verify_original(claims)?;
        ensure!(
            verified.attestation == operation.attestation,
            "peer_source_original_operation_changed"
        );
        service.require_enabled(false)?;
        return Ok(verified);
    }
    #[cfg(target_os = "linux")]
    {
        let operation = linux::check(source, query)?;
        crate::app_server::session_messages::router_store::verify_peer_attestation(
            &operation.attestation,
            &service.identity()?,
        )?;
        service.require_enabled(false)?;
        Ok(operation)
    }
    #[cfg(windows)]
    {
        let operation = windows::check(source, query)?;
        crate::app_server::session_messages::router_store::verify_peer_attestation(
            &operation.attestation,
            &service.identity()?,
        )?;
        service.require_enabled(false)?;
        Ok(operation)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (source, query);
        anyhow::bail!("peer_source_native_carrier_unavailable")
    }
}
pub(crate) fn read_peer_status(
    service: &PeerMessageService,
    source: &SessionAddressV1,
) -> Result<kcoder_app_protocol::cross_session_messages::AgentMessageTarget> {
    service.require_enabled(false)?;
    ensure!(
        service.identity()?.contains(source),
        "peer_source_remote_route_required"
    );
    #[cfg(any(target_os = "linux", windows))]
    {
        #[cfg(target_os = "linux")]
        let response = linux::exchange(source, None, None)?;
        #[cfg(windows)]
        let response = windows::exchange(source, None, None)?;
        let status = response
            .status
            .context("peer_source_current_observation_unavailable")?;
        ensure!(
            !response.unavailable
                && response.operation.is_none()
                && response.receipt.is_none()
                && response.capabilities.is_none()
                && status.address.as_ref() == Some(source)
                && status.thread_id == source.thread_id,
            "peer_source_current_observation_changed"
        );
        service.require_enabled(false)?;
        Ok(status)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        anyhow::bail!("peer_source_native_carrier_unavailable")
    }
}

/// A read from the actual original Native carrier, never a catalog/version-label inference.
pub(crate) fn read_peer_capabilities(
    service: &PeerMessageService,
    address: &SessionAddressV1,
) -> Result<Vec<String>> {
    service.require_enabled(false)?;
    ensure!(
        service.identity()?.contains(address),
        "peer_source_remote_route_required"
    );
    #[cfg(any(target_os = "linux", windows))]
    {
        #[cfg(target_os = "linux")]
        let response = linux::capability_exchange(address)?;
        #[cfg(windows)]
        let response = windows::capability_exchange(address)?;
        ensure!(
            response.operation.is_none() && response.status.is_none() && response.receipt.is_none(),
            "peer_source_capability_response_invalid"
        );
        let capabilities = response
            .capabilities
            .context("peer_message_reply_support_unconfirmed")?;
        ensure!(
            capabilities.len() <= 32 && capabilities.iter().all(|name| name.len() <= 128),
            "peer_source_capability_response_invalid"
        );
        service.require_enabled(false)?;
        Ok(capabilities)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = address;
        anyhow::bail!("peer_source_native_carrier_unavailable")
    }
}

#[cfg(windows)]
#[path = "endpoint/windows.rs"]
mod windows;

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::{
        fs::File,
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
            linux::net::SocketAddrExt,
            unix::{
                fs::MetadataExt,
                net::{SocketAddr, UnixListener, UnixStream},
            },
        },
    };
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    /// An open executable identity captured once at the host load boundary. Warm
    /// checks compare kernel file identities; they never hash the full executable.
    struct Image {
        file: File,
        device: u64,
        inode: u64,
        uid: u32,
    }
    impl Image {
        fn capture() -> Result<Self> {
            let file = File::open("/proc/self/exe")?;
            let metadata = file.metadata()?;
            Ok(Self {
                file,
                device: metadata.dev(),
                inode: metadata.ino(),
                uid: unsafe { libc::geteuid() },
            })
        }
        fn verify_peer(&self, fd: RawFd) -> Result<()> {
            let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
            let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            ensure!(
                unsafe {
                    libc::getsockopt(
                        fd,
                        libc::SOL_SOCKET,
                        libc::SO_PEERCRED,
                        (&mut credentials as *mut libc::ucred).cast(),
                        &mut length,
                    )
                } == 0
                    && length as usize == std::mem::size_of::<libc::ucred>()
                    && credentials.uid == self.uid
                    && credentials.pid > 0,
                "peer_source_native_peer_unavailable"
            );
            let current = self.file.metadata()?;
            let peer = File::open(format!("/proc/{}/exe", credentials.pid))?.metadata()?;
            ensure!(
                current.dev() == self.device
                    && current.ino() == self.inode
                    && peer.dev() == self.device
                    && peer.ino() == self.inode,
                "peer_source_native_image_changed"
            );
            Ok(())
        }
    }
    fn address(source: &SessionAddressV1) -> Result<SocketAddr> {
        source.validate().map_err(anyhow::Error::msg)?;
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "kcoder.peer-source.endpoint.v1",
                source
            ))?)
        );
        Ok(SocketAddr::from_abstract_name(
            format!("kcoder-peer-v1-{digest}").as_bytes(),
        )?)
    }
    fn connect(source: &SessionAddressV1, budget: Duration) -> Result<UnixStream> {
        let address = address(source)?;
        let name = address
            .as_abstract_name()
            .context("peer_source_address_invalid")?;
        // Nonblocking connect keeps a saturated local accept queue inside the
        // caller's deadline, rather than waiting indefinitely for a dead peer.
        let descriptor = unsafe {
            libc::socket(
                libc::AF_UNIX,
                libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                0,
            )
        };
        ensure!(descriptor >= 0, "peer_source_connect_unavailable");
        let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
        let mut raw: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        raw.sun_family = libc::AF_UNIX as libc::sa_family_t;
        ensure!(name.len() < raw.sun_path.len(), "peer_source_address_limit");
        for (slot, byte) in raw.sun_path.iter_mut().skip(1).zip(name) {
            *slot = *byte as libc::c_char;
        }
        let length =
            (std::mem::offset_of!(libc::sockaddr_un, sun_path) + 1 + name.len()) as libc::socklen_t;
        let connected = unsafe {
            libc::connect(
                descriptor.as_raw_fd(),
                (&raw as *const libc::sockaddr_un).cast(),
                length,
            )
        };
        if connected != 0 {
            let error = std::io::Error::last_os_error();
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOENT | libc::ECONNREFUSED)
            ) {
                return Err(OriginalSourceUnavailable.into());
            }
            ensure!(
                matches!(error.raw_os_error(), Some(libc::EINPROGRESS | libc::EAGAIN)),
                "peer_source_connect_unavailable"
            );
            let mut poll = libc::pollfd {
                fd: descriptor.as_raw_fd(),
                events: libc::POLLOUT,
                revents: 0,
            };
            ensure!(
                unsafe {
                    libc::poll(
                        &mut poll,
                        1,
                        budget.as_millis().min(i32::MAX as u128) as i32,
                    )
                } > 0,
                "peer_source_connect_timeout"
            );
            let mut status: libc::c_int = 0;
            let mut bytes = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
            let observed = unsafe {
                libc::getsockopt(
                    descriptor.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_ERROR,
                    (&mut status as *mut libc::c_int).cast(),
                    &mut bytes,
                )
            };
            ensure!(observed == 0, "peer_source_connect_unavailable");
            if matches!(status, libc::ENOENT | libc::ECONNREFUSED) {
                return Err(OriginalSourceUnavailable.into());
            }
            ensure!(status == 0, "peer_source_connect_unavailable");
        }
        let stream = UnixStream::from(descriptor);
        stream.set_nonblocking(false)?;
        Ok(stream)
    }
    pub(super) fn bind(source: Arc<BoundPeerSource>) -> Result<PeerSourceEndpoint> {
        let runtime =
            tokio::runtime::Handle::try_current().context("peer_source_runtime_required")?;
        let source_address = source.address()?;
        let image = Arc::new(Image::capture()?);
        let listener = UnixListener::bind_addr(&address(&source_address)?)?;
        let registration = super::super::registry::Registration::publish(&source)?;
        source.service().register_live_source(source.clone())?;
        listener.set_nonblocking(true)?;
        let listener = tokio::net::UnixListener::from_std(listener)?;
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let source = Arc::new(RwLock::new(source));
        let owner = source.clone();
        let task = runtime.spawn(async move {
            let mut jobs = tokio::task::JoinSet::new();
            loop {
                tokio::select! {biased;
                    _=stop.cancelled()=>break,
                    _=jobs.join_next(),if !jobs.is_empty()=>{},
                    accepted=listener.accept(),if jobs.len()<8=> {
                        let Ok((stream,_))=accepted else {break};
                        if image.verify_peer(stream.as_raw_fd()).is_err() {continue;}
                        let owner=owner.clone();let expected=source_address.clone();let stop=stop.clone();
                        jobs.spawn(async move {
                            let work=async {
                                let mut reader=tokio::io::BufReader::new(stream);let mut line=Vec::new();
                                (&mut reader).take((MAX_FRAME+1) as u64).read_until(b'\n',&mut line).await?;
                                ensure!(line.len()<=MAX_FRAME && line.last()==Some(&b'\n'),"peer_source_frame_invalid");
                                let request:Request=serde_json::from_slice(&line)?;
                                let response=source_response(owner,expected,request).await?;
                                let mut bytes=serde_json::to_vec(&response)?;ensure!(bytes.len()<MAX_FRAME,"peer_source_response_limit");bytes.push(b'\n');
                                reader.get_mut().write_all(&bytes).await?;
                                Ok::<(),anyhow::Error>(())
                            };
                            tokio::select! {biased;_=stop.cancelled()=>{},_=tokio::time::timeout(ADMISSION_IO_BUDGET,work)=>{}}
                        });
                    }
                }
            }
            jobs.abort_all();
            while jobs.join_next().await.is_some() {}
        });
        Ok(PeerSourceEndpoint {
            source,
            cancel,
            task,
            _registration: registration,
        })
    }
    pub(super) fn check(
        source: &SessionAddressV1,
        query: &OriginalSourceCheck,
    ) -> Result<PeerRouterOperationV1> {
        let response = exchange(source, Some(query), None)?;
        ensure!(
            response.status.is_none() && response.receipt.is_none(),
            "peer_source_response_invalid"
        );
        let operation = response
            .operation
            .context("peer_source_current_authorization_unavailable")?;
        let claims = &operation.attestation.claims;
        ensure!(
            claims.source_address == *source
                && claims.destination == query.destination
                && claims.client_message_id == query.client_message_id
                && claims.mode == query.mode
                && claims.expected_turn_id == query.expected_turn_id
                && claims.body_sha256 == query.body_sha256,
            "peer_source_original_operation_changed"
        );
        Ok(operation)
    }
    pub(super) fn exchange(
        source: &SessionAddressV1,
        query: Option<&OriginalSourceCheck>,
        admission: Option<&TargetAdmissionRequest>,
    ) -> Result<Response> {
        exchange_kind(source, query, admission, false)
    }
    pub(super) fn capability_exchange(source: &SessionAddressV1) -> Result<Response> {
        exchange_kind(source, None, None, true)
    }
    fn exchange_kind(
        source: &SessionAddressV1,
        query: Option<&OriginalSourceCheck>,
        admission: Option<&TargetAdmissionRequest>,
        capabilities: bool,
    ) -> Result<Response> {
        let image = Image::capture()?;
        let budget = if admission.is_some() {
            ADMISSION_IO_BUDGET
        } else {
            IO_BUDGET
        };
        let deadline = std::time::Instant::now() + budget;
        let mut stream = connect(source, budget)?;
        stream.set_read_timeout(Some(budget))?;
        stream.set_write_timeout(Some(budget))?;
        image.verify_peer(stream.as_raw_fd())?;
        let nonce = uuid::Uuid::new_v4().to_string();
        let request = Request {
            version: 1,
            source: source.clone(),
            nonce: nonce.clone(),
            query: query.cloned(),
            admission: admission.cloned(),
            capabilities,
        };
        let mut bytes = serde_json::to_vec(&request)?;
        ensure!(bytes.len() < MAX_FRAME, "peer_source_frame_limit");
        bytes.push(b'\n');
        stream.write_all(&bytes)?;
        let mut line = Vec::new();
        loop {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .context("peer_source_response_timeout")?;
            stream.set_read_timeout(Some(remaining))?;
            let mut chunk = [0u8; 1024];
            let count = stream.read(&mut chunk)?;
            ensure!(count > 0, "peer_source_response_incomplete");
            if let Some(end) = chunk[..count].iter().position(|byte| *byte == b'\n') {
                line.extend_from_slice(&chunk[..=end]);
                break;
            }
            line.extend_from_slice(&chunk[..count]);
            ensure!(line.len() <= MAX_FRAME, "peer_source_response_limit");
        }
        ensure!(
            line.len() <= MAX_FRAME && line.last() == Some(&b'\n'),
            "peer_source_response_invalid"
        );
        let response: Response = serde_json::from_slice(&line)?;
        ensure!(
            response.version == 1
                && response.source == *source
                && response.nonce == nonce
                && !response.unavailable,
            "peer_source_current_authorization_unavailable"
        );
        Ok(response)
    }
}

#[cfg(test)]
mod admission_frame_tests {
    use super::*;
    #[test]
    fn reply_reference_capability_probe_is_explicit_and_does_not_change_old_frames() {
        let mut probe = request("owned note".into());
        assert!(
            serde_json::to_value(&probe)
                .unwrap()
                .get("capabilities")
                .is_none()
        );
        probe.capabilities = true;
        assert!(
            probe.validate(&probe.source).is_err(),
            "probe cannot also admit"
        );
        probe.admission = None;
        probe.validate(&probe.source).unwrap();
        assert_eq!(serde_json::to_value(&probe).unwrap()["capabilities"], true);
    }
    fn request(text: String) -> Request {
        let destination = SessionAddressV1 {
            target_id: "native-target".into(),
            workspace_id: "native-workspace".into(),
            thread_id: "actual-target".into(),
        };
        Request {
            capabilities: false,
            version: 1,
            source: destination.clone(),
            nonce: "actual-request-nonce".into(),
            query: None,
            admission: Some(TargetAdmissionRequest {
                source: CrossSessionMessageSource {
                    thread_id: "actual-source".into(),
                    principal_id: "native-principal".into(),
                    address: Some(SessionAddressV1 {
                        thread_id: "actual-source".into(),
                        ..destination.clone()
                    }),
                },
                intent: AgentMessageIntent {
                    reply_to_message_id: None,
                    target_thread_id: destination.thread_id.clone(),
                    target_address: Some(destination),
                    client_message_id: "original-client-message".into(),
                    mode: AgentMessageMode::EnqueueOnly,
                    expected_turn_id: Some("original-running-turn".into()),
                    text,
                },
            }),
        }
    }
    #[test]
    fn both_native_carriers_accept_the_public_utf8_limit_even_with_worst_json_expansion()
    -> Result<()> {
        let original = request(
            "\u{1}".repeat(kcoder_types::cross_session_messages::MAX_AGENT_MESSAGE_TEXT_BYTES),
        );
        original.validate(&original.source)?;
        let bytes = serde_json::to_vec(&original)?;
        assert!(bytes.len() > 96 * 1024);
        assert!(
            bytes.len() < MAX_FRAME,
            "the shared Linux/Windows decoder preserves the public text limit"
        );
        let decoded: Request = serde_json::from_slice(&bytes)?;
        decoded.validate(&original.source)?;
        assert_eq!(
            decoded.admission.unwrap().intent.text,
            original.admission.unwrap().intent.text
        );
        let too_long = request(
            "x".repeat(kcoder_types::cross_session_messages::MAX_AGENT_MESSAGE_TEXT_BYTES + 1),
        );
        assert!(too_long.validate(&too_long.source).is_err());
        Ok(())
    }
}
