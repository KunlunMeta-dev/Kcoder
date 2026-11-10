//! A real Native UI stream resumes through the original connection dispatch.
use super::*;
use crate::app_server::ConnectionState;
use kcoder_app_protocol::ThreadResumeParams;

/// Only a determinate pre-dispatch or original RPC rejection can create this.
/// Timeouts, closed response pipes and post-dispatch changes stay unknown.
#[derive(Debug)]
pub(in crate::app_server) struct NativeUiTaskResumeRejected;
impl std::fmt::Display for NativeUiTaskResumeRejected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TASK_UI_RESUME_REJECTED")
    }
}
impl std::error::Error for NativeUiTaskResumeRejected {}

/// References supplied only by the original connection's composition root.
pub(in crate::app_server) struct NativeUiTaskResumeDispatch<'a> {
    pub owners: &'a mut super::NativeUiTaskOwners,
    pub engine: &'a mut kcoder_engine::QueryEngine,
    pub workspace: &'a kcoder_engine::QueryEngine,
    pub factory: &'a crate::app_server::AppServerEngineFactory,
    pub permission_mode: kcoder_config::PermissionMode,
    pub manager: &'a mut ThreadManager,
    pub interactions: &'a Arc<std::sync::atomic::AtomicU64>,
    pub receipts: &'a Arc<std::sync::Mutex<crate::app_server::InteractionReceipts>>,
    pub server: &'a str,
    pub sequence: &'a Arc<std::sync::atomic::AtomicU64>,
}
impl NativeUiTaskResumeDispatch<'_> {
    pub(in crate::app_server) async fn dispatch(&mut self, mut request: NativeUiTaskResumeRequest) {
        let resident = self.manager.owns(&request.params.thread_id);
        let background = self
            .manager
            .has_background_lifetime(&request.params.thread_id);
        let admission = request
            .authority
            .verify(&request.state, &request.params)
            .and_then(|()| {
                if let Some(owner) = &request.existing_owner {
                    owner.verify(
                        &request.state,
                        self.manager,
                        &request.params.thread_id,
                        self.server,
                    )?;
                }
                ensure!(
                    request.authority.allows_prepared_resume()
                        || background
                        || !matches!(
                            self.manager.task_owner_presence(&request.params.thread_id),
                            crate::app_server::thread_runtime::TaskOwnerPresence::Prepared { .. }
                        ),
                    "TASK_UI_ORIGINAL_OWNER_PREPARING"
                );
                Ok(())
            });
        let dispatched = admission.is_ok();
        let result = match admission {
            Ok(()) => Box::pin(crate::app_server::thread_restore_requests::dispatch(
                kcoder_app_protocol::method::THREAD_RESUME,
                request.id,
                serde_json::to_value(&request.params)
                    .expect("the finite original resume is serializable"),
                self.engine,
                self.workspace,
                self.factory,
                self.permission_mode,
                &request.outbound,
                self.interactions,
                self.receipts,
                self.manager,
                self.server,
                self.sequence,
                &mut request.state,
            ))
            .await
            .map(|_| ()),
            Err(error) => Err(error.context(NativeUiTaskResumeRejected)),
        };
        let configuration = if result.is_ok()
            && !resident
            && self.manager.owns(&request.params.thread_id)
        {
            // A background residency fence is not this UI's execution authority.
            // Retain the actual ordinary task configuration before any input
            // applies its own source policy; later clients reuse the same State.
            crate::app_server::integrations::connectivity::task_ui::retain_original_configuration(
                &request.state,
                self.manager,
                &request.params.thread_id,
            )
        } else {
            Ok(())
        };
        // A signed background preparation already owns the original lease.
        // The attaching UI lends presentation and owns only its own inputs;
        // closing it cannot retire that background task's runtime.
        let owner = (dispatched && self.manager.owns(&request.params.thread_id))
            .then(|| {
                if let Some(owner) = &request.existing_owner {
                    return Ok(owner.clone());
                }
                super::NativeUiTaskOwner::capture_presentation(
                    &request.state,
                    self.manager,
                    &request.params.thread_id,
                    self.server,
                    request.retired.clone(),
                )
            })
            .transpose();
        if request.existing_owner.is_none()
            && let Ok(Some(owner)) = &owner
        {
            self.owners.retain(owner.clone());
        }
        let result = result
            .and(configuration)
            .and_then(|()| request.authority.verify(&request.state, &request.params))
            .and(owner);
        if result.is_err() {
            request.retired.cancel();
        }
        let _ = request.reply.send((request.state, result));
    }
}

/// Only the held Native UI peer can construct this witness. Relationship
/// metadata, SDK input and serialized role fields cannot implement it.
pub(in crate::app_server) trait NativeUiTaskResumeAuthority:
    Send + Sync
{
    fn verify(&self, state: &ConnectionState, params: &ThreadResumeParams) -> Result<()>;
    fn allows_prepared_resume(&self) -> bool {
        false
    }
}

