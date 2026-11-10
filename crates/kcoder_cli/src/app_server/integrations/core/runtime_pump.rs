//! Connection-owned native queue. Only private response pipes can settle command tickets.
use super::{NativeIntegrationContext, runtime_driver::*};
use crate::app_server::ThreadManager;
use crate::app_server::task_spawn::JoinSetExt as _;
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::TurnCompletedParams;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_types::integrations::core::*;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};

mod admission;
mod task_owners;
mod ui_task_call;
mod ui_task_commands;
pub(in crate::app_server) mod ui_task_read;
mod ui_task_resume;
mod ui_task_start;
pub(in crate::app_server) use ui_task_start::{
    NativeUiTaskCreated, NativeUiTaskStartAuthority, NativeUiTaskStartDispatch,
    NativeUiTaskStartRequest,
};
mod ui_task_turn;
pub(crate) use super::runtime_driver::NativeRuntimeAuthority;
pub(crate) use admission::NativeRuntimeClient;
use admission::{Admission, Control, PendingReply};
pub(in crate::app_server) use task_owners::{NativeTaskOwnerAuthority, NativeTaskOwnerRejection};
pub(in crate::app_server) use ui_task_call::NativeUiTaskCall;
pub(in crate::app_server) use ui_task_resume::{
    NativeUiTaskResumeAuthority, NativeUiTaskResumeDispatch, NativeUiTaskResumeRejected,
    NativeUiTaskResumeRequest,
};
pub(in crate::app_server) use ui_task_turn::{
    NativeUiTaskOwner, NativeUiTaskOwners, NativeUiTaskTurnAuthority, NativeUiTaskTurnDispatch,
    NativeUiTaskTurnRequest,
};
mod controls;
pub(in crate::app_server) use controls::completed_task_read;
mod rpc;

const CAPACITY: usize = 128;

struct Active {
    context: Arc<NativeIntegrationContext>,
    authority: Arc<dyn NativeRuntimeAuthority>,
    original: IntegrationRequest,
    prepared: PreparedRuntimeTask,
    published_revision: u64,
}

struct InFlight {
    ticket: NativeRuntimeTicket,
    context: Arc<NativeIntegrationContext>,
}
enum JobResult {
    Launched(
        NativeRuntimeTicket,
        Arc<NativeIntegrationContext>,
        Result<()>,
    ),
    Stopped(NativeRuntimeTicket, Arc<NativeIntegrationContext>, bool),
}

pub(crate) enum RuntimePumpEvent {
    Control(Control),
    PrivateFrame(Value),
    Tick,
    Job(Result<(), tokio::task::JoinError>),
}

/// The caller passes this frame directly to the ordinary native dispatch. It is
/// never reconstructed from a public JSON ID or accepted from the client pipe.
pub(crate) struct NativeGeneratedRequest {
    pub(crate) ticket: NativeRuntimeTicket,
    pub(crate) accepted_observer: Option<Arc<NativeRuntimeAcceptedObserver>>,
    pub(crate) thread_initializer: Option<Arc<NativeRuntimeThreadInitializer>>,
    pub(crate) method: &'static str,
    pub(crate) params: Value,
    pub(crate) outbound: mpsc::Sender<Value>,
}

pub(crate) struct NativeRuntimePump {
    rpc_requests: std::collections::VecDeque<
        std::sync::Mutex<Box<crate::app_server::rpc_connection::RpcRequest>>,
    >,
    rpc_hub: crate::app_server::rpc_hub::RpcHub,
    ui_task_owners: NativeUiTaskOwners,
    ui_task_turns: std::collections::VecDeque<Box<NativeUiTaskTurnRequest>>,
    ui_task_resumes: std::collections::VecDeque<Box<NativeUiTaskResumeRequest>>,
    ui_task_starts: std::collections::VecDeque<Box<NativeUiTaskStartRequest>>,
    ui_task_reads: std::collections::VecDeque<Box<ui_task_read::NativeUiTaskReadRequest>>,
    task_owners: Arc<std::sync::atomic::AtomicBool>,
    task_owner_validation_at: Instant,
    task_state_notifications: bool,
    accepted_owner: Arc<()>,
    driver: Option<NativeRuntimeDriver>,
    controls: mpsc::Receiver<Control>,
    private_frames: mpsc::Receiver<Value>,
    private_outbound: mpsc::Sender<Value>,
    active: BTreeMap<String, Active>,
    in_flight: BTreeMap<String, InFlight>,
    pending: Vec<PendingReply>,
    jobs: tokio::task::JoinSet<()>,
    job_results_tx: mpsc::Sender<JobResult>,
    job_results_rx: mpsc::Receiver<JobResult>,
    tick: tokio::time::Interval,
}

