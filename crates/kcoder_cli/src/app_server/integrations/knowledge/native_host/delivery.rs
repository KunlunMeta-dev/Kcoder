//! Native delivery proofs retain original D consent and complete effect identity.
use super::*;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

/// Opaque native service evidence. Public payloads cannot deserialize or construct this owner.
pub struct NativeAutomationDeliveryUse {
    native: NativeIntegrationContext,
    automation: NativeAutomation,
    current: Arc<AtomicBool>,
    cancel: CancellationToken,
    expires: Instant,
    method: &'static str,
    request: IntegrationRequest,
    run_id: String,
    intent: String,
    destination: IntegrationRevisionRef,
}
impl NativeAutomationDeliveryUse {
    pub(crate) fn request(&self) -> &IntegrationRequest {
        &self.request
    }
    pub(crate) fn method(&self) -> &'static str {
        self.method
    }
    pub(crate) fn destination_ref(&self) -> &IntegrationRevisionRef {
        &self.destination
    }
    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.cancel.child_token()
    }
    /// Re-read the original complete intent even when this proof only authorizes receipt observation.
    pub(crate) fn original_payload(&self) -> Result<Value> {
        self.verify_current(&self.native)?;
        let run = self.automation.store.read_run(&self.run_id)?;
        let payload = super::super::automation_delivery::original_delivery_payload(
            &self.automation.store,
            &run,
            run.delivery_id
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_DELIVERY_NOT_SUBMITTED"))?,
            &self.destination.id,
            &self.destination.revision,
        )?;
        self.verify_current(&self.native)?;
        Ok(payload)
    }
    pub(crate) fn verify_current(&self, native: &NativeIntegrationContext) -> Result<()> {
        ensure!(
            self.current.load(Ordering::Acquire)
                && !self.cancel.is_cancelled()
                && Instant::now() < self.expires,
            "AUTOMATION_DELIVERY_OWNER_ENDED"
        );
        native.validate_scope(self.native.scope())?;
        self.native.verify()?;
        self.automation.verify(&self.native)?;
        self.request
            .validate_method(IntegrationPort::Delivery, self.method)?;
        let run = self.automation.store.read_run(&self.run_id)?;
        ensure!(
            run.status == AutomationRunStatus::Completed
                && run.owner == KnowledgeOwner::from(native.scope()),
            "AUTOMATION_RESULT_NOT_READY"
        );
        let subscription = self
            .automation
            .store
            .read_subscription_version(&run.subscription_id, run.subscription_revision)?;
        ensure!(
            !subscription.consent_ref.is_empty() && subscription.owner == run.owner,
            "AUTOMATION_ORIGINAL_CONSENT_REQUIRED"
        );
        let AutomationDestination::Channel {
            destination_ref,
            destination_revision,
        } = &subscription.draft.delivery
        else {
            anyhow::bail!("AUTOMATION_DELIVERY_DESTINATION_REQUIRED")
        };
        ensure!(
            self.destination.id == *destination_ref
                && self.destination.revision == *destination_revision,
            "AUTOMATION_DELIVERY_DESTINATION_CHANGED"
        );
        let acceptance = self
            .automation
            .store
            .read_native_acceptance(&run.id)?
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_ORIGINAL_ACCEPTANCE_REQUIRED"))?;
        ensure!(
            run.native_thread_id.as_deref() == Some(acceptance.thread_id.as_str()),
            "AUTOMATION_ORIGINAL_ACCEPTANCE_CHANGED"
        );
        let delivery_id = run
            .delivery_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_DELIVERY_NOT_SUBMITTED"))?;
        ensure!(
            self.request
                .payload
                .get("deliveryId")
                .and_then(Value::as_str)
                == Some(delivery_id),
            "AUTOMATION_DELIVERY_CONFLICT"
        );
        if self.method == "submitDelivery" {
            ensure!(
                matches!(
                    run.delivery_status,
                    AutomationDeliveryStatus::Pending | AutomationDeliveryStatus::Unknown
                ),
                "AUTOMATION_DELIVERY_ALREADY_SETTLED"
            );
            let current = self
                .automation
                .store
                .read_subscription(&run.subscription_id)?;
            ensure!(
                current.enabled && current.revision == run.subscription_revision,
                "AUTOMATION_DELIVERY_SUBSCRIPTION_CHANGED"
            );
            let expected = super::super::automation_delivery::original_delivery_payload(
                &self.automation.store,
                &run,
                delivery_id,
                &self.destination.id,
                &self.destination.revision,
            )?;
            ensure!(
                Value::Object(self.request.payload.clone()) == expected
                    && self.request.operation_id.as_deref()
                        == Some(format!("submit-{delivery_id}").as_str()),
                "AUTOMATION_DELIVERY_INTENT_CHANGED"
            );
        } else {
            ensure!(
                Value::Object(self.request.payload.clone()) == json!({"deliveryId":delivery_id}),
                "AUTOMATION_DELIVERY_INTENT_CHANGED"
            );
        }
        let intent = native_intent(&run, &subscription)?;
        ensure!(intent == self.intent, "AUTOMATION_DELIVERY_INTENT_CHANGED");
        Ok(())
    }
}
fn native_intent(run: &AutomationRun, subscription: &AutomationSubscription) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([
            run.id,
            run.owner,
            run.subscription_id,
            run.subscription_revision,
            run.native_operation_id,
            run.native_thread_id,
            run.output,
            run.artifact_refs,
            run.delivery_id,
            subscription.consent_ref,
            subscription.draft
        ]))?)
    ))
}
impl NativeKnowledgeHost {
    pub(super) fn delivery_use(
        &self,
        method: &str,
        request: &IntegrationRequest,
        explicit_user_action: bool,
        cancel: &CancellationToken,
    ) -> Result<Arc<NativeAutomationDeliveryUse>> {
        let method = match method {
            "submitDelivery" => "submitDelivery",
            "readDelivery" => "readDelivery",
            "cancelDelivery" => "cancelDelivery",
            "reconcileDelivery" => "reconcileDelivery",
            _ => anyhow::bail!("AUTOMATION_DELIVERY_METHOD_UNAVAILABLE"),
        };
        ensure!(
            !matches!(method, "cancelDelivery" | "reconcileDelivery") || explicit_user_action,
            "AUTOMATION_EXPLICIT_CONSENT_REQUIRED"
        );
        ensure!(
            self.settings.business_automation_enabled && self.runtime_sources_current(),
            "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE"
        );
        self.validate_native_request(request, method != "readDelivery")?;
        let automation = self
            .observe_automation()?
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NOT_FOUND"))?;
        let delivery_id = request
            .payload
            .get("deliveryId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INVALID_PAYLOAD"))?;
        let run_id = delivery_id
            .strip_prefix("delivery-")
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_ORIGINAL_DELIVERY_REQUIRED"))?;
        let run = automation.store.read_run(run_id)?;
        let subscription = automation
            .store
            .read_subscription_version(&run.subscription_id, run.subscription_revision)?;
        let AutomationDestination::Channel {
            destination_ref,
            destination_revision,
        } = &subscription.draft.delivery
        else {
            anyhow::bail!("AUTOMATION_DELIVERY_DESTINATION_REQUIRED")
        };
        let proof = Arc::new(NativeAutomationDeliveryUse {
            native: self.native.recapture_for_owned_service()?,
            current: self.runtime_source_current.clone(),
            cancel: cancel.clone(),
            expires: Instant::now() + Duration::from_millis(request.timeout_ms),
            method,
            request: request.clone(),
            run_id: run_id.into(),
            intent: native_intent(&run, &subscription)?,
            destination: IntegrationRevisionRef {
                id: destination_ref.clone(),
                revision: destination_revision.clone(),
            },
            automation,
        });
        proof.verify_current(&self.native)?;
        Ok(proof)
    }
}

pub(super) struct NativeDeliveryDependencies<'a> {
    pub(super) host: &'a NativeKnowledgeHost,
    pub(super) provider: &'a dyn KnowledgeDependencyPort,
    pub(super) explicit_user_action: bool,
    pub(super) cancel: &'a CancellationToken,
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl KnowledgeDependencyPort for NativeDeliveryDependencies<'_> {
    fn registered(&self, port: IntegrationPort, method: &str) -> bool {
        self.provider.registered(port, method)
    }
    async fn call(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
    ) -> IntegrationReply {
        if port != IntegrationPort::Delivery {
            return self.provider.call(port, method, request).await;
        }
        match self
            .host
            .delivery_use(method, request, self.explicit_user_action, self.cancel)
        {
            Ok(proof) => self.provider.call_authorized_delivery(proof).await,
            Err(_) => self.host.reply_failure(
                request,
                chrono::Utc::now().timestamp_millis().max(0) as u64,
                IntegrationStatus::Rejected,
                "AUTOMATION_NATIVE_DELIVERY_UNAVAILABLE",
                IntegrationRecovery::ReconcileOriginal,
            ),
        }
    }
}

#[cfg(test)]
pub(super) mod test_support;
