//! Only the owning pending private thread ticket can supply pre-start policy.
use super::*;
use kcoder_engine::QueryEngine;
use std::sync::Weak;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Initialization {
    Start,
    Restore,
}

pub(crate) struct NativeRuntimeThreadInitializer {
    storage: Arc<RuntimeStorage>,
    context: NativeIntegrationContext,
    ticket: NativeRuntimeTicket,
    intent: String,
    request_sha: String,
    initialization: Initialization,
    authority: Arc<dyn NativeRuntimeAuthority>,
    owner: Weak<()>,
}
impl std::fmt::Debug for NativeRuntimeThreadInitializer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeRuntimeThreadInitializer { original_private_ticket: bound }")
    }
}
impl NativeRuntimeDriver {
    pub(crate) fn restore_thread_params(
        &self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
    ) -> Result<serde_json::Value> {
        self.check(context)?;
        ensure!(
            self.is_pending(ticket) && ticket.phase() == RuntimePhase::ConfigureDispatched,
            "RUNTIME_PRIVATE_THREAD_TICKET_REQUIRED"
        );
        let binding = self
            .storage()
            .bindings()
            .get(ticket.operation_id())?
            .context("RUNTIME_BINDING_MISSING")?;
        context.validate_scope(&binding.source_scope)?;
        ensure!(
            binding.phase == RuntimePhase::ConfigureDispatched
                && binding.acceptance.is_none()
                && binding.thread_id.is_some()
                && binding.thread_id == binding.spec.existing_thread_id,
            "RUNTIME_PRIVATE_RESTORE_INTENT_REQUIRED"
        );
        Ok(serde_json::json!({"threadId": super::submission::required_thread(&binding)?}))
    }

    pub(crate) fn thread_initializer(
        &self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
        params: &serde_json::Value,
        authority: Arc<dyn NativeRuntimeAuthority>,
        owner: Weak<()>,
    ) -> Result<Option<Arc<NativeRuntimeThreadInitializer>>> {
        self.check(context)?;
        if authority.pre_start().is_none() {
            return Ok(None);
        }
        let initialization = match ticket.phase() {
            RuntimePhase::ThreadDispatched => Initialization::Start,
            RuntimePhase::ConfigureDispatched => Initialization::Restore,
            _ => anyhow::bail!("RUNTIME_PRIVATE_THREAD_TICKET_REQUIRED"),
        };
        ensure!(
            self.is_pending(ticket),
            "RUNTIME_PRIVATE_THREAD_TICKET_REQUIRED"
        );
        let binding = self
            .storage()
            .bindings()
            .get(ticket.operation_id())?
            .context("RUNTIME_BINDING_MISSING")?;
        let value = Arc::new(NativeRuntimeThreadInitializer {
            storage: self.storage().clone(),
            context: context.recapture_for_owned_service()?,
            ticket: ticket.clone(),
            intent: binding.intent_sha256,
            request_sha: hash(&serde_json::to_vec(params)?),
            initialization,
            authority,
            owner,
        });
        value.binding()?;
        Ok(Some(value))
    }
}
impl NativeRuntimeThreadInitializer {
    pub(crate) fn verify_request(
        &self,
        id: &serde_json::Value,
        params: &serde_json::Value,
    ) -> Result<()> {
        self.binding()?;
        ensure!(
            id.as_str() == Some(self.ticket.id())
                && hash(&serde_json::to_vec(params)?) == self.request_sha,
            "RUNTIME_PRIVATE_THREAD_REQUEST_CHANGED"
        );
        Ok(())
    }
    pub(crate) fn verify_restore_request(
        &self,
        id: &serde_json::Value,
        params: &serde_json::Value,
    ) -> Result<()> {
        self.verify_request(id, params)?;
        ensure!(
            self.initialization == Initialization::Restore,
            "RUNTIME_PRIVATE_RESTORE_INTENT_REQUIRED"
        );
        Ok(())
    }
    fn binding(&self) -> Result<RuntimeBinding> {
        ensure!(
            self.owner.upgrade().is_some(),
            "RUNTIME_PRIVATE_THREAD_OWNER_CLOSED"
        );
        self.context.verify()?;
        self.storage.verify()?;
        let binding = self
            .storage
            .bindings()
            .get(self.ticket.operation_id())?
            .context("RUNTIME_BINDING_MISSING")?;
        self.context.validate_scope(&binding.source_scope)?;
        let shape_matches = match self.initialization {
            Initialization::Start => {
                self.ticket.phase() == RuntimePhase::ThreadDispatched && binding.thread_id.is_none()
            }
            Initialization::Restore => {
                self.ticket.phase() == RuntimePhase::ConfigureDispatched
                    && binding.thread_id.is_some()
                    && binding.thread_id == binding.spec.existing_thread_id
            }
        };
        ensure!(
            shape_matches
                && binding.phase == self.ticket.phase()
                && binding.intent_sha256 == self.intent
                && binding.acceptance.is_none(),
            "RUNTIME_PRIVATE_THREAD_INTENT_CHANGED"
        );
        self.authority
            .verify_admission(&self.context, &binding.original_request, &binding.spec)?;
        Ok(binding)
    }
    pub(crate) fn factory(
        &self,
    ) -> Result<crate::app_server::engine_factory::AppServerEngineFactory> {
        self.binding()?;
        Ok(self
            .authority
            .pre_start()
            .context("RUNTIME_PRE_START_POLICY_UNAVAILABLE")?
            .factory
            .clone())
    }
    pub(crate) fn install_created(&self, engine: QueryEngine) -> Result<QueryEngine> {
        let binding = self.binding()?;
        ensure!(
            self.initialization == Initialization::Start,
            "RUNTIME_PRIVATE_THREAD_START_REQUIRED"
        );
        let identity = engine.state.inspection_lifecycle_identity();
        let session = engine.session_id();
        let cwd = engine.state.cwd();
        let installed = self
            .authority
            .pre_start()
            .context("RUNTIME_PRE_START_POLICY_UNAVAILABLE")?
            .installer
            .install(
                &self.context,
                &binding.original_request,
                &binding.spec,
                engine,
            )?;
        ensure!(
            identity.matches(&installed.state)
                && installed.session_id() == session
                && installed.state.cwd() == cwd,
            "RUNTIME_PRE_START_OWNER_CHANGED"
        );
        self.binding()?;
        installed.with_required_native_host_source_admission()
    }

