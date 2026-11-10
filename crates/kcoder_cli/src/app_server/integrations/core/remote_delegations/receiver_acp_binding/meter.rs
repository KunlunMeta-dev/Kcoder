//! Actual Receiver Provider admission; the Source and Receiver keep their own ledgers.
use super::*;
use crate::app_server::integrations::core::budget_host::NativeBudgetService;
use kcoder_engine::native_model_requests::*;
use kcoder_state::{
    AppStateLifecycleIdentity,
    integrations::core::budgets::*,
    turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore},
};
use kcoder_types::{
    MessagesRequest, ModelConfigurationSummary, TurnAttemptIdentity, TurnAttemptStatus, Usage,
};
use std::sync::Mutex;

pub(super) struct Meter {
    binding: Arc<NativeAcpReceiverBinding>,
    engine: QueryEngine,
    state: AppStateLifecycleIdentity,
    accepted: TurnAttemptRecord,
    facts: NativeRemoteAcceptedFactsV1,
    model: ModelConfigurationSummary,
    service: NativeBudgetService,
    principal: NativeBudgetPrincipal,
    slot: String,
    provider: Mutex<Option<Arc<dyn kcoder_api::Provider>>>,
}

pub(super) struct Artifact {
    pub manifest: kcoder_types::integrations::office::OfficeArtifactManifest,
    pub bytes: Vec<u8>,
}

