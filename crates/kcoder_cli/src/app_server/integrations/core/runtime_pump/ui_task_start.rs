//! First-party creation uses the same original dispatcher and creation receipt.
use super::*;
use crate::app_server::{ConnectionState, ThreadStartParams};
use tokio_util::sync::CancellationToken;

pub(in crate::app_server) trait NativeUiTaskStartAuthority:
    Send + Sync
{
    fn verify(&self, state: &ConnectionState, params: &ThreadStartParams) -> Result<()>;
}

pub(in crate::app_server) struct NativeUiTaskStartRequest {
    pub state: ConnectionState,
    pub params: ThreadStartParams,
    pub id: Value,
    pub outbound: mpsc::Sender<Value>,
    pub retired: CancellationToken,
    pub authority: Arc<dyn NativeUiTaskStartAuthority>,
    pub reply: oneshot::Sender<(ConnectionState, Result<NativeUiTaskCreated>)>,
}

pub(in crate::app_server) struct NativeUiTaskCreated {
    pub original_thread: Option<String>,
    pub owner: Option<Arc<super::NativeUiTaskOwner>>,
}

pub(in crate::app_server) struct NativeUiTaskStartDispatch<'a> {
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
    pub automations: &'a mut crate::app_server::project_automations::ProjectAutomations,
}

impl NativeUiTaskStartDispatch<'_> {
    pub(in crate::app_server) async fn dispatch(&mut self, mut request: NativeUiTaskStartRequest) {
        let before: std::collections::BTreeSet<_> = self
            .manager
            .resident_engines()
            .iter()
            .map(kcoder_engine::QueryEngine::session_id)
            .collect();
        let admitted = request.authority.verify(&request.state, &request.params);
        if let Err(error) = admitted {
            request.retired.cancel();
            let _ = request.reply.send((
                request.state,
                Err(error.context(super::NativeUiTaskResumeRejected)),
            ));
            return;
        }
        let result = Box::pin(crate::app_server::thread_creation_requests::dispatch(
            kcoder_app_protocol::method::THREAD_START,
            request.id,
            serde_json::to_value(&request.params).expect("typed original creation is serializable"),
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
            self.automations,
            &None,
            &mut request.state,
        ))
        .await
        .map(|_| ());
        // Only the authoritative original reservation/completion identifies a
        // successful task. A selected Engine or client-provided ID is insufficient.
        let completed = match crate::app_server::thread_creations::completed_original(
            self.workspace,
            &request.params,
        ) {
            Ok((thread, _, _)) => Some(thread.id),
            // The peer must also see the original RPC response. An error frame
            // needs no completion; success without this proof stays unknown.
            Err(_) => None,
        };
        let mut selected_owner = None;
        let mut retained = Ok(());
        for thread in self
            .manager
            .resident_engines()
            .iter()
            .map(kcoder_engine::QueryEngine::session_id)
        {
            if before.contains(&thread) {
                continue;
            }
            match super::NativeUiTaskOwner::capture_presentation(
                &request.state,
                self.manager,
                &thread,
                self.server,
                request.retired.clone(),
            ) {
                Ok(owner) => {
                    self.owners.retain(owner.clone());
                    if completed.as_deref() == Some(thread.as_str()) {
                        selected_owner = Some(owner);
                    }
                }
                Err(error) => retained = Err(error),
            }
        }
        if let Some(thread) = completed.as_deref()
            && self.manager.owns(thread)
        {
            retained = retained.and_then(|()| {
                crate::app_server::integrations::connectivity::task_ui::retain_original_configuration(
                    &request.state, self.manager, thread,
                )
            });
            if selected_owner.is_none() {
                match super::NativeUiTaskOwner::capture_presentation(
                    &request.state,
                    self.manager,
                    thread,
                    self.server,
                    request.retired.clone(),
                ) {
                    Ok(owner) => {
                        self.owners.retain(owner.clone());
                        selected_owner = Some(owner);
                    }
                    Err(error) => retained = Err(error),
                }
            }
        }
        let result = result
            .and(retained)
            .and_then(|()| request.authority.verify(&request.state, &request.params))
            .map(|()| NativeUiTaskCreated {
                original_thread: completed,
                owner: selected_owner,
            });
        if result.is_err() {
            request.retired.cancel();
        }
        let _ = request.reply.send((request.state, result));
    }
}

impl NativeRuntimeClient {
    pub(in crate::app_server) fn queue_ui_task_start(
        &self,
        request: NativeUiTaskStartRequest,
    ) -> std::result::Result<(), Box<NativeUiTaskStartRequest>> {
        match self
            .sender
            .try_send(Control::UiTaskStart(Box::new(request)))
        {
            Ok(()) => Ok(()),
            Err(error) => match error.into_inner() {
                Control::UiTaskStart(request) => Err(request),
                _ => unreachable!("only the original typed creation was enqueued"),
            },
        }
    }
}

impl NativeRuntimePump {
    pub(in crate::app_server) fn next_ui_task_start(&mut self) -> Option<NativeUiTaskStartRequest> {
        self.ui_task_starts.pop_front().map(|request| *request)
    }
}

pub(super) fn unavailable(request: NativeUiTaskStartRequest) {
    let _ = request.reply.send((
        request.state,
        Err(anyhow::anyhow!("TASK_UI_CREATION_NOT_QUEUED")
            .context(super::NativeUiTaskResumeRejected)),
    ));
}

#[cfg(test)]
#[path = "ui_task_start_tests.rs"]
mod tests;