pub(in crate::app_server) struct NativeUiTaskResumeRequest {
    pub existing_owner: Option<Arc<super::NativeUiTaskOwner>>,
    pub retired: tokio_util::sync::CancellationToken,
    pub state: ConnectionState,
    pub params: ThreadResumeParams,
    pub id: Value,
    pub outbound: mpsc::Sender<Value>,
    pub authority: Arc<dyn NativeUiTaskResumeAuthority>,
    pub reply: oneshot::Sender<(
        ConnectionState,
        Result<Option<Arc<super::NativeUiTaskOwner>>>,
    )>,
}

impl NativeRuntimeClient {
    /// The original state is returned even on a known queue rejection. Once
    /// accepted, EOF is unknown; callers cannot reconstruct or retry the state.
    pub(in crate::app_server) fn queue_ui_task_resume(
        &self,
        request: NativeUiTaskResumeRequest,
    ) -> std::result::Result<(), Box<NativeUiTaskResumeRequest>> {
        match self
            .sender
            .try_send(Control::UiTaskResume(Box::new(request)))
        {
            Ok(()) => Ok(()),
            Err(error) => match error.into_inner() {
                Control::UiTaskResume(request) => Err(request),
                _ => unreachable!("only the original private request was enqueued"),
            },
        }
    }
}

impl NativeRuntimePump {
    pub(in crate::app_server) fn next_ui_task_resume(
        &mut self,
    ) -> Option<NativeUiTaskResumeRequest> {
        self.ui_task_resumes.pop_front().map(|request| *request)
    }
}

pub(super) fn unavailable(request: NativeUiTaskResumeRequest) {
    let _ = request.reply.send((
        request.state,
        Err(anyhow::anyhow!("TASK_UI_ORIGINAL_DISPATCH_UNAVAILABLE")
            .context(NativeUiTaskResumeRejected)),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ActualStateOwner(std::sync::Weak<()>);
    impl NativeUiTaskResumeAuthority for ActualStateOwner {
        fn verify(&self, state: &ConnectionState, params: &ThreadResumeParams) -> Result<()> {
            ensure!(
                self.0
                    .ptr_eq(&Arc::downgrade(&state.source_management_owner))
                    && self.0.upgrade().is_some()
                    && params.thread_id == "original-task",
                "ORIGINAL_UI_STATE_REQUIRED"
            );
            Ok(())
        }
    }
    fn request() -> NativeUiTaskResumeRequest {
        let state = ConnectionState::default();
        let authority = Arc::new(ActualStateOwner(Arc::downgrade(
            &state.source_management_owner,
        )));
        let (outbound, _) = mpsc::channel(1);
        let (reply, _) = oneshot::channel();
        NativeUiTaskResumeRequest {
            existing_owner: None,
            retired: tokio_util::sync::CancellationToken::new(),
            state,
            params: ThreadResumeParams {
                thread_id: "original-task".into(),
                history: None,
            },
            id: json!("original-request"),
            outbound,
            authority,
            reply,
        }
    }
    #[tokio::test]
    async fn original_ui_state_moves_once_through_the_existing_core_queue() -> Result<()> {
        let (mut pump, client) = NativeRuntimePump::new();
        pump.enable_task_owners();
        let original = request();
        let owner = Arc::downgrade(&original.state.source_management_owner);
        assert!(client.queue_ui_task_resume(original).is_ok());
        let (outbound, _) = mpsc::channel(1);
        let mut manager = ThreadManager::default();
        while pump.ui_task_resumes.is_empty() {
            let event = pump.receive().await;
            pump.observe_with_task_owners(event, &outbound, &mut manager)
                .await?;
        }
        let mut delivered = pump
            .next_ui_task_resume()
            .context("ORIGINAL_REQUEST_REQUIRED")?;
        assert!(owner.ptr_eq(&Arc::downgrade(&delivered.state.source_management_owner)));
        delivered
            .authority
            .verify(&delivered.state, &delivered.params)?;
        assert!(
            delivered
                .authority
                .verify(&ConnectionState::default(), &delivered.params)
                .is_err()
        );
        delivered.params.thread_id = "other-task".into();
        assert!(
            delivered
                .authority
                .verify(&delivered.state, &delivered.params)
                .is_err()
        );
        assert!(pump.next_ui_task_resume().is_none());
        assert!(manager.is_empty());
        pump.close().await;
        Ok(())
    }
    #[tokio::test]
    async fn bounded_queue_rejection_returns_the_exact_original_state() {
        let (pump, client) = NativeRuntimePump::new();
        for _ in 0..CAPACITY {
            assert!(client.queue_ui_task_resume(request()).is_ok());
        }
        let original = request();
        let owner = Arc::downgrade(&original.state.source_management_owner);
        let returned = client.queue_ui_task_resume(original).err().unwrap();
        assert!(owner.ptr_eq(&Arc::downgrade(&returned.state.source_management_owner)));
        drop(pump);
        assert!(client.queue_ui_task_resume(request()).is_err());
    }
}
