//! Actual current-SID/image named pipes. Their names locate; live Bound checks authorize.
use super::*;
use kcoder_native_scope::service_identity::{
    windows_image::WindowsServiceImage,
    windows_pipe::{ServicePipe, asynchronous::CurrentUserPipeListener},
};
use std::{os::windows::io::BorrowedHandle, sync::OnceLock};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

fn image() -> Result<Arc<WindowsServiceImage>> {
    static IMAGE: OnceLock<Mutex<Option<Arc<WindowsServiceImage>>>> = OnceLock::new();
    let mut captured = IMAGE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| anyhow::anyhow!("peer_source_image_busy"))?;
    if let Some(image) = captured.as_ref() {
        return Ok(image.clone());
    }
    // SAFETY: the process pseudo-handle is valid for this entire borrow and is
    // never closed or transferred to the peer by this loader.
    let process = unsafe {
        BorrowedHandle::borrow_raw(
            windows_sys::Win32::System::Threading::GetCurrentProcess().cast(),
        )
    };
    let image = Arc::new(WindowsServiceImage::capture(
        process,
        &CancellationToken::new(),
    )?);
    *captured = Some(image.clone());
    Ok(image)
}
fn name(source: &SessionAddressV1) -> Result<String> {
    source.validate().map_err(anyhow::Error::msg)?;
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "kcoder.peer-source.endpoint.v1",
            source
        ))?)
    );
    Ok(format!(r"\\.\pipe\kcoder-service-v1-peer-source-{digest}"))
}
pub(super) fn bind(source: Arc<BoundPeerSource>) -> Result<PeerSourceEndpoint> {
    let runtime = tokio::runtime::Handle::try_current().context("peer_source_runtime_required")?;
    let address = source.address()?;
    let image = image()?;
    let mut listener = CurrentUserPipeListener::bind_peer_source(name(&address)?)?;
    let registration = super::super::registry::Registration::publish(&source)?;
    source.service().register_live_source(source.clone())?;
    let source = Arc::new(RwLock::new(source));
    let owner = source.clone();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let task=runtime.spawn(async move {
        let mut jobs=tokio::task::JoinSet::new();
        loop {
            tokio::select! {biased;
                _=stop.cancelled()=>break,
                _=jobs.join_next(),if !jobs.is_empty()=>{},
                accepted=listener.accept_same_image(&image,&stop),if jobs.len()<8=>{
                    let accepted=match accepted {Ok(accepted)=>accepted,Err(_) if stop.is_cancelled()=>break,Err(_)=>continue};
                    let owner=owner.clone();let expected=address.clone();let stop=stop.clone();
                    jobs.spawn(async move {
                        let work=async {
                            accepted.peer.verify()?;
                            let mut reader=tokio::io::BufReader::new(accepted.io);let mut line=Vec::new();
                            (&mut reader).take((MAX_FRAME+1) as u64).read_until(b'\n',&mut line).await?;
                            ensure!(line.len()<=MAX_FRAME && line.last()==Some(&b'\n'),"peer_source_frame_invalid");
                            accepted.peer.verify()?;
                            let request:Request=serde_json::from_slice(&line)?;
                            let response=source_response(owner,expected,request).await?;
                            accepted.peer.verify()?;
                            let mut bytes=serde_json::to_vec(&response)?;ensure!(bytes.len()<MAX_FRAME,"peer_source_response_limit");bytes.push(b'\n');
                            reader.get_mut().write_all(&bytes).await?;
                            Ok::<(),anyhow::Error>(())
                        };
                        tokio::select! {biased;_=stop.cancelled()=>{},_=tokio::time::timeout(ADMISSION_IO_BUDGET,work)=>{}}
                    });
                }
            }
        }
        jobs.abort_all();while jobs.join_next().await.is_some(){}
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
    let image = image()?;
    let mut pipe = ServicePipe::connect_peer_source_same_image(&name(source)?, &image)?
        .ok_or(OriginalSourceUnavailable)?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let request = Request {
        version: 1,
        source: source.clone(),
        nonce: nonce.clone(),
        query: query.cloned(),
        admission: admission.cloned(),
        capabilities,
    };
    let request = serde_json::to_value(request)?;
    pipe.verify()?;
    pipe.write(&request)?;
    let response: Response = serde_json::from_value(pipe.read(
        if admission.is_some() {
            ADMISSION_IO_BUDGET
        } else {
            IO_BUDGET
        },
        MAX_FRAME,
    )?)?;
    pipe.verify()?;
    ensure!(
        response.version == 1
            && response.source == *source
            && response.nonce == nonce
            && !response.unavailable,
        "peer_source_current_authorization_unavailable"
    );
    Ok(response)
}
