//! The bounded first-party UI wire loop with an already held connection owner.
use crate::{connection_input::ConnectionInput, protocol_io::JsonRpcLine};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::channel_peer::*;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_native_scope::NativeIntegrationContext;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;

/// Actual local authority is supplied by the connection owner. Frames cannot
/// create or replace this proof.
pub trait ChannelUiAuthority: Send {
    fn context(&self) -> &NativeIntegrationContext;
    fn cancellation(&self) -> CancellationToken;
    fn verify(&self) -> Result<()>;
    fn resume_rejected(&self) -> anyhow::Error;
}

pub struct UiRequest {
    pub call: ChannelPeerUiCall,
    pub request_id: ChannelPeerRequestId,
    pub reply: oneshot::Sender<Result<ChannelPeerReply>>,
    pub task_notifications: Option<mpsc::Sender<serde_json::Value>>,
}

pub enum PendingTaskCall {
    Start(String),
    Read(ChannelPeerTaskQuery),
    Resume(String),
    Turn(String),
    Interrupt(String, String),
    Expert(String),
    AsyncQuestion(String),
    Command(ChannelPeerTaskCommandOperation),
}
impl PendingTaskCall {
    pub fn capture(call: &ChannelPeerUiCall) -> Option<Self> {
        match call {
            ChannelPeerUiCall::TaskCommand(input) => Some(Self::Command(input.operation.clone())),
            ChannelPeerUiCall::TaskRead(input) => Some(Self::Read(input.query.clone())),
            ChannelPeerUiCall::TaskStart(input) => {
                input.start.client_request_id.clone().map(Self::Start)
            }
            ChannelPeerUiCall::TaskExpert(input) => {
                Some(Self::Expert(input.expert.thread_id.clone()))
            }
            ChannelPeerUiCall::TaskAsyncQuestion(input) => {
                Some(Self::AsyncQuestion(input.thread_id().to_owned()))
            }
            ChannelPeerUiCall::TaskResume(input) => {
                Some(Self::Resume(input.resume.thread_id.clone()))
            }
            ChannelPeerUiCall::TaskTurnStart(input) => {
                Some(Self::Turn(input.turn.thread_id.clone()))
            }
            ChannelPeerUiCall::TaskInterrupt(input) => Some(Self::Interrupt(
                input.thread_id.clone(),
                input.turn_id.clone(),
            )),
            _ => None,
        }
    }
    pub fn verify_reply(&self, reply: &ChannelPeerReply) -> Result<()> {
        let valid = match (self, reply) {
            (Self::Command(operation), ChannelPeerReply::TaskCommand(output)) => {
                output.validate_for(operation).is_ok()
            }
            (Self::Command(operation), ChannelPeerReply::TaskRequestRejected(output)) => {
                output.thread_id == operation.thread_id()
            }
            (Self::Read(query), ChannelPeerReply::TaskRead(value)) => {
                value.validate_for(query, &value.response_id).is_ok()
            }
            (Self::Start(id), ChannelPeerReply::TaskStart(value)) => {
                value.client_request_id == *id && value.response().is_ok()
            }
            (Self::Expert(thread), ChannelPeerReply::TaskExpert(value)) => {
                value.thread_id == *thread
            }
            (Self::Expert(thread), ChannelPeerReply::TaskRequestRejected(value)) => {
                value.thread_id == *thread
            }
            (Self::Resume(thread), ChannelPeerReply::TaskResume(value)) => {
                value.thread.id == *thread
            }
            (Self::Turn(thread), ChannelPeerReply::TaskTurnStart(value)) => {
                value.turn.thread_id == *thread
            }
            (Self::Turn(thread), ChannelPeerReply::TaskRequestRejected(value)) => {
                value.thread_id == *thread
            }
            (Self::Interrupt(thread, turn), ChannelPeerReply::TaskInterrupted(value)) => {
                value.thread_id == *thread && value.turn_id == *turn
            }
            (Self::Interrupt(thread, _), ChannelPeerReply::TaskRequestRejected(value)) => {
                value.thread_id == *thread
            }
            (Self::AsyncQuestion(thread), ChannelPeerReply::TaskAsyncQuestion(value)) => {
                value.thread_id() == thread
            }
            (Self::AsyncQuestion(thread), ChannelPeerReply::TaskRequestRejected(value)) => {
                value.thread_id == *thread
            }
            _ => false,
        };
        ensure!(valid, "TASK_UI_ORIGINAL_RESPONSE_REQUIRED");
        Ok(())
    }
    pub fn failed_subscription(&self) -> Option<&str> {
        match self {
            Self::Resume(thread) => Some(thread),
            Self::Start(_)
            | Self::Read(_)
            | Self::Turn(_)
            | Self::Interrupt(_, _)
            | Self::Expert(_)
            | Self::AsyncQuestion(_) => None,
            Self::Command(_) => None,
        }
    }
}