impl Meter {
    pub(super) fn verify_facts(&self, supplied: &NativeRemoteAcceptedFactsV1) -> Result<()> {
        self.binding.verify_owner()?;
        ensure!(
            supplied == &self.facts,
            "REMOTE_RECEIVER_ARTIFACT_OWNER_CHANGED"
        );
        Ok(())
    }
    pub(super) fn artifact(&self, supplied: &NativeRemoteAcceptedFactsV1) -> Result<Artifact> {
        ensure!(
            supplied == &self.facts,
            "REMOTE_RECEIVER_ARTIFACT_OWNER_CHANGED"
        );
        let outcome = self.observe_original()?;
        ensure!(
            matches!(
                outcome,
                NativeRemoteReceiptDataV1::Receiver {
                    outcome: Some(NativeRemoteCallOutcomeV1::Completed),
                    ..
                }
            ),
            "REMOTE_RECEIVER_ORIGINAL_COMPLETION_REQUIRED"
        );
        let native = &self.binding.receiver;
        let guard = crate::app_server::integrations::core::NativeDomainGuard::observe(
            native.profile()?,
            native.scope(),
            crate::app_server::integrations::core::NativeDomain::Office,
        )?
        .context("REMOTE_RECEIVER_OFFICE_STORE_REQUIRED")?;
        let store = kcoder_state::integrations::office::OfficeStore::open_in(
            &guard.directory(native.profile()?)?,
            OsStr::new("data"),
            IntegrationOwner::from(native.scope()),
        )?
        .context("REMOTE_RECEIVER_OFFICE_STORE_REQUIRED")?;
        let mut manifests = store
            .list_artifacts(&self.accepted.identity.thread_id)?
            .into_iter()
            .filter(|manifest| {
                manifest.task.turn_id == self.accepted.identity.turn_id
                    && manifest.task.run_id.is_none()
                    && self
                        .binding
                        .input()
                        .is_ok_and(|input| input.allowed_output_formats.contains(&manifest.format))
            })
            .collect::<Vec<_>>();
        ensure!(
            manifests.len() == 1,
            "REMOTE_RECEIVER_OFFICE_RESULT_AMBIGUOUS"
        );
        let manifest = manifests
            .pop()
            .context("REMOTE_RECEIVER_OFFICE_RESULT_REQUIRED")?;
        manifest.validate()?;
        ensure!(
            manifest.owner == IntegrationOwner::from(native.scope())
                && manifest.bytes <= 32 * 1024 * 1024,
            "REMOTE_RECEIVER_OFFICE_RESULT_CHANGED"
        );
        let reference = kcoder_types::integrations::office::OfficeArtifactRef {
            id: manifest.id.clone(),
            revision: manifest.revision,
        };
        let mut bytes = Vec::new();
        while (bytes.len() as u64) < manifest.bytes {
            self.binding.verify_owner()?;
            let (chunk, total) =
                store.read_artifact_chunk(&reference, bytes.len() as u64, 192 * 1024)?;
            ensure!(
                total == manifest.bytes
                    && !chunk.is_empty()
                    && chunk.len() as u64 <= total - bytes.len() as u64,
                "REMOTE_RECEIVER_OFFICE_RESULT_CHANGED"
            );
            bytes.extend(chunk);
        }
        ensure!(
            format!("{:x}", Sha256::digest(&bytes)) == manifest.sha256,
            "REMOTE_RECEIVER_OFFICE_RESULT_CHANGED"
        );
        Ok(Artifact { manifest, bytes })
    }
    pub(super) fn observe_original(&self) -> Result<NativeRemoteReceiptDataV1> {
        self.binding.verify_owner()?;
        let store = TurnAttemptStore::open_existing(
            &self
                .engine
                .session_storage_dir_for(&self.accepted.identity.thread_id),
            &self.accepted.identity.thread_id,
        )?
        .context("REMOTE_RECEIVER_NATIVE_TASK_REQUIRED")?;
        let actual = store
            .load(&self.accepted.identity)?
            .context("REMOTE_RECEIVER_NATIVE_TASK_REQUIRED")?;
        let mut original = actual.clone();
        original.status = TurnAttemptStatus::Accepted;
        original.completion = None;
        ensure!(
            original == self.accepted,
            "REMOTE_RECEIVER_NATIVE_TASK_CHANGED"
        );
        let outcome = match actual.status {
            TurnAttemptStatus::Completed => Some(NativeRemoteCallOutcomeV1::Completed),
            TurnAttemptStatus::Failed => Some(NativeRemoteCallOutcomeV1::Failed),
            TurnAttemptStatus::Interrupted => Some(NativeRemoteCallOutcomeV1::Interrupted),
            _ => None,
        };
        if outcome.is_some() && actual.completion.is_some() {
            let ledger = self.service.accounting_store();
            if ledger.original_task_calls_closed(&self.slot, &self.principal)? {
                let receipt = ledger
                    .read_reservation(&self.slot)?
                    .context("REMOTE_RECEIVER_NATIVE_SLOT_REQUIRED")?;
                if !receipt.execution_confirmed_terminal {
                    let kind = match actual.status {
                        TurnAttemptStatus::Completed => BudgetTerminalKind::Completed,
                        TurnAttemptStatus::Interrupted => BudgetTerminalKind::Cancelled,
                        _ => BudgetTerminalKind::Failed,
                    };
                    let terminal = NativeBudgetTerminal::from_authoritative_receipt(
                        receipt.operation_id.clone(),
                        receipt.task.root_task.clone(),
                        receipt.task.actor_attempt_id.clone(),
                        format!("receiver-task-end-{}", actual.identity.attempt_id),
                        super::super::launch::digest(&actual)?,
                        kind,
                    )?;
                    ledger.record_usage(
                        &self.slot,
                        receipt.revision,
                        "actual-receiver-task-terminal",
                        &NativeBudgetUsage {
                            coverage: BudgetUsageCoverage::Complete,
                            known: BudgetCharge::zero(),
                        },
                        Some(&terminal),
                        super::super::launch::now()?,
                    )?;
                }
            }
        }
        Ok(NativeRemoteReceiptDataV1::Receiver {
            accepted: self.facts.clone(),
            outcome,
            cleanup_confirmed: false,
        })
    }
    pub(super) fn install(
        binding: Arc<NativeAcpReceiverBinding>,
        engine: QueryEngine,
        attempt: &TurnAttemptIdentity,
        execution: kcoder_engine::integrations::core::NativeToolExecutionWitness,
    ) -> Result<(QueryEngine, Arc<Self>)> {
        binding.verify()?;
        ensure!(
            execution.attempt() == Some(attempt)
                && execution.matches_state(&engine.state)
                && execution.parent().is_none(),
            "REMOTE_RECEIVER_NATIVE_ATTEMPT_REQUIRED"
        );
        let store = TurnAttemptStore::open_existing(
            &engine.session_storage_dir_for(&attempt.thread_id),
            &attempt.thread_id,
        )?
        .context("REMOTE_RECEIVER_NATIVE_TASK_REQUIRED")?;
        let accepted = store
            .load(attempt)?
            .context("REMOTE_RECEIVER_NATIVE_TASK_REQUIRED")?;
        ensure!(
            accepted.status == TurnAttemptStatus::Accepted && accepted.completion.is_none(),
            "REMOTE_RECEIVER_NATIVE_TASK_NOT_ACTIVE"
        );
        let policy = binding.policy()?;
        let engine = engine.with_native_tool_ceiling(if policy.office.enabled {
            &policy.office.allowed_tools
        } else {
            &[]
        })?;
        let model = kcoder_engine::model_configuration_summary(
            &*engine
                .settings
                .read()
                .map_err(|_| anyhow::anyhow!("REMOTE_RECEIVER_NATIVE_MODEL_REQUIRED"))?,
            kcoder_types::ModelConfigurationBoundary::SessionSnapshot,
        )?;
        super::super::super::organization_model::validate_model_input(&model)?;
        let facts = NativeRemoteAcceptedFactsV1 {
            identity: attempt.into(),
            accepted_input_sha256: binding.input()?.frozen_input_sha256.clone(),
            accepted_receipt_sha256: super::super::launch::digest(&accepted)?,
            receiver_settings_sha256: binding.receiver_settings_sha256.clone(),
            receiver_scope: Some(binding.receiver.scope().clone()),
        };
        let reply = binding.source_control(
            format!("receiver-accepted-{}", attempt.attempt_id),
            NativeRemoteControlDataV1::ReceiverAccepted(facts.clone()),
        )?;
        ensure!(
            matches!(reply.data, NativeRemoteReceiptDataV1::Receiver { accepted: ref actual, .. } if actual == &facts),
            "REMOTE_RECEIVER_SOURCE_ACCEPTANCE_CHANGED"
        );
        let service =
            NativeBudgetService::initialize(&binding.receiver, &binding.original.operation_id)?;
        let principal = NativeBudgetPrincipal::from_native_facts(
            binding.receiver.scope().account_id.clone(),
            None,
            binding.receiver.scope().workspace_id.as_ref().cloned(),
            None,
        )?;
        let ledger = service.accounting_store();
        let operation = &binding.original.operation_id;
        let policy = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
            id: "native-remote-receiver-task".into(),
            version: 1,
            revision: binding.receiver_settings_sha256.clone(),
            scope: BudgetScope::Task(operation.clone()),
            window: BudgetWindow {
                id: operation.clone(),
                starts_at_ms: 0,
                ends_at_ms: binding.input()?.deadline_utc_ms,
            },
            limits: BudgetLimits {
                tokens: Some(policy.maximum_total_tokens),
                model_calls: Some(u64::from(policy.maximum_model_calls)),
                concurrent_tasks: Some(1),
                concurrent_calls: Some(1),
                ..Default::default()
            },
            currency: None,
        })?;
        let mut policies = ledger.current_applicable_policies(
            &principal,
            operation,
            super::super::launch::now()?,
        )?;
        policies.push(policy);
        let slot = format!("receiver-slot-{}", super::super::launch::digest(attempt)?);
        let receipt = ledger.reserve(
            &NativeBudgetRequest {
                reservation_id: slot.clone(),
                operation_id: operation.clone(),
                principal: principal.clone(),
                unit: BudgetUnit::TaskSlot,
                task: BudgetTaskLink {
                    root_operation_id: operation.clone(),
                    root_task: Some(IntegrationEntityRef {
                        kind: IntegrationEntityKind::Turn,
                        id: attempt.turn_id.clone(),
                        revision: None,
                    }),
                    actor: BudgetActor::Main,
                    actor_attempt_id: attempt.attempt_id.clone(),
                    parent_reservation_id: None,
                },
                estimate: BudgetCharge::zero(),
            },
            &policies,
            super::super::launch::now()?,
        )?;
        ensure!(
            matches!(receipt, BudgetReservationResult::Created(_)),
            "REMOTE_RECEIVER_ORIGINAL_TASK_ALREADY_OBSERVED"
        );
        let meter = Arc::new(Self {
            binding,
            state: engine.state.inspection_lifecycle_identity(),
            engine: engine.clone(),
            accepted,
            facts,
            model,
            service,
            principal,
            slot,
            provider: Mutex::new(None),
        });
        let engine = engine
            .with_additional_native_model_request_observer(Arc::new(Adapter(meter.clone())))?;
        Ok((engine, meter))
    }

    fn verify(&self) -> Result<()> {
        self.binding.verify()?;
        ensure!(
            self.state.matches(&self.engine.state),
            "REMOTE_RECEIVER_NATIVE_STATE_CHANGED"
        );
        self.service.verify(&self.binding.receiver)?;
        let store = TurnAttemptStore::open_existing(
            &self
                .engine
                .session_storage_dir_for(&self.accepted.identity.thread_id),
            &self.accepted.identity.thread_id,
        )?
        .context("REMOTE_RECEIVER_NATIVE_TASK_REQUIRED")?;
        ensure!(
            store.load(&self.accepted.identity)?.as_ref() == Some(&self.accepted),
            "REMOTE_RECEIVER_NATIVE_TASK_CHANGED"
        );
        Ok(())
    }
}