impl NativeRuntimePump {
    pub(crate) fn new() -> (Self, NativeRuntimeClient) {
        let task_owners = task_owners::availability();
        let (control_tx, controls) = mpsc::channel(CAPACITY);
        let (private_outbound, private_frames) = mpsc::channel(CAPACITY * 4);
        let (job_results_tx, job_results_rx) = mpsc::channel(CAPACITY);
        let rpc_hub = crate::app_server::rpc_hub::RpcHub::default();
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        (
            Self {
                rpc_requests: Default::default(),
                rpc_hub: rpc_hub.clone(),
                ui_task_owners: NativeUiTaskOwners::default(),
                ui_task_turns: std::collections::VecDeque::new(),
                ui_task_resumes: std::collections::VecDeque::new(),
                ui_task_starts: std::collections::VecDeque::new(),
                ui_task_reads: std::collections::VecDeque::new(),
                task_owners: task_owners.clone(),
                task_owner_validation_at: Instant::now(),
                task_state_notifications: false,
                accepted_owner: Arc::new(()),
                driver: None,
                controls,
                private_frames,
                private_outbound,
                active: BTreeMap::new(),
                in_flight: BTreeMap::new(),
                pending: vec![],
                jobs: tokio::task::JoinSet::new(),
                job_results_tx,
                job_results_rx,
                tick,
            },
            NativeRuntimeClient {
                rpc_hub,
                sender: kcoder_host_transport::control_sender::ControlSender::new(control_tx),
                task_owners,
            },
        )
    }

    /// Test-owned observation of the actual original queue receipts; never a source permit.
    #[cfg(test)]
    pub(crate) fn owned_original_receipts(&self) -> Result<Vec<IntegrationOperationReceipt>> {
        let Some(driver) = &self.driver else {
            return Ok(Vec::new());
        };
        self.active
            .iter()
            .map(|(operation, entry)| {
                driver
                    .read_operation(&entry.context, operation)?
                    .context("RUNTIME_BINDING_MISSING")
            })
            .collect()
    }
    pub(crate) fn set_task_state_notifications(&mut self, negotiated: bool) {
        self.task_state_notifications = negotiated;
    }

    pub(crate) async fn receive(&mut self) -> RuntimePumpEvent {
        tokio::select! {
            Some(control) = self.controls.recv() => RuntimePumpEvent::Control(control),
            Some(frame) = self.private_frames.recv() => RuntimePumpEvent::PrivateFrame(frame),
            job = self.jobs.join_next(), if !self.jobs.is_empty() => RuntimePumpEvent::Job(job.unwrap()),
            _ = self.tick.tick() => RuntimePumpEvent::Tick,
        }
    }

