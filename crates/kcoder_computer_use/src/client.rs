//! Multiplexed client for an already-authenticated desktop pipe. Cancelling a
//! request closes the connection instead of leaving unobserved input running.
use crate::{
    framing::{MAX_REPLY_BYTES, read_frame, write_frame},
    policy::MAX_REQUEST_BYTES,
};
use kcoder_types::computer_use::{DESKTOP_PROTOCOL_VERSION, DesktopOperation, DesktopRequest};
use serde_json::Value;
use std::{collections::HashMap, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, oneshot},
    task::{AbortHandle, JoinHandle},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    Disconnected,
    Busy,
    Timeout,
    Protocol,
    Remote(String),
    Execution {
        detail: String,
        cleanup_confirmed: bool,
    },
}
struct Request {
    operation: DesktopOperation,
    reply: oneshot::Sender<Result<Value, ClientError>>,
}
pub struct DesktopClient {
    sender: mpsc::Sender<Request>,
    task: JoinHandle<()>,
}
impl Drop for DesktopClient {
    fn drop(&mut self) {
        self.task.abort();
    }
}
struct AbortGuard {
    task: AbortHandle,
    armed: bool,
}
impl Drop for AbortGuard {
    fn drop(&mut self) {
        if self.armed {
            self.task.abort();
        }
    }
}
struct ReaderGuard(JoinHandle<()>);
impl Drop for ReaderGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl DesktopClient {
    /// Do not pass raw unauthenticated pipe connections here.
    pub fn from_authenticated<S>(stream: S) -> Self
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (sender, requests) = mpsc::channel(8);
        let task = tokio::spawn(run(stream, requests));
        Self { sender, task }
    }
    pub async fn request(
        &self,
        operation: DesktopOperation,
        timeout: Duration,
    ) -> Result<Value, ClientError> {
        let (reply, response) = oneshot::channel();
        self.sender
            .try_send(Request { operation, reply })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => ClientError::Busy,
                mpsc::error::TrySendError::Closed(_) => ClientError::Disconnected,
            })?;
        let mut guard = AbortGuard {
            task: self.task.abort_handle(),
            armed: true,
        };
        let result = match tokio::time::timeout(timeout, response).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ClientError::Disconnected),
            Err(_) => return Err(ClientError::Timeout),
        };
        guard.armed = false;
        result
    }
}
async fn run<S>(stream: S, mut requests: mpsc::Receiver<Request>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut read, mut write) = tokio::io::split(stream);
    let (tx, mut incoming) = mpsc::channel(2);
    let _reader = ReaderGuard(tokio::spawn(async move {
        loop {
            let frame = read_frame(&mut read, MAX_REPLY_BYTES).await;
            let failed = frame.is_err();
            if tx.send(frame).await.is_err() || failed {
                break;
            }
        }
    }));
    let mut pending: HashMap<u64, oneshot::Sender<Result<Value, ClientError>>> = HashMap::new();
    let mut next_id = 0u64;
    loop {
        tokio::select! {
            request=requests.recv()=>{
                let Some(request)=request else{break;};
                if request.reply.is_closed(){break;}
                if pending.len()>=8 {let _=request.reply.send(Err(ClientError::Busy));continue;}
                let Some(id)=next_id.checked_add(1) else{break;};next_id=id;
                let frame=DesktopRequest{protocol_version:DESKTOP_PROTOCOL_VERSION,request_id:id,operation:request.operation};
                let Ok(bytes)=serde_json::to_vec(&frame) else{let _=request.reply.send(Err(ClientError::Protocol));break;};
                if bytes.len()>MAX_REQUEST_BYTES{let _=request.reply.send(Err(ClientError::Protocol));continue;}
                pending.insert(id,request.reply);
                if !matches!(tokio::time::timeout(Duration::from_secs(5),write_frame(&mut write,&bytes,MAX_REQUEST_BYTES)).await,Ok(Ok(()))){break;}
            }
            reply=incoming.recv()=>{
                let Some(Ok(bytes))=reply else{break;};
                let Ok(value)=serde_json::from_slice::<Value>(&bytes) else{break;};
                let Some(id)=value.get("requestId").and_then(Value::as_u64) else{break;};
                let Some(sender)=pending.remove(&id) else{break;};
                let result=match (value.get("result"),value.get("error")){
                    (Some(result),None)=>Ok(result.clone()),
                    (None,Some(error))=>match error.get("code").and_then(Value::as_str){
                        Some("tool_execution_failed") => match (error.get("detail").and_then(Value::as_str), error.get("cleanupConfirmed").and_then(Value::as_bool)) {
                            (Some(detail), Some(cleanup_confirmed)) if detail.len() <= 16384 => Err(ClientError::Execution {detail: detail.into(), cleanup_confirmed}),
                            _ => Err(ClientError::Protocol),
                        },
                        Some(code) if code.len()<=128=>Err(ClientError::Remote(code.into())),
                        _=>Err(ClientError::Protocol),
                    },
                    _=>Err(ClientError::Protocol),
                };
                let malformed=result==Err(ClientError::Protocol);
                let _=sender.send(result);if malformed{break;}
            }
        }
    }
    for (_, reply) in pending {
        let _ = reply.send(Err(ClientError::Disconnected));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn matches_out_of_order_replies_and_preserves_remote_errors() {
        let (client, mut server) = tokio::io::duplex(4096);
        let client = DesktopClient::from_authenticated(client);
        let peer = tokio::spawn(async move {
            let a: Value =
                serde_json::from_slice(&read_frame(&mut server, MAX_REQUEST_BYTES).await.unwrap())
                    .unwrap();
            let b: Value =
                serde_json::from_slice(&read_frame(&mut server, MAX_REQUEST_BYTES).await.unwrap())
                    .unwrap();
            for value in [
                serde_json::json!({"requestId":b["requestId"],"error":{"code":"desktop_busy"}}),
                serde_json::json!({"requestId":a["requestId"],"result":{"state":"ready"}}),
            ] {
                write_frame(
                    &mut server,
                    &serde_json::to_vec(&value).unwrap(),
                    MAX_REPLY_BYTES,
                )
                .await
                .unwrap();
            }
        });
        let (a, b) = tokio::join!(
            client.request(DesktopOperation::Status, Duration::from_secs(1)),
            client.request(DesktopOperation::Status, Duration::from_secs(1))
        );
        assert_eq!(a.unwrap()["state"], "ready");
        assert_eq!(b, Err(ClientError::Remote("desktop_busy".into())));
        peer.await.unwrap();
    }
    #[tokio::test]
    async fn timeout_closes_transport_and_does_not_retry() {
        let (client, mut server) = tokio::io::duplex(4096);
        let client = DesktopClient::from_authenticated(client);
        assert_eq!(
            client
                .request(DesktopOperation::Status, Duration::from_millis(10))
                .await,
            Err(ClientError::Timeout)
        );
        read_frame(&mut server, MAX_REQUEST_BYTES).await.unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_secs(1),
                read_frame(&mut server, MAX_REQUEST_BYTES)
            )
            .await
            .unwrap()
            .is_err()
        );
    }
}