    pub(crate) fn prepare_restored_history(
        &self,
        prepared: &kcoder_state::PreparedSessionResume,
        session_directory: &std::path::Path,
    ) -> Result<kcoder_state::PreparedCompletedAttemptHistory> {
        let binding = self.binding()?;
        ensure!(
            self.initialization == Initialization::Restore,
            "RUNTIME_PRIVATE_RESTORE_INTENT_REQUIRED"
        );
        let history = self
            .authority
            .pre_start()
            .context("RUNTIME_PRE_START_POLICY_UNAVAILABLE")?
            .installer
            .prepare_restored_history(
                &self.context,
                &binding.original_request,
                &binding.spec,
                prepared,
                session_directory,
            )?;
        ensure!(
            history.identity().thread_id == super::submission::required_thread(&binding)?,
            "RUNTIME_NATIVE_IDENTITY_MISMATCH"
        );
        self.binding()?;
        Ok(history)
    }

    pub(crate) fn install_restored(
        &self,
        engine: QueryEngine,
        history: &kcoder_state::PreparedCompletedAttemptHistory,
    ) -> Result<QueryEngine> {
        let binding = self.binding()?;
        ensure!(
            self.initialization == Initialization::Restore
                && engine.session_id() == super::submission::required_thread(&binding)?,
            "RUNTIME_PRIVATE_RESTORE_INTENT_REQUIRED"
        );
        history.verify_restored(&engine.state)?;
        let identity = engine.state.inspection_lifecycle_identity();
        let session = engine.session_id();
        let cwd = engine.state.cwd();
        let installed = self
            .authority
            .pre_start()
            .context("RUNTIME_PRE_START_POLICY_UNAVAILABLE")?
            .installer
            .install_restored(
                &self.context,
                &binding.original_request,
                &binding.spec,
                engine,
                history,
            )?;
        ensure!(
            identity.matches(&installed.state)
                && installed.session_id() == session
                && installed.state.cwd() == cwd,
            "RUNTIME_PRE_START_OWNER_CHANGED"
        );
        history.verify_restored(&installed.state)?;
        self.binding()?;
        installed.with_required_native_host_source_admission()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::integrations::core::runtime_driver::test_support::Fixture;
    use serde_json::json;

    fn queued_restore(fixture: &Fixture) -> (NativeRuntimeDriver, NativeRuntimeTicket) {
        let mut driver = fixture.driver();
        let mut task = fixture.spec();
        task.existing_thread_id = Some("original-completed-thread".into());
        driver
            .accept_task(
                &fixture.context,
                &fixture.request("new-original-input"),
                task,
            )
            .unwrap();
        let command = driver.next_command(&fixture.context).unwrap().unwrap();
        assert!(matches!(command, NativeRuntimeCommand::Configure { .. }));
        (driver, command.ticket().clone())
    }

    #[test]
    fn private_cold_resume_requires_original_pending_ticket_and_never_replays_unknown() {
        let fixture = Fixture::new();
        let (mut driver, ticket) = queued_restore(&fixture);
        assert_eq!(
            driver
                .restore_thread_params(&fixture.context, &ticket)
                .unwrap(),
            json!({"threadId":"original-completed-thread"})
        );
        let mut foreign_ticket = ticket.clone();
        foreign_ticket.test_append_id("-public-id");
        assert!(
            driver
                .restore_thread_params(&fixture.context, &foreign_ticket)
                .is_err()
        );
        let foreign = Fixture::new();
        assert!(
            driver
                .restore_thread_params(&foreign.context, &ticket)
                .is_err()
        );
        driver.abandon_command(&fixture.context, &ticket).unwrap();
        assert!(
            driver
                .restore_thread_params(&fixture.context, &ticket)
                .is_err()
        );
        assert!(driver.next_command(&fixture.context).unwrap().is_none());
        assert_eq!(
            driver
                .read_operation(&fixture.context, ticket.operation_id())
                .unwrap()
                .unwrap()
                .phase,
            IntegrationOperationPhase::Unknown
        );
        driver
            .reconcile_operation(&fixture.context, ticket.operation_id())
            .unwrap();
        let reconciled = driver.next_command(&fixture.context).unwrap().unwrap();
        assert!(matches!(
            reconciled,
            NativeRuntimeCommand::Rpc {
                method: "turn/receipt/read",
                ..
            }
        ));
    }

    #[test]
    fn private_cold_resume_response_only_requeues_exact_thread_without_acceptance() {
        for (response, succeeds) in [
            (
                json!({"result":{"thread":{"id":"original-completed-thread","status":"idle","createdAt":"fixture","updatedAt":"fixture"}}}),
                true,
            ),
            (
                json!({"result":{"thread":{"id":"foreign-thread","status":"idle","createdAt":"fixture","updatedAt":"fixture"}}}),
                false,
            ),
            (json!({"result":{"thread":{}}}), false),
            (
                json!({"error":{"code":-32022,"message":"original restore unconfirmed"}}),
                false,
            ),
        ] {
            let fixture = Fixture::new();
            let (mut driver, ticket) = queued_restore(&fixture);
            driver
                .observe_response(&fixture.context, &ticket, &response)
                .unwrap();
            assert!(
                driver
                    .read_operation(&fixture.context, ticket.operation_id())
                    .unwrap()
                    .unwrap()
                    .runtime_acceptance
                    .is_none()
            );
            let next = driver.next_command(&fixture.context).unwrap();
            if succeeds {
                assert!(matches!(next, Some(NativeRuntimeCommand::Configure { .. })));
            } else {
                assert!(next.is_none());
                assert_eq!(
                    driver
                        .read_operation(&fixture.context, ticket.operation_id())
                        .unwrap()
                        .unwrap()
                        .phase,
                    IntegrationOperationPhase::Unknown
                );
            }
            assert!(
                driver
                    .observe_response(&fixture.context, &ticket, &response)
                    .is_err()
            );
        }
    }
}