impl Lease {
    fn charge(&self) -> BudgetCharge {
        BudgetCharge {
            tokens: self
                .usage
                .as_ref()
                .map(|usage| {
                    u64::from(usage.total_tokens.unwrap_or_else(|| {
                        usage
                            .input_tokens
                            .saturating_add(usage.output_tokens)
                            .saturating_add(usage.cache_creation_input_tokens.unwrap_or(0))
                            .saturating_add(usage.cache_read_input_tokens.unwrap_or(0))
                    }))
                })
                .unwrap_or(0),
            model_calls: 1,
            run_millis: self
                .started
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
            cost_micros: None,
        }
    }
    fn write(
        &mut self,
        coverage: BudgetUsageCoverage,
        terminal: Option<BudgetTerminalKind>,
    ) -> Result<()> {
        let proof = terminal
            .map(|kind| {
                NativeBudgetTerminal::from_authoritative_receipt(
                    self.receipt.operation_id.clone(),
                    self.receipt.task.root_task.clone(),
                    self.receipt.task.actor_attempt_id.clone(),
                    format!("receiver-call-end-{}", self.call.native_call_id),
                    super::super::launch::digest(&(
                        &self.call,
                        &self.receipt.reservation_id,
                        format!("{kind:?}"),
                    ))?,
                    kind,
                )
            })
            .transpose()?;
        self.receipt = self.meter.service.accounting_store().record_usage(
            &self.receipt.reservation_id,
            self.receipt.revision,
            &format!("usage-{}", self.updates),
            &NativeBudgetUsage {
                coverage,
                known: self.charge(),
            },
            proof.as_ref(),
            super::super::launch::now()?,
        )?;
        self.updates += 1;
        Ok(())
    }
}