pub fn verify_task_resource_context(
    native: &NativeIntegrationContext,
    input: &ChannelPeerTaskResourceFactRead,
) -> Result<()> {
    input.validate().map_err(anyhow::Error::msg)?;
    native.verify()?;
    native.validate_scope(&input.scope)?;
    ensure!(
        native.source_authority_epoch()?.1 == input.source_authority_epoch,
        "TASK_RESOURCE_UI_SOURCE_EPOCH_CHANGED"
    );
    Ok(())
}

pub async fn run(
    mut input: ConnectionInput,
    output: &mut (dyn AsyncWrite + Unpin + Send),
    stream_ref: ChannelPeerStreamRef,
    authority: &mut dyn ChannelUiAuthority,
    mut requests: mpsc::Receiver<UiRequest>,
) -> Result<()> {
    let ended = authority.cancellation();
    let mut sequence = 0u64;
    let mut task_notifications = BTreeMap::<String, mpsc::Sender<serde_json::Value>>::new();
    let mut retired_tasks = std::collections::BTreeSet::<String>::new();
    let mut creation_notifications = BTreeMap::<u64, mpsc::Sender<serde_json::Value>>::new();
    let mut pending = BTreeMap::<
        u64,
        (
            ChannelPeerRequestId,
            oneshot::Sender<Result<ChannelPeerReply>>,
            Option<PendingTaskCall>,
        ),
    >::new();
    // Same policy as the public RPC transport: each outgoing call keeps a
    // complete check; replies and streamed task notifications re-verify on
    // a bounded cadence (see verify_cadence).
    let mut cadence =
        crate::verify_cadence::VerifyCadence::new(crate::verify_cadence::OUTPUT_REVERIFY_INTERVAL);
    loop {
        cadence.check(Instant::now(), || authority.verify())?;
        tokio::select! {biased;
            _=ended.cancelled()=>break,
            next=input.read()=>{
                let Some(JsonRpcLine::Line(line))=next? else {anyhow::bail!("CHANNEL_PEER_ORIGINAL_HOST_ENDED")};
                let frame:ChannelPeerServerFrame=serde_json::from_str(&line)?;
                frame.validate().map_err(anyhow::Error::msg)?;
                match frame {
                    ChannelPeerServerFrame::TaskStreamEnded{stream,thread_id}=>{
                        ensure!(stream==stream_ref,"TASK_UI_ORIGINAL_STREAM_REQUIRED");
                        ensure!(task_notifications.remove(&thread_id).is_some() || retired_tasks.remove(&thread_id),
                            "TASK_UI_ORIGINAL_SUBSCRIBER_REQUIRED");
                    }
                    ChannelPeerServerFrame::TaskNotification{stream,thread_id,notification}=>{
                        ensure!(stream==stream_ref,"TASK_UI_ORIGINAL_STREAM_REQUIRED");
                        if retired_tasks.contains(&thread_id) { continue; }
                        let receiver=task_notifications.get(&thread_id)
                            .context("TASK_UI_ORIGINAL_SUBSCRIBER_REQUIRED")?;
                        let closed=tokio::select! {biased;
                            _=ended.cancelled()=>break,
                            sent=receiver.send(notification)=>sent.is_err(),
                        };
                        if closed {
                            task_notifications.remove(&thread_id);
                            retired_tasks.insert(thread_id);
                        }
                    }
                    ChannelPeerServerFrame::Reply{stream,sequence,request_id,result}=>{
                        ensure!(stream==stream_ref,"CHANNEL_PEER_ORIGINAL_STREAM_REQUIRED");
                        let (id,reply,task)=pending.remove(&sequence).context("CHANNEL_PEER_ORIGINAL_REQUEST_REQUIRED")?;
                        ensure!(id==request_id,"CHANNEL_PEER_ORIGINAL_REQUEST_REQUIRED");
                        if let Some(task)=task { task.verify_reply(&result)?; }
                        if let ChannelPeerReply::TaskRead(output)=&result {
                            ensure!(output.response_id==request_id,"TASK_UI_ORIGINAL_READ_RESPONSE_REQUIRED");
                        }
                        if let Some(notifications) = creation_notifications.remove(&sequence) {
                            let ChannelPeerReply::TaskStart(output) = &result else {
                                anyhow::bail!("TASK_UI_ORIGINAL_CREATION_REQUIRED");
                            };
                            ensure!(output.response_id == request_id, "TASK_UI_ORIGINAL_CREATION_REQUIRED");
                            let response = output.response().map_err(anyhow::Error::msg)?;
                            if output.subscription != ChannelPeerTaskCreationSubscription::Detached {
                                let value = response.get("result").context("TASK_UI_ORIGINAL_CREATION_REQUIRED")?;
                                let started: kcoder_app_protocol::ThreadStartResult = rpc_codec::decode(value.clone())?;
                                ensure!(!retired_tasks.contains(&started.thread.id), "TASK_UI_ORIGINAL_SUBSCRIBER_REQUIRED");
                                if output.subscription == ChannelPeerTaskCreationSubscription::Existing {
                                    ensure!(task_notifications.contains_key(&started.thread.id), "TASK_UI_ORIGINAL_SUBSCRIBER_REQUIRED");
                                } else {
                                    ensure!(!task_notifications.contains_key(&started.thread.id), "TASK_UI_ORIGINAL_SUBSCRIBER_REQUIRED");
                                    task_notifications.insert(started.thread.id, notifications);
                                }
                            }
                        }
                        let _=reply.send(Ok(result));
                    }
                    ChannelPeerServerFrame::Failure{stream,sequence,request_id,reason_sha256,failure}=>{
                        ensure!(stream==stream_ref,"CHANNEL_PEER_ORIGINAL_STREAM_REQUIRED");
                        let (id,reply,task)=pending.remove(&sequence).context("CHANNEL_PEER_ORIGINAL_REQUEST_REQUIRED")?;
                        ensure!(id==request_id,"CHANNEL_PEER_ORIGINAL_REQUEST_REQUIRED");
                        creation_notifications.remove(&sequence);
                        let task_rejected=task.is_some() && failure==ChannelPeerFailure::Rejected;
                        if let Some(task)=task.as_ref().and_then(PendingTaskCall::failed_subscription)
                            && task_notifications.remove(task).is_some() {
                            retired_tasks.insert(task.to_owned());
                        }
                        if let Some(digest)=reason_sha256 {
                            // Only a validated fixed-size digest crosses the original UI diagnostic lane.
                            eprintln!("{}",serde_json::json!({"event":"native_scope_peer_control_unconfirmed","stage":"original_ui_call","reasonSha256":digest}));
                        }
                        let error=if task_rejected {
                            authority.resume_rejected()
                        } else { anyhow::anyhow!("CHANNEL_PEER_OPERATION_UNCONFIRMED") };
                        let _=reply.send(Err(error));
                    }
                    ChannelPeerServerFrame::OwnerEnded{stream}=>{
                        ensure!(stream==stream_ref,"CHANNEL_PEER_ORIGINAL_STREAM_REQUIRED");break;
                    }
                    _=>anyhow::bail!("CHANNEL_PEER_ORIGINAL_RESPONSE_REQUIRED"),
                }
            }
            next=requests.recv(),if pending.len()<CHANNEL_PEER_PENDING_PER_STREAM=>{
                let Some(request)=next else {break};
                if let ChannelPeerUiCall::TaskStart(input) = &request.call {
                    authority.context().validate_scope(&input.scope)?;
                    ensure!(authority.context().source_authority_epoch()?.1 == input.source_authority_epoch,
                        "TASK_UI_SOURCE_CHANGED");
                    ensure!(task_notifications.len() + retired_tasks.len() + creation_notifications.len() < 16,
                        "TASK_UI_SUBSCRIBER_CAPACITY_OR_DUPLICATE");
                    let notifications = request.task_notifications.as_ref().context("TASK_UI_ORIGINAL_SUBSCRIBER_REQUIRED")?;
                    let next = sequence.checked_add(1).context("CHANNEL_PEER_SEQUENCE_EXHAUSTED")?;
                    creation_notifications.insert(next, notifications.clone());
                } else if let ChannelPeerUiCall::TaskResume(input)=&request.call {
                    authority.context().validate_scope(&input.scope)?;
                    ensure!(authority.context().source_authority_epoch()?.1==input.source_authority_epoch,
                        "TASK_UI_SOURCE_CHANGED");
                    let notifications=request.task_notifications.as_ref()
                        .context("TASK_UI_ORIGINAL_SUBSCRIBER_REQUIRED")?;
                    let existing=task_notifications.get(&input.resume.thread_id);
                    if (task_notifications.len()+retired_tasks.len()>=16 && existing.is_none())
                        || existing.is_some_and(|original| !original.same_channel(notifications))
                        || retired_tasks.contains(&input.resume.thread_id) {
                        let _=request.reply.send(Err(anyhow::anyhow!("TASK_UI_SUBSCRIBER_CAPACITY_OR_DUPLICATE")));
                        continue;
                    }
                    if existing.is_none() { task_notifications.insert(input.resume.thread_id.clone(),notifications.clone()); }
                } else {
                    ensure!(request.task_notifications.is_none(),"TASK_UI_ORIGINAL_SUBSCRIBER_REQUIRED");
                }
                if let ChannelPeerUiCall::TaskResources(input) = &request.call {
                    let native = authority.context();
                    verify_task_resource_context(native, input)?;
                }
                let task_target = match &request.call {
                    ChannelPeerUiCall::TaskTurnStart(input) => Some((&input.scope, input.source_authority_epoch, input.turn.thread_id.as_str())),
                    ChannelPeerUiCall::TaskInterrupt(input) => Some((&input.scope, input.source_authority_epoch, input.thread_id.as_str())),
                    ChannelPeerUiCall::TaskExpert(input) => Some((&input.scope, input.source_authority_epoch, input.expert.thread_id.as_str())),
                    ChannelPeerUiCall::TaskAsyncQuestion(input) => Some((&input.scope, input.source_authority_epoch, input.thread_id())),
                    ChannelPeerUiCall::TaskCommand(input) => Some((&input.scope, input.source_authority_epoch, input.operation.thread_id())),
                    _ => None,
                };
                if let Some((scope, epoch, thread)) = task_target {
                    let native=authority.context();
                    native.validate_scope(scope)?;
                    ensure!(native.source_authority_epoch()?.1==epoch,
                        "TASK_UI_SOURCE_CHANGED");
                    if !task_notifications.contains_key(thread) || retired_tasks.contains(thread) {
                        let _=request.reply.send(Err(authority.resume_rejected()));
                        continue;
                    }
                }
                sequence=sequence.checked_add(1).context("CHANNEL_PEER_SEQUENCE_EXHAUSTED")?;
                let task=PendingTaskCall::capture(&request.call);
                let frame=ChannelPeerClientFrame::UiCall{stream:stream_ref.clone(),sequence,request_id:request.request_id.clone(),call:request.call};
                authority.verify()?;
                cadence.verified(Instant::now());
                pending.insert(sequence,(request.request_id,request.reply,task));
                write_client(output,&frame,&ended).await?;
            }
        }
    }
    Ok(())
}

