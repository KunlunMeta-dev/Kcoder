//! Read the original manager and history with the authenticated client's cursors.
use super::*;
use crate::app_server::{
    ConnectionState, history_refresh_processor::HistoryRefreshProcessor,
    thread_list_snapshots::ThreadListSnapshots,
};
use kcoder_app_protocol::integrations::channel_peer::{ChannelPeerTaskQuery, ChannelPeerTaskRead};

pub(in crate::app_server) struct NativeUiTaskReadState {
    snapshots: ThreadListSnapshots,
    presence: Arc<tokio::sync::Semaphore>,
}
impl Default for NativeUiTaskReadState {
    fn default() -> Self {
        Self {
            snapshots: ThreadListSnapshots::default(),
            presence: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }
}
pub(in crate::app_server) trait NativeUiTaskReadAuthority:
    Send + Sync
{
    fn verify(&self, state: &ConnectionState, input: &ChannelPeerTaskRead) -> Result<()>;
}
pub(in crate::app_server) struct NativeUiTaskReadRequest {
    pub state: ConnectionState,
    pub reads: NativeUiTaskReadState,
    pub input: ChannelPeerTaskRead,
    pub id: Value,
    pub authority: Arc<dyn NativeUiTaskReadAuthority>,
    pub reply: oneshot::Sender<(ConnectionState, NativeUiTaskReadState, Result<Value>)>,
}
pub(in crate::app_server) async fn dispatch(
    mut request: NativeUiTaskReadRequest,
    workspace: &kcoder_engine::QueryEngine,
    manager: &mut ThreadManager,
) {
    let result = async {
        request.authority.verify(&request.state, &request.input)?;
        let (method, params) = request.input.query.original()?;
        // The read family emits one original response. No history or live
        // status is reconstructed in the frontend or copied into a new store.
        let (outbound, mut frames) = mpsc::channel(2);
        if let ChannelPeerTaskQuery::Presence(params) = &request.input.query {
            let frame = if !request.state.thread_presence_read_v1 {
                crate::app_server::error_response(request.id.clone(), -32601, "threadPresenceReadV1 negotiation is required")
            } else {
                let observed = match request.reads.presence.clone().try_acquire_owned() {
                    Err(_) => crate::app_server::thread_presence_requests::unknown(
                        &params.thread_id, kcoder_app_protocol::ThreadPresenceReadUnknownReasonV1::Busy,
                    ),
                    Ok(permit) => {
                        let input = crate::app_server::thread_presence_requests::capture_input(&params.thread_id, workspace, manager);
                        let cancel = request.state.input_ended.child_token();
                        let _cancel = crate::app_server::thread_presence_requests::CancellationGuard::new(cancel.clone());
                        let mut tasks = tokio::task::JoinSet::new();
                        crate::app_server::thread_presence_requests::spawn_observation_task(
                            &mut tasks, request.id.clone(), params.thread_id.clone(), outbound.clone(), permit, cancel.clone(), input,
                        );
                        // Keep the permit in the actual filesystem worker even
                        // when its requesting client or response deadline ends.
                        let frame = tokio::select! { biased;
                            _=cancel.cancelled()=>anyhow::bail!("TASK_UI_ORIGINAL_READ_ENDED"),
                            result=tokio::time::timeout(Duration::from_secs(30),frames.recv())=>result.ok().flatten(),
                        };
                        if let Some(frame)=frame {
                            request.authority.verify(&request.state, &request.input)?;
                            return Ok(frame);
                        }
                        crate::app_server::thread_presence_requests::unknown(
                            &params.thread_id, kcoder_app_protocol::ThreadPresenceReadUnknownReasonV1::ObservationFailed,
                        )
                    }
                };
                crate::app_server::success_response(request.id.clone(), serde_json::to_value(observed)?)
            };
            request.authority.verify(&request.state, &request.input)?;
            return Ok(frame);
        }
        if let kcoder_app_protocol::integrations::channel_peer::ChannelPeerTaskQuery::ReadIndexed(
            params,
        ) = &request.input.query
        {
            let target = manager
                .engine(&params.thread_id)
                .unwrap_or_else(|| workspace.clone());
            let running = manager.running_thread_ids();
            let projection = crate::app_server::ThreadRunProjection::for_thread(
                manager,
                request.state.run_summary_v1,
                &params.thread_id,
            );
            let frame = crate::app_server::indexed_transcript::original_response(
                &target,
                params.clone(),
                &running,
                projection,
                request.state.transcript_snapshot_v1,
                request.state.transcript_observation_v1,
                request.id.clone(),
            )
            .await;
            request.authority.verify(&request.state, &request.input)?;
            return Ok(frame);
        }
        // The private surface excludes refresh mutations. Its unused helper
        // stays local, rather than lending a SQLite writer across UI streams.
        let mut refresh = HistoryRefreshProcessor::default();
        if matches!(
            request.input.query,
            ChannelPeerTaskQuery::Goal(_) | ChannelPeerTaskQuery::GoalHistory(_)
        ) {
            crate::app_server::goal_requests::dispatch(
                method,
                request.id.clone(),
                params,
                workspace,
                &outbound,
                manager,
                Some(&request.state),
            )
            .await?;
        } else {
            crate::app_server::thread_read_requests::dispatch_original(
                method,
                request.id.clone(),
                params,
                workspace,
                &outbound,
                manager,
                &mut request.state,
                &mut request.reads.snapshots,
                &mut refresh,
            )
            .await?;
        }
        request.authority.verify(&request.state, &request.input)?;
        let frame = frames
            .try_recv()
            .context("TASK_UI_ORIGINAL_READ_RESPONSE_REQUIRED")?;
        ensure!(
            frame.get("id") == Some(&request.id) && frames.try_recv().is_err(),
            "TASK_UI_ORIGINAL_READ_RESPONSE_REQUIRED"
        );
        Ok(frame)
    }
    .await;
    let _ = request.reply.send((request.state, request.reads, result));
}
impl NativeRuntimeClient {
    pub(in crate::app_server) fn queue_ui_task_read(
        &self,
        request: NativeUiTaskReadRequest,
    ) -> std::result::Result<(), Box<NativeUiTaskReadRequest>> {
        match self.sender.try_send(Control::UiTaskRead(Box::new(request))) {
            Ok(()) => Ok(()),
            Err(e) => match e.into_inner() {
                Control::UiTaskRead(request) => Err(request),
                _ => unreachable!("only the original read was queued"),
            },
        }
    }
}
impl NativeRuntimePump {
    pub(in crate::app_server) fn next_ui_task_read(&mut self) -> Option<NativeUiTaskReadRequest> {
        self.ui_task_reads.pop_front().map(|r| *r)
    }
}
pub(super) fn unavailable(request: NativeUiTaskReadRequest) {
    let _ = request.reply.send((
        request.state,
        request.reads,
        Err(anyhow::anyhow!("TASK_UI_READ_NOT_QUEUED")),
    ));
}