    pub(crate) async fn observe(
        &mut self,
        event: RuntimePumpEvent,
        outbound: &mpsc::Sender<Value>,
        manager: &ThreadManager,
    ) -> Result<()> {
        match event {
            RuntimePumpEvent::Control(control) => {
                if matches!(&control, Control::Accept(_)) {
                    eprintln!(
                        "{}",
                        serde_json::json!({"event":"native_runtime_ticket_stage","stage":"core_control_observed"})
                    );
                }
                self.control(control)
            }
            RuntimePumpEvent::PrivateFrame(frame) => {
                if let Some(id) = frame.get("id").and_then(Value::as_str) {
                    // This map is reachable only from the owning private pipe.
                    if let Some(command) = self.in_flight.remove(id)
                        && let Some(driver) = &mut self.driver
                    {
                        use sha2::{Digest, Sha256};
                        // This is the original private response, not a caller supplied frame.
                        eprintln!(
                            "{}",
                            json!({"event":"native_runtime_private_response",
                            "hasRpcError":frame.get("error").is_some(),
                            "errorCode":frame.get("error").and_then(|error|error.get("code")).and_then(Value::as_i64),
                            "errorMessageSha256":frame.get("error").and_then(|error|error.get("message")).and_then(Value::as_str).map(|message|format!("{:x}",Sha256::digest(message)))})
                        );
                        if let Err(error) =
                            driver.observe_response(&command.context, &command.ticket, &frame)
                        {
                            eprintln!(
                                "{}",
                                json!({"event":"native_runtime_response_unconfirmed",
                                "reasonSha256":error.chain().take(4).map(|cause|format!("{:x}",Sha256::digest(cause.to_string()))).collect::<Vec<_>>()})
                            );
                            let _ = driver.abandon_command(&command.context, &command.ticket);
                        }
                    }
                } else if let Some(method) = frame.get("method").and_then(Value::as_str) {
                    if method == "turn/completed"
                        && let Ok(event) =
                            rpc_codec::decode::<TurnCompletedParams>(frame["params"].clone())
                        && let Some(driver) = &mut self.driver
                        && let Ok(Some(operation)) = driver.tracked_turn_operation(&event)
                        && let Some(entry) = self.active.get(operation)
                    {
                        let matched = driver
                            .observe_turn_completed(&entry.context, &event)
                            .is_ok_and(|matched| matched);
                        if matched {
                            // The driver proved the original tracked and accepted thread/turn.
                            // Decode only the finite Provider failure type from this private frame.
                            let failure = frame["params"]["error"]
                                .get("details")
                                .or_else(|| frame["params"]["error"].get("data"))
                                .and_then(|value| {
                                    serde_json::from_value::<kcoder_types::ProviderFailureDetails>(
                                        value.clone(),
                                    )
                                    .ok()
                                });
                            eprintln!(
                                "{}",
                                json!({"event":"native_runtime_owned_turn_failure_type",
                                        "hasTypedProviderFailure":failure.is_some(),
                                        "category":failure.as_ref().map(|value|value.category),
                                        "httpStatus":failure.as_ref().and_then(|value|value.http_status)})
                            );
                        }
                    }
                    // Real notifications retain the ordinary client rendering and
                    // interaction channel. Internal RPC results never reach stdout.
                    let presentation_item = matches!(
                        method,
                        kcoder_app_protocol::method::ITEM_STARTED
                            | kcoder_app_protocol::method::ITEM_DELTA
                            | kcoder_app_protocol::method::ITEM_COMPLETED
                    );
                    outbound
                        .send(frame)
                        .await
                        .map_err(|_| anyhow::anyhow!("RUNTIME_CLIENT_DISCONNECTED"))?;
                    // An item frame cannot advance the accepted task state. Let
                    // terminal frames, control requests and recovery ticks do
                    // that work without stalling each streamed text/tool item.
                    if presentation_item {
                        return Ok(());
                    }
                }
            }
            RuntimePumpEvent::Job(result) => {
                if result.is_err() {
                    tracing::warn!("owned native workflow job failed");
                }
            }
            RuntimePumpEvent::Tick => {}
        }
        while let Ok(result) = self.job_results_rx.try_recv() {
            if let Some(driver) = &mut self.driver {
                match result {
                    JobResult::Launched(ticket, context, result) => {
                        let _ = driver.observe_workflow_launch(&context, &ticket, result);
                    }
                    JobResult::Stopped(ticket, context, stopped) => {
                        let _ = driver.observe_workflow_stop(&context, &ticket, stopped);
                    }
                }
            }
        }
        let mut retired = Vec::new();
        if let Some(driver) = &mut self.driver {
            for (operation, entry) in &mut self.active {
                if entry.prepared.configuration.workflow.is_some()
                    && let Ok(task) = driver.read_task(&entry.context, operation)
                    && task.task_id.is_some()
                {
                    let _ = driver.refresh_workflow(&entry.context, operation);
                    if driver
                        .read_task(&entry.context, operation)
                        .is_ok_and(|current| current.state == IntegrationTaskState::Completed)
                        && let Some(engine) = manager.engine(&task.thread_id)
                    {
                        let _ = driver.observe_workflow_output(&entry.context, operation, &engine);
                    }
                }
                if let Ok((task, observation)) =
                    driver.task_state_observation(&entry.context, operation, false)
                    && entry
                        .authority
                        .observe_task(&entry.context, &entry.original, &task)
                        .is_ok()
                {
                    if self.task_state_notifications
                        && observation.revision > entry.published_revision
                    {
                        entry.context.verify()?;
                        outbound
                            .send(crate::app_server::notification(
                                kcoder_app_protocol::integrations::host::INTEGRATION_TASK_STATE_CHANGED,
                                serde_json::to_value(&observation)?,
                            ))
                            .await
                            .map_err(|_| anyhow::anyhow!("RUNTIME_CLIENT_DISCONNECTED"))?;
                        entry.published_revision = observation.revision;
                    }
                    if matches!(
                        task.state,
                        IntegrationTaskState::Completed
                            | IntegrationTaskState::Failed
                            | IntegrationTaskState::Cancelled
                    ) {
                        retired.push(operation.clone());
                    }
                }
            }
        }
        self.settle_waiters(|_| true);
        // Successful terminal observation releases only this run's in-memory
        // authority. Durable receipts and uncertain task reservations remain.
        for operation in retired {
            if !self
                .pending
                .iter()
                .any(|pending| pending.operation == operation)
                && !self
                    .in_flight
                    .values()
                    .any(|flight| flight.ticket.operation_id() == operation)
            {
                self.active.remove(&operation);
            }
        }
        Ok(())
    }