impl NativeModelRequestLease for Lease {
    fn check_current(&self) -> std::result::Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            self.meter.verify()?;
            super::super::receiver::current_policy_set(&self.meter.service.accounting_store(),&self.meter.principal,&self.meter.binding.original.operation_id,&self.receipt)?;
            let mut observed = self.last_source_check.lock().map_err(|_| anyhow::anyhow!("REMOTE_RECEIVER_CONTROL_UNAVAILABLE"))?;
            if observed.elapsed() >= Duration::from_millis(250) {
                let reply=self.meter.binding.source_control(format!("observe-{}-{}",self.call.native_call_id,uuid::Uuid::new_v4().simple()),NativeRemoteControlDataV1::ObserveModel(self.call.clone()))?;
                ensure!(matches!(reply.data,NativeRemoteReceiptDataV1::ModelCall{call:ref actual,dispatched:true,finished:false,..} if actual==&self.call),"REMOTE_RECEIVER_SOURCE_CALL_CHANGED");
                *observed = Instant::now();
            }
            Ok(())
        })().map_err(|_|NativeModelRequestError::Unavailable)
    }
    fn deadline(&self) -> Option<Instant> {
        Some(self.meter.binding.deadline)
    }
    fn record_usage(&mut self, usage: &Usage) -> std::result::Result<(), NativeModelRequestError> {
        if let Some(current) = &mut self.usage {
            current.merge_stream_update(usage)
        } else {
            self.usage = Some(usage.clone())
        }
        self.write(BudgetUsageCoverage::Partial, None)
            .map_err(|_| NativeModelRequestError::Unavailable)
    }
    fn finish(
        mut self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> std::result::Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            if let Some(usage) = settlement.usage {
                if let Some(current) = &mut self.usage {
                    current.merge_stream_update(&usage)
                } else {
                    self.usage = Some(usage)
                }
            }
            let stopped = settlement.request_dispatched
                && settlement.end == NativeModelRequestEnd::MessageStop;
            let complete = stopped
                && settlement.usage_from_delta
                && self
                    .usage
                    .as_ref()
                    .is_some_and(|usage| usage.total_tokens.is_some() || usage.input_tokens > 0);
            self.write(
                if complete {
                    BudgetUsageCoverage::Complete
                } else if self.usage.is_some() {
                    BudgetUsageCoverage::Partial
                } else {
                    BudgetUsageCoverage::Unreported
                },
                stopped.then_some(BudgetTerminalKind::Completed),
            )?;
            let actual = complete.then(|| {
                let charge = self.charge();
                NativeRemoteChargeDataV1 {
                    tokens: charge.tokens,
                    model_calls: 1,
                    run_millis: charge.run_millis,
                    cost_micros: None,
                }
            });
            self.meter.binding.source_control(
                format!("finish-{}", self.call.native_call_id),
                NativeRemoteControlDataV1::FinishModel(NativeRemoteFinishModelV1 {
                    call: self.call.clone(),
                    outcome: if stopped {
                        NativeRemoteCallOutcomeV1::Completed
                    } else {
                        NativeRemoteCallOutcomeV1::OutcomeUnknown
                    },
                    actual_usage: actual,
                }),
            )?;
            Ok(())
        })()
        .map_err(|_| NativeModelRequestError::Unavailable)
    }
}

