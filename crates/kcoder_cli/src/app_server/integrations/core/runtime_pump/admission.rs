use super::*;

pub(crate) struct Admission {
    pub context: Arc<NativeIntegrationContext>,
    pub request: IntegrationRequest,
    pub prepared: PreparedRuntimeTask,
    pub authority: Arc<dyn NativeRuntimeAuthority>,
    pub reply: oneshot::Sender<IntegrationReply>,
}
pub(crate) enum Control {
    RpcConnection(Box<crate::app_server::rpc_connection::RpcRequest>),
    Accept(Box<Admission>),
    TaskOwner(Box<super::task_owners::TaskOwnerRequest>),
    UiTaskResume(Box<super::ui_task_resume::NativeUiTaskResumeRequest>),
    UiTaskStart(Box<super::ui_task_start::NativeUiTaskStartRequest>),
    UiTaskRead(Box<super::ui_task_read::NativeUiTaskReadRequest>),
    UiTaskTurn(Box<super::ui_task_turn::NativeUiTaskTurnRequest>),
    Request(Box<RuntimeControlRequest>),
}
pub(crate) struct RuntimeControlRequest {
    pub context: Arc<NativeIntegrationContext>,
    pub request: IntegrationRequest,
    pub method: RuntimeControlMethod,
    pub reply: oneshot::Sender<IntegrationReply>,
}
#[derive(Clone, Copy)]
pub(crate) enum RuntimeControlMethod {
    ReadOperation,
    ReadTask,
    CancelTask,
}
impl RuntimeControlMethod {
    fn wire(self) -> &'static str {
        match self {
            Self::ReadOperation => "readOperation",
            Self::ReadTask => "readTask",
            Self::CancelTask => "cancelTask",
        }
    }
}
pub(super) struct PendingReply {
    pub operation: String,
    pub request: IntegrationRequest,
    pub context: Arc<NativeIntegrationContext>,
    pub deadline: Instant,
    pub reply: oneshot::Sender<IntegrationReply>,
}

#[derive(Clone)]
pub(crate) struct NativeRuntimeClient {
    pub(super) rpc_hub: crate::app_server::rpc_hub::RpcHub,
    pub(super) sender: kcoder_host_transport::control_sender::ControlSender<Control>,
    pub(super) task_owners: Arc<std::sync::atomic::AtomicBool>,
}
impl std::fmt::Debug for NativeRuntimeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeRuntimeClient { owner: connection }")
    }
}
impl NativeRuntimeClient {
    /// Waiting here happens in the owned domain task, never in the main dispatch
    /// branch which must continue to drive commands, questions and approvals.
    pub(crate) async fn accept(
        &self,
        context: Arc<NativeIntegrationContext>,
        request: IntegrationRequest,
        prepared: PreparedRuntimeTask,
        authority: Arc<dyn NativeRuntimeAuthority>,
    ) -> Result<IntegrationReply> {
        request.validate_method(IntegrationPort::Runtime, "acceptTask")?;
        context.validate_scope(&request.scope)?;
        prepared.validate()?;
        eprintln!(
            "{}",
            serde_json::json!({"event":"native_runtime_ticket_stage","stage":"admission_verify"})
        );
        authority.verify_admission(&context, &request, &prepared)?;
        let (reply, response) = oneshot::channel();
        self.sender
            .try_send(Control::Accept(Box::new(Admission {
                context,
                request,
                prepared,
                authority,
                reply,
            })))
            .map_err(|_| anyhow::anyhow!("RUNTIME_QUEUE_UNAVAILABLE"))?;
        eprintln!(
            "{}",
            serde_json::json!({"event":"native_runtime_ticket_stage","stage":"admission_queued"})
        );
        Self::wait_for_acceptance(response).await
    }

    pub(super) async fn wait_for_acceptance(
        response: oneshot::Receiver<IntegrationReply>,
    ) -> Result<IntegrationReply> {
        let result = response
            .await
            .map_err(|_| anyhow::anyhow!("RUNTIME_ACCEPTANCE_UNCONFIRMED"));
        eprintln!(
            "{}",
            serde_json::json!({"event":"native_runtime_ticket_stage","stage":"admission_reply","isError":result.is_err(),
                "replyStatus":result.as_ref().ok().map(|reply|&reply.status)})
        );
        #[cfg(test)]
        if let Ok(reply) = &result
            && let Some(error) = reply.error.as_ref()
        {
            eprintln!("CONTROLLED_RUNTIME_ADMISSION_CODE {}", error.code);
        }
        result
    }

    pub(crate) async fn read_operation(
        &self,
        context: Arc<NativeIntegrationContext>,
        request: IntegrationRequest,
    ) -> Result<IntegrationReply> {
        self.request(context, request, RuntimeControlMethod::ReadOperation)
            .await
    }
    pub(crate) async fn read_task(
        &self,
        context: Arc<NativeIntegrationContext>,
        request: IntegrationRequest,
    ) -> Result<IntegrationReply> {
        self.request(context, request, RuntimeControlMethod::ReadTask)
            .await
    }
    pub(crate) async fn cancel_task(
        &self,
        context: Arc<NativeIntegrationContext>,
        request: IntegrationRequest,
    ) -> Result<IntegrationReply> {
        self.request(context, request, RuntimeControlMethod::CancelTask)
            .await
    }
    async fn request(
        &self,
        context: Arc<NativeIntegrationContext>,
        request: IntegrationRequest,
        method: RuntimeControlMethod,
    ) -> Result<IntegrationReply> {
        request.validate_method(IntegrationPort::Runtime, method.wire())?;
        context.validate_scope(&request.scope)?;
        let timeout = Duration::from_millis(request.timeout_ms);
        let (reply, response) = oneshot::channel();
        self.sender
            .try_send(Control::Request(Box::new(RuntimeControlRequest {
                context,
                request,
                method,
                reply,
            })))
            .map_err(|_| anyhow::anyhow!("RUNTIME_QUEUE_UNAVAILABLE"))?;
        // A lost cancellation acknowledgment is reconciled through its original
        // operation; elapsed client wait is never proof the stop did not execute.
        tokio::time::timeout(timeout, response)
            .await
            .map_err(|_| anyhow::anyhow!("RUNTIME_CONTROL_UNCONFIRMED"))?
            .map_err(|_| anyhow::anyhow!("RUNTIME_CONTROL_UNCONFIRMED"))
    }
}