    fn control(&mut self, control: Control) {
        let Control::Accept(control) = control else {
            match control {
                Control::Request(request) => self.control_request(*request),
                Control::TaskOwner(request) => task_owners::unavailable(*request),
                Control::UiTaskResume(request) => ui_task_resume::unavailable(*request),
                Control::UiTaskStart(request) => ui_task_start::unavailable(*request),
                Control::UiTaskRead(request) => ui_task_read::unavailable(*request),
                Control::UiTaskTurn(request) => ui_task_turn::unavailable(*request),
                Control::RpcConnection(request) => {
                    crate::app_server::rpc_connection::unavailable(*request)
                }
                Control::Accept(_) => unreachable!(),
            }
            return;
        };
        let request = control.request.clone();
        let result = self.accept_control(*control);
        if let Err((reply, error)) = result {
            let _ = reply.send(failed(&request, IntegrationStatus::Unavailable, error));
        }
    }

    fn accept_control(
        &mut self,
        control: Admission,
    ) -> std::result::Result<(), (oneshot::Sender<IntegrationReply>, &'static str)> {
        let Admission {
            context,
            request,
            prepared,
            authority,
            reply,
        } = control;
        let submission = (|| -> Result<RuntimeSubmission> {
            context.check_captured_scope(&request.scope)?;
            authority.verify_before_admission_commit(&context, &request, &prepared)?;
            ensure!(
                self.pending.len() < CAPACITY && self.active.len() < 4096,
                "RUNTIME_QUEUE_FULL"
            );
            if self.driver.is_none() {
                self.driver = NativeRuntimeDriver::load(&context)?;
            }
            if self.driver.is_none() {
                self.driver = Some(NativeRuntimeDriver::initialize(
                    &context,
                    request
                        .operation_id
                        .as_deref()
                        .context("RUNTIME_OPERATION_REQUIRED")?,
                )?);
            }
            self.driver
                .as_mut()
                .context("RUNTIME_UNAVAILABLE")?
                .accept_task(&context, &request, prepared.clone())
        })();
        match submission {
            Ok(RuntimeSubmission::Known(acceptance)) => {
                let _ = reply.send(accepted(&request, acceptance));
            }
            Ok(RuntimeSubmission::Queued) => {
                let operation = request.operation_id.clone().unwrap();
                self.active.insert(
                    operation.clone(),
                    Active {
                        context: context.clone(),
                        authority,
                        original: request.clone(),
                        prepared,
                        published_revision: 0,
                    },
                );
                self.pending.push(PendingReply {
                    operation,
                    request: request.clone(),
                    context,
                    deadline: Instant::now() + Duration::from_millis(request.timeout_ms),
                    reply,
                });
            }
            Ok(RuntimeSubmission::Unconfirmed) => {
                let _ = reply.send(failed(
                    &request,
                    IntegrationStatus::Unknown,
                    "RUNTIME_ACCEPTANCE_UNCONFIRMED",
                ));
            }
            Err(_) => return Err((reply, "RUNTIME_ADMISSION_UNAVAILABLE")),
        }
        Ok(())
    }