pub async fn write_client(
    output: &mut (dyn AsyncWrite + Unpin + Send),
    frame: &ChannelPeerClientFrame,
    cancel: &CancellationToken,
) -> Result<()> {
    frame.validate().map_err(anyhow::Error::msg)?;
    let mut bytes = serde_json::to_vec(frame)?;
    ensure!(
        bytes.len() <= CHANNEL_PEER_FRAME_BYTES,
        "CHANNEL_PEER_FRAME_INVALID"
    );
    bytes.push(b'\n');
    tokio::select! {biased;
        _=cancel.cancelled()=>anyhow::bail!("CHANNEL_PEER_ORIGINAL_UI_ENDED"),
        result=tokio::time::timeout(Duration::from_secs(10),async{output.write_all(&bytes).await?;output.flush().await})=>result.context("CHANNEL_PEER_WRITE_UNCONFIRMED")??,
    }
    Ok(())
}
pub async fn read_server(
    input: &mut ConnectionInput,
    cancel: &CancellationToken,
    budget: Duration,
) -> Result<ChannelPeerServerFrame> {
    let next = tokio::select! {biased;
        _=cancel.cancelled()=>anyhow::bail!("CHANNEL_PEER_ORIGINAL_UI_ENDED"),
        next=tokio::time::timeout(budget,input.read())=>next.context("CHANNEL_PEER_HANDSHAKE_UNCONFIRMED")??,
    };
    let Some(JsonRpcLine::Line(line)) = next else {
        anyhow::bail!("CHANNEL_PEER_ORIGINAL_HOST_ENDED")
    };
    let frame: ChannelPeerServerFrame = serde_json::from_str(&line)?;
    frame.validate().map_err(anyhow::Error::msg)?;
    if let ChannelPeerServerFrame::AdmissionFailed {
        stage,
        reason_sha256,
    } = &frame
    {
        eprintln!(
            "{}",
            serde_json::json!({"event":"native_scope_original_admission_unconfirmed","stage":stage,"reasonSha256":reason_sha256})
        );
        anyhow::bail!("CHANNEL_PEER_ORIGINAL_ADMISSION_UNCONFIRMED");
    }
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started(thread: &str) -> ChannelPeerReply {
        ChannelPeerReply::TaskTurnStart(kcoder_app_protocol::TurnStartResult {
            turn: kcoder_app_protocol::Turn {
                id: "original-turn".into(),
                attempt_id: Some("original-turn".into()),
                memory_snapshot_id: None,
                thread_id: thread.into(),
                status: kcoder_app_protocol::TurnStatus::Running,
            },
        })
    }

    #[test]
    fn turn_failure_keeps_the_resumed_subscription_and_checks_reply_kind_and_thread() {
        let turn = PendingTaskCall::Turn("original-task".into());
        assert_eq!(turn.failed_subscription(), None);
        assert_eq!(
            PendingTaskCall::Resume("original-task".into()).failed_subscription(),
            Some("original-task")
        );
        assert!(turn.verify_reply(&started("original-task")).is_ok());
        assert!(turn.verify_reply(&started("other-task")).is_err());
        assert!(
            PendingTaskCall::Resume("original-task".into())
                .verify_reply(&started("original-task"))
                .is_err()
        );
    }
}