struct Adapter(Arc<Meter>);
struct Lease {
    meter: Arc<Meter>,
    call: NativeRemoteCallRefV1,
    receipt: BudgetReservationReceipt,
    usage: Option<Usage>,
    started: Instant,
    updates: u64,
    last_source_check: Mutex<Instant>,
}

impl NativeModelRequestObserver for Adapter {
    fn reserve(
        &self,
        context: &NativeModelRequestContext,
        request: &MessagesRequest,
    ) -> std::result::Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        self.0.reserve(context, request).map_err(|error| {
            let code = super::admission_code(&error);
            tracing::warn!(code=%code,"Native ACP Receiver model admission unavailable");
            NativeModelRequestError::Unavailable
        })
    }
}

impl Meter {
    fn reserve(
        self: &Arc<Self>,
        context: &NativeModelRequestContext,
        request: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>> {
        self.verify()?;
        let content = request
            .messages
            .iter()
            .rev()
            .find_map(|message| match message {
                kcoder_types::Message::User {
                    content,
                    origin: kcoder_types::MessageOrigin::User,
                } => Some(content),
                _ => None,
            })
            .context("REMOTE_RECEIVER_NATIVE_INPUT_REQUIRED")?;
        let mut text = String::new();
        for part in content {
            match part {
                kcoder_types::ContentBlock::Text { text: part } => text.push_str(part),
                _ => anyhow::bail!("REMOTE_RECEIVER_NATIVE_INPUT_KIND_UNAVAILABLE"),
            }
        }
        ensure!(
            format!("{:x}", Sha256::digest(text.as_bytes()))
                == self.binding.input()?.frozen_input_sha256,
            "REMOTE_RECEIVER_NATIVE_INPUT_CHANGED"
        );
        ensure!(
            context.purpose() == NativeModelRequestPurpose::Main
                && context.execution().matches_state(&self.engine.state)
                && self.state.matches(context.state())
                && context.execution().attempt() == Some(&self.accepted.identity)
                && context.execution().parent().is_none(),
            "REMOTE_RECEIVER_NATIVE_CALL_CHANGED"
        );
        ensure!(
            context.configuration() == Some(&self.model),
            "REMOTE_RECEIVER_NATIVE_MODEL_CHANGED"
        );
        let policy = self.binding.policy()?;
        ensure!(
            request
                .tools
                .iter()
                .all(|tool| policy.office.enabled
                    && policy.office.allowed_tools.contains(&tool.name)),
            "REMOTE_RECEIVER_NATIVE_TOOL_CEILING_CHANGED"
        );
        let mut provider = self
            .provider
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_RECEIVER_NATIVE_PROVIDER_CHANGED"))?;
        if let Some(actual) = provider.as_ref() {
            ensure!(
                Arc::ptr_eq(actual, context.provider()),
                "REMOTE_RECEIVER_NATIVE_PROVIDER_CHANGED"
            );
        } else {
            *provider = Some(context.provider().clone());
        }
        drop(provider);
        let tokens = super::super::receiver::bound(&self.model, request)?;
        ensure!(
            tokens <= policy.maximum_total_tokens,
            "REMOTE_RECEIVER_NATIVE_TOKEN_BOUND"
        );
        let estimate = NativeRemoteChargeDataV1 {
            tokens,
            model_calls: 1,
            run_millis: u64::try_from(
                self.binding
                    .deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis(),
            )?,
            cost_micros: None,
        };
        let call = NativeRemoteCallRefV1 {
            receiver_accepted: self.facts.clone(),
            native_call_id: context.call_id().into(),
        };
        let reserve = NativeRemoteReserveModelV1 {
            receiver_accepted: self.facts.clone(),
            native_call_id: call.native_call_id.clone(),
            provider_id: self
                .model
                .provider_id
                .clone()
                .context("REMOTE_RECEIVER_NATIVE_MODEL_REQUIRED")?,
            model_id: self.model.model_id.clone(),
            model_configuration_revision: self.model.revision.clone(),
            conservative_bound: estimate.clone(),
        };
        self.binding.source_control(
            format!("reserve-{}", context.call_id()),
            NativeRemoteControlDataV1::ReserveModel(reserve),
        )?;
        let ledger = self.service.accounting_store();
        let now = super::super::launch::now()?;
        let operation = &self.binding.original.operation_id;
        let policies = ledger.current_applicable_policies(&self.principal, operation, now)?;
        let slot = ledger
            .read_reservation(&self.slot)?
            .context("REMOTE_RECEIVER_NATIVE_SLOT_REQUIRED")?;
        ledger.mark_dispatched(&self.slot, slot.revision, &policies, now)?;
        let reservation = ledger.reserve(
            &NativeBudgetRequest {
                reservation_id: format!("receiver-{}", context.call_id()),
                operation_id: context.call_id().into(),
                principal: self.principal.clone(),
                unit: BudgetUnit::ModelCall,
                task: BudgetTaskLink {
                    root_operation_id: operation.clone(),
                    root_task: slot.task.root_task,
                    actor: BudgetActor::Main,
                    actor_attempt_id: context.call_id().into(),
                    parent_reservation_id: Some(self.slot.clone()),
                },
                estimate: BudgetCharge {
                    tokens: estimate.tokens,
                    model_calls: 1,
                    run_millis: estimate.run_millis,
                    cost_micros: None,
                },
            },
            &policies,
            now,
        )?;
        let BudgetReservationResult::Created(receipt) = reservation else {
            anyhow::bail!("REMOTE_RECEIVER_ORIGINAL_MODEL_CALL_ALREADY_OBSERVED")
        };
        let receipt = match ledger.mark_dispatched(
            &receipt.reservation_id,
            receipt.revision,
            &policies,
            now,
        )? {
            BudgetDispatchResult::Fresh(value) => value,
            _ => anyhow::bail!("REMOTE_RECEIVER_ORIGINAL_MODEL_CALL_ALREADY_OBSERVED"),
        };
        self.binding.source_control(
            format!("dispatch-{}", context.call_id()),
            NativeRemoteControlDataV1::DispatchModel(call.clone()),
        )?;
        Ok(Box::new(Lease {
            meter: self.clone(),
            call,
            receipt,
            usage: None,
            started: Instant::now(),
            updates: 0,
            last_source_check: Mutex::new(Instant::now()),
        }))
    }
}