    pub(crate) fn next_request(
        &mut self,
        manager: &mut ThreadManager,
    ) -> Result<Option<NativeGeneratedRequest>> {
        loop {
            let Some(driver) = &mut self.driver else {
                return Ok(None);
            };
            let Some(operation) = driver.next_operation_id().map(str::to_owned) else {
                return Ok(None);
            };
            let entry = self
                .active
                .get(&operation)
                .context("RUNTIME_ADMISSION_AUTHORITY_MISSING")?;
            let cleanup = driver.queued_cleanup(&entry.context, &operation)?;
            if !cleanup
                && entry
                    .authority
                    .verify_admission(&entry.context, &entry.original, &entry.prepared)
                    .is_err()
            {
                driver.reject_queued_admission(&entry.context, &operation)?;
                continue;
            }
            if !cleanup
                && let Some(thread) = entry.prepared.existing_thread_id.as_deref()
                && manager.owns(thread)
                && let Some(reason) = manager.session_pause_reason(thread)?
            {
                // Reject the original queued input with its original receipt;
                // reopening a view never re-enqueues this operation.
                driver.reject_queued_with_reason(&entry.context, &operation, reason)?;
                continue;
            }
            let Some(command) = driver.next_command(&entry.context)? else {
                continue;
            };
            match command {
                NativeRuntimeCommand::Configure {
                    ticket,
                    thread_id,
                    configuration: _configuration,
                } => {
                    if manager.engine(&thread_id).is_none() && entry.authority.pre_start().is_some()
                    {
                        let restored = driver
                            .restore_thread_params(&entry.context, &ticket)
                            .and_then(|params| {
                                let initializer = driver
                                    .thread_initializer(
                                        &entry.context,
                                        &ticket,
                                        &params,
                                        entry.authority.clone(),
                                        Arc::downgrade(&self.accepted_owner),
                                    )?
                                    .context("RUNTIME_PRE_START_POLICY_UNAVAILABLE")?;
                                Ok((params, initializer))
                            });
                        let (params, initializer) = match restored {
                            Ok(restored) => restored,
                            Err(_) => {
                                let _ = driver.abandon_command(&entry.context, &ticket);
                                continue;
                            }
                        };
                        self.in_flight.insert(
                            ticket.id().into(),
                            InFlight {
                                ticket: ticket.clone(),
                                context: entry.context.clone(),
                            },
                        );
                        return Ok(Some(NativeGeneratedRequest {
                            ticket,
                            accepted_observer: None,
                            thread_initializer: Some(initializer),
                            method: "thread/resume",
                            params,
                            outbound: self.private_outbound.clone(),
                        }));
                    }
                    let _ = driver.configure_command(
                        &entry.context,
                        &ticket,
                        manager,
                        Some(entry.authority.installer()),
                    );
                }
                NativeRuntimeCommand::Rpc {
                    ticket,
                    method,
                    params,
                } => {
                    let params = if method == "turn/start" {
                        let installer = entry.authority.installer();
                        match driver.prepare_turn_dispatch(
                            &entry.context,
                            &ticket,
                            manager,
                            Some(installer),
                        ) {
                            Ok(params) => params,
                            Err(_) => {
                                if installer.configures_bound_resident_at_turn_dispatch() {
                                    // No RPC has been routed. Keep a confirmed
                                    // configuration rejection on the original operation.
                                    let _ = driver.reject_generated_turn(
                                        &entry.context,
                                        &ticket,
                                        "RUNTIME_CONFIGURATION_REJECTED",
                                    );
                                } else {
                                    let _ = driver.abandon_command(&entry.context, &ticket);
                                }
                                continue;
                            }
                        }
                    } else {
                        params
                    };
                    if method == "turn/start"
                        && let Some(ended) = entry.authority.client_cancellation()
                    {
                        let thread = params
                            .get("threadId")
                            .and_then(Value::as_str)
                            .context("RUNTIME_THREAD_NOT_RESIDENT")?;
                        let activity = manager
                            .followups(thread)
                            .context("RUNTIME_THREAD_NOT_RESIDENT")?;
                        let owner: Arc<dyn Send + Sync> = entry.authority.clone();
                        activity.session_activity.attach_runtime(&owner, ended)?;
                    }
                    let accepted_observer = if method == "turn/start" {
                        let engine = params
                            .get("threadId")
                            .and_then(Value::as_str)
                            .and_then(|thread| manager.engine(thread))
                            .context("RUNTIME_THREAD_NOT_RESIDENT")?;
                        match driver.accepted_observer(
                            &entry.context,
                            &ticket,
                            &engine,
                            &params,
                            entry.authority.clone(),
                            Arc::downgrade(&self.accepted_owner),
                        ) {
                            Ok(observer) => Some(Arc::new(observer)),
                            Err(_) => {
                                let _ = driver.abandon_command(&entry.context, &ticket);
                                continue;
                            }
                        }
                    } else {
                        None
                    };
                    let thread_initializer = if method == "thread/start" {
                        match driver.thread_initializer(
                            &entry.context,
                            &ticket,
                            &params,
                            entry.authority.clone(),
                            Arc::downgrade(&self.accepted_owner),
                        ) {
                            Ok(initializer) => initializer,
                            Err(_) => {
                                let _ = driver.abandon_command(&entry.context, &ticket);
                                continue;
                            }
                        }
                    } else {
                        None
                    };
                    self.in_flight.insert(
                        ticket.id().into(),
                        InFlight {
                            ticket: ticket.clone(),
                            context: entry.context.clone(),
                        },
                    );
                    return Ok(Some(NativeGeneratedRequest {
                        ticket,
                        accepted_observer,
                        thread_initializer,
                        method,
                        params,
                        outbound: self.private_outbound.clone(),
                    }));
                }
                NativeRuntimeCommand::StartWorkflow {
                    ticket,
                    thread_id,
                    workflow: _workflow,
                } => {
                    let prepared = manager
                        .engine(&thread_id)
                        .context("RUNTIME_THREAD_NOT_RESIDENT")
                        .and_then(|engine| {
                            driver.prepare_workflow_launch(
                                &entry.context,
                                &ticket,
                                engine,
                                Some(entry.authority.clone()),
                            )
                        });
                    match prepared {
                        Ok(job) => {
                            let sender = self.job_results_tx.clone();
                            let context = entry.context.clone();
                            self.jobs.spawn_shared(async move {
                                let result = job.run().await;
                                let _ = sender
                                    .send(JobResult::Launched(ticket, context, result))
                                    .await;
                            });
                        }
                        Err(_) => {
                            let _ = driver.observe_workflow_launch(
                                &entry.context,
                                &ticket,
                                Err(anyhow::anyhow!("RUNTIME_WORKFLOW_NATIVE_REJECTED")),
                            );
                        }
                    }
                }
                NativeRuntimeCommand::StopWorkflow {
                    ticket,
                    thread_id,
                    run_id: _run_id,
                } => {
                    let prepared = manager
                        .engine(&thread_id)
                        .context("RUNTIME_THREAD_NOT_RESIDENT")
                        .and_then(|engine| {
                            driver.prepare_workflow_stop(&entry.context, &ticket, engine)
                        });
                    match prepared {
                        Ok(job) => {
                            let sender = self.job_results_tx.clone();
                            let context = entry.context.clone();
                            self.jobs.spawn_shared(async move {
                                let result = job.run().await;
                                let _ = sender
                                    .send(JobResult::Stopped(ticket, context, result))
                                    .await;
                            });
                        }
                        Err(_) => {
                            let _ = driver.abandon_command(&entry.context, &ticket);
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn dispatch_failed(&mut self, ticket: &NativeRuntimeTicket) {
        if let Some(command) = self.in_flight.remove(ticket.id())
            && let Some(driver) = &mut self.driver
        {
            let _ = driver.abandon_command(&command.context, &command.ticket);
        }
    }

    fn settle_waiters(&mut self, matches: impl Fn(&PendingReply) -> bool) {
        let mut retained = Vec::new();
        for pending in self.pending.drain(..) {
            if pending.reply.is_closed() {
                continue;
            }
            if !matches(&pending) {
                retained.push(pending);
                continue;
            }
            let receipt = self
                .driver
                .as_ref()
                .and_then(|driver| {
                    driver
                        .read_operation(&pending.context, &pending.operation)
                        .ok()
                })
                .flatten();
            if let Some(acceptance) = receipt
                .as_ref()
                .and_then(|receipt| receipt.runtime_acceptance.clone())
            {
                let _ = pending.reply.send(accepted(&pending.request, acceptance));
            } else if receipt
                .as_ref()
                .is_some_and(|receipt| receipt.phase == IntegrationOperationPhase::Rejected)
            {
                let _ = pending.reply.send(failed(
                    &pending.request,
                    IntegrationStatus::Rejected,
                    match receipt
                        .as_ref()
                        .and_then(|receipt| receipt.error.as_ref())
                        .map(|error| error.code.as_str())
                    {
                        Some("SESSION_PAUSED_NO_CLIENT") => "SESSION_PAUSED_NO_CLIENT",
                        Some("SESSION_BACKGROUND_AUTHORIZATION_REQUIRED") => {
                            "SESSION_BACKGROUND_AUTHORIZATION_REQUIRED"
                        }
                        _ => "RUNTIME_ADMISSION_EXPIRED",
                    },
                ));
            } else if pending.deadline <= Instant::now()
                || receipt.as_ref().is_some_and(|receipt| {
                    receipt.phase == IntegrationOperationPhase::Unknown
                        || receipt.phase.is_terminal()
                })
            {
                let _ = pending.reply.send(failed(
                    &pending.request,
                    IntegrationStatus::Unknown,
                    "RUNTIME_ACCEPTANCE_UNCONFIRMED",
                ));
            } else {
                retained.push(pending);
            }
        }
        self.pending = retained;
    }

    pub(crate) async fn close(mut self) {
        self.rpc_hub.close().await;
        self.task_owners
            .store(false, std::sync::atomic::Ordering::Release);
        for (_, command) in self.in_flight {
            if let Some(driver) = &mut self.driver {
                let _ = driver.abandon_command(&command.context, &command.ticket);
            }
        }
        self.jobs.abort_all();
        while self.jobs.join_next().await.is_some() {}
        for pending in self.pending {
            let _ = pending.reply.send(failed(
                &pending.request,
                IntegrationStatus::Unknown,
                "RUNTIME_ACCEPTANCE_UNCONFIRMED",
            ));
        }
    }
}

fn accepted(
    request: &IntegrationRequest,
    acceptance: IntegrationRuntimeAcceptance,
) -> IntegrationReply {
    IntegrationReply {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: request.request_id.clone(),
        status: IntegrationStatus::Accepted,
        operation_id: IntegrationNullable::Value(request.operation_id.clone().unwrap()),
        entity_revision: IntegrationNullable::Null,
        observed_at: chrono::Utc::now().to_rfc3339(),
        result: IntegrationNullable::Value(json!(acceptance).as_object().unwrap().clone()),
        error: IntegrationNullable::Null,
    }
}
fn failed(
    request: &IntegrationRequest,
    status: IntegrationStatus,
    code: &'static str,
) -> IntegrationReply {
    IntegrationReply {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: request.request_id.clone(),
        status,
        operation_id: request
            .operation_id
            .clone()
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        entity_revision: IntegrationNullable::Null,
        observed_at: chrono::Utc::now().to_rfc3339(),
        result: IntegrationNullable::Null,
        error: IntegrationNullable::Value(IntegrationError {
            code: code.into(),
            message_key: "integrations.runtime.unavailable".into(),
            recovery: if status == IntegrationStatus::Rejected {
                IntegrationRecovery::RequestAuthorization
            } else {
                IntegrationRecovery::ReconcileOriginal
            },
        }),
    }
}

#[cfg(test)]
mod tests;
