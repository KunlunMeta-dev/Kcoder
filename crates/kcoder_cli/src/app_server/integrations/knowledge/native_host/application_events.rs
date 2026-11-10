//! Fixed application/mail resource revisions use the original subscription ledger and scheduler.
use super::super::native_application_selection::NativeApplicationReadAuthority;
use super::*;
use crate::app_server::integrations::connectivity::NativeApplicationResourceConnection;
use anyhow::Context;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Default)]
pub(crate) struct NativeApplicationEventSources {
    selections: Mutex<BTreeMap<String, Arc<NativeApplicationReadAuthority>>>,
    gates: Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>,
    snapshots: Mutex<BTreeMap<String, Arc<ApplicationResourceObservation>>>,
    last_source: Mutex<Option<String>>,
}
pub(super) struct ApplicationResourceObservation {
    pub(super) snapshot: kcoder_mcp::client::NativeResourceSnapshot,
    pub(super) facts: Value,
    pub(super) event_id: String,
}
impl NativeApplicationEventSources {
    fn bounded_sources(&self, mut sources: Vec<String>) -> Result<Vec<String>> {
        sources.retain(|source| source.starts_with("application-events-"));
        sources.sort();
        if let Some(last) = self
            .last_source
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_APPLICATION_SOURCE_BUSY"))?
            .as_ref()
        {
            let first = sources.partition_point(|source| source <= last);
            if first < sources.len() {
                sources.rotate_left(first);
            }
        }
        sources.truncate(3);
        Ok(sources)
    }
    pub(crate) fn install(
        &self,
        scope: &IntegrationScope,
        selected: Arc<NativeApplicationReadAuthority>,
    ) -> Result<()> {
        ensure!(
            scope.organization_id.is_none(),
            "AUTOMATION_APPLICATION_ORGANIZATION_POLICY_REQUIRED"
        );
        let mut selections = self
            .selections
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_APPLICATION_SOURCE_BUSY"))?;
        ensure!(
            selections.contains_key(selected.source_ref()) || selections.len() < 16,
            "AUTOMATION_APPLICATION_SOURCE_LIMIT"
        );
        let reference = selected.source_ref().to_owned();
        selections.insert(reference.clone(), selected);
        self.gates
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_APPLICATION_SOURCE_BUSY"))?
            .entry(reference)
            .or_default();
        Ok(())
    }
    pub(super) fn resolve(
        &self,
        native: &NativeIntegrationContext,
        reference: &str,
    ) -> Result<Arc<NativeApplicationReadAuthority>> {
        let selected = self
            .selections
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_APPLICATION_SOURCE_BUSY"))?
            .get(reference)
            .cloned()
            .context("AUTOMATION_APPLICATION_READ_CONSENT_UNAVAILABLE")?;
        selected.verify_current(native)?;
        Ok(selected)
    }
    fn gate(&self, source: &str) -> Result<Arc<tokio::sync::Mutex<()>>> {
        self.gates
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_APPLICATION_SOURCE_BUSY"))?
            .get(source)
            .cloned()
            .context("AUTOMATION_APPLICATION_READ_CONSENT_UNAVAILABLE")
    }
    pub(super) fn material(
        &self,
        native: &NativeIntegrationContext,
        source: &str,
        facts: &Value,
    ) -> Result<Value> {
        self.resolve(native, source)?;
        let observation = self
            .snapshots
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_APPLICATION_SOURCE_BUSY"))?
            .get(source)
            .cloned()
            .context("AUTOMATION_APPLICATION_ORIGINAL_RESOURCE_UNAVAILABLE")?;
        ensure!(
            observation.facts == *facts,
            "AUTOMATION_APPLICATION_ORIGINAL_RESOURCE_CHANGED"
        );
        Ok(
            json!({"kind":"application_resource","sourceRef":source,"resourceRef":facts["resourceRef"],"revision":observation.snapshot.revision,
            "mimeType":observation.snapshot.mime_type,"text":observation.snapshot.text}),
        )
    }
}

/// Only this native host can combine actual explicit URI consent with its current original subscription.
/// No Deserialize, boolean grant, callback constructor or public independent initializer exists.
pub(crate) struct NativeApplicationResourceReadUse {
    authority: Arc<NativeApplicationReadAuthority>,
    automation: Arc<NativeAutomation>,
    subscription: AutomationSubscription,
    cancel: CancellationToken,
}
impl NativeApplicationResourceReadUse {
    pub(crate) fn resource_uri(&self) -> &str {
        self.authority.resource_uri()
    }
    pub(crate) fn verify_current(
        &self,
        native: &NativeIntegrationContext,
        connection: &NativeApplicationResourceConnection,
    ) -> Result<()> {
        ensure!(
            !self.cancel.is_cancelled()
                && std::ptr::eq(self.authority.connection.as_ref(), connection),
            "AUTOMATION_APPLICATION_READ_AUTHORITY_CHANGED"
        );
        self.authority.verify_current(native)?;
        self.automation.verify(native)?;
        let current = self
            .automation
            .store
            .read_subscription(&self.subscription.draft.id)?;
        ensure!(
            current.enabled
                && current.owner == KnowledgeOwner::from(native.scope())
                && current.revision == self.subscription.revision
                && current.consent_ref == self.subscription.consent_ref
                && !current.consent_ref.is_empty()
                && current.draft.event_source.as_deref() == Some(self.authority.source_ref()),
            "AUTOMATION_APPLICATION_SUBSCRIPTION_READ_REVOKED"
        );
        Ok(())
    }
}
impl NativeKnowledgeHost {
    pub(super) async fn application_event_tick(
        &self,
        request: &IntegrationRequest,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<IntegrationReply>> {
        ensure!(
            self.settings.business_automation_enabled && self.runtime_sources_current(),
            "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE"
        );
        self.validate_native_request(request, false)?;
        let Some(automation) = self.observe_automation()? else {
            return Ok(vec![]);
        };
        let mut replies = Vec::new();
        for source in self
            .application_events
            .bounded_sources(automation.store.enabled_event_source_refs()?)?
        {
            if cancel.is_cancelled() || replies.len() >= 10 {
                break;
            }
            *self
                .application_events
                .last_source
                .lock()
                .map_err(|_| anyhow::anyhow!("AUTOMATION_APPLICATION_SOURCE_BUSY"))? =
                Some(source.clone());
            match self
                .application_source_tick(&source, request, now_ms, cancel)
                .await
            {
                Ok(mut observed) => {
                    observed.truncate(10 - replies.len());
                    replies.extend(observed);
                }
                Err(error) => {
                    #[cfg(test)]
                    eprintln!(
                        "owned application source denied: {}",
                        match error.to_string().as_str() {
                            "AUTOMATION_APPLICATION_READ_CONSENT_UNAVAILABLE" =>
                                "consent_unavailable",
                            "AUTOMATION_APPLICATION_READ_CONSENT_CHANGED" => "consent_changed",
                            "AUTOMATION_APPLICATION_READ_OWNER_CHANGED" => "public_owner_changed",
                            "AUTOMATION_APPLICATION_SOURCE_CHANGED" => "source_changed",
                            "AUTOMATION_APPLICATION_SOURCE_REVOKED" => "source_revoked",
                            "AUTOMATION_APPLICATION_SOURCE_DISABLED" => "source_disabled",
                            "AUTOMATION_APPLICATION_SUBSCRIPTION_READ_REVOKED" =>
                                "subscription_revoked",
                            "AUTOMATION_APPLICATION_SOURCE_CATALOG_UNAVAILABLE" =>
                                "catalog_unavailable",
                            "NATIVE_SOURCE_CHOICE_STALE" => "current_source_choice_stale",
                            "MCP_NATIVE_CONNECTION_ORIGIN_REQUIRED" => "native_origin_missing",
                            "MCP_NATIVE_RESOURCE_SOURCE_CHANGED" => "native_resource_changed",
                            _ => "other_native_source_failure",
                        }
                    );
                    let _ = error;
                    replies.push(self.reply_failure(
                        request,
                        now_ms,
                        IntegrationStatus::Unavailable,
                        "AUTOMATION_APPLICATION_SOURCE_UNAVAILABLE",
                        IntegrationRecovery::RequestAuthorization,
                    ));
                }
            }
        }
        Ok(replies)
    }
    async fn application_source_tick(
        &self,
        source: &str,
        request: &IntegrationRequest,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<IntegrationReply>> {
        let Some(automation) = self.observe_automation()? else {
            return Ok(vec![]);
        };
        let automation = Arc::new(automation);
        let provider = self
            .dependencies
            .as_deref()
            .context("AUTOMATION_RUNTIME_UNAVAILABLE")?;
        let base = self.policy_for(Some(&automation));
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action: false,
            policy: &base,
        };
        let workflows = self.workflows()?;
        let mut replies = Vec::new();
        let gate = self.application_events.gate(source)?;
        let _guard = gate.lock().await;
        let authority = self.application_events.resolve(&self.native, source)?;
        let subscriptions = automation.store.event_subscriptions(source)?;
        let Some(first) = subscriptions.first() else {
            return Ok(vec![]);
        };
        let read = NativeApplicationResourceReadUse {
            authority: authority.clone(),
            automation: automation.clone(),
            subscription: first.clone(),
            cancel: cancel.clone(),
        };
        #[cfg(test)]
        eprintln!("owned application source stage: original fixed resource read begin");
        let snapshot = authority
            .connection
            .read(&self.native, &read, cancel)
            .await?;
        #[cfg(test)]
        eprintln!("owned application source stage: original fixed resource read verified");
        let event_id = format!(
            "application-revision-{:x}",
            Sha256::digest(serde_json::to_vec(&(&source, &snapshot.revision))?)
        );
        let facts = json!({"kind":"application_resource_revision","sourceRef":source,"resourceRef":authority.resource_ref(),"resourceRevision":snapshot.revision,
            "sourceRevision":authority.connection.choice().source_ref,"selectionRevision":authority.revision(),"bytes":snapshot.text.len()});
        let observation = Arc::new(ApplicationResourceObservation {
            snapshot,
            facts,
            event_id,
        });
        self.application_events
            .snapshots
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_APPLICATION_SOURCE_BUSY"))?
            .insert(source.to_owned(), observation.clone());
        for subscription in subscriptions {
            if cancel.is_cancelled() || replies.len() >= 10 {
                break;
            }
            let read = NativeApplicationResourceReadUse {
                authority: authority.clone(),
                automation: automation.clone(),
                subscription: subscription.clone(),
                cancel: cancel.clone(),
            };
            read.verify_current(&self.native, authority.connection.as_ref())?;
            let recorded = automation.store.recorded_event_position(
                &subscription.draft.id,
                subscription.revision,
                source,
                &observation.event_id,
            )?;
            if recorded.is_some_and(|(_, _, committed)| committed) {
                continue;
            }
            let (sequence, occurred) = match recorded {
                Some((sequence, occurred, _)) => (sequence, occurred),
                None => match automation.store.next_event_sequence(
                    &subscription.draft.id,
                    subscription.revision,
                    source,
                    &observation.event_id,
                )? {
                    Some(sequence) => (sequence, now_ms),
                    None => continue,
                },
            };
            let proof = super::super::ApprovedSubscriptionTrigger::from_native_event(
                self.scope(),
                &subscription,
                source,
                &observation.event_id,
                sequence,
                occurred,
                None,
                0,
            )?;
            let operation = format!(
                "application-trigger-{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    &subscription.owner,
                    &subscription.draft.id,
                    subscription.revision,
                    &observation.event_id
                ))?)
            );
            let child = IntegrationRequest {
                contract_version: request.contract_version,
                request_id: uuid::Uuid::new_v4().to_string(),
                scope: request.scope.clone(),
                operation_id: Some(operation),
                expected_revision: None,
                timeout_ms: request.timeout_ms,
                cancellation_ref: None,
                payload: serde_json::to_value(proof.params(observation.facts.clone()))?
                    .as_object()
                    .unwrap()
                    .clone(),
            };
            replies.push(
                super::super::trigger_approved_subscription(
                    &child,
                    &context,
                    &automation.store,
                    &workflows,
                    provider,
                    &proof,
                    cancel,
                )
                .await,
            );
            #[cfg(test)]
            eprintln!(
                "owned application source stage: original trigger returned {:?}",
                replies.last().map(|reply| reply.status)
            );
            read.verify_current(&self.native, authority.connection.as_ref())?;
        }

        Ok(replies)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_resource_sources_rotate_past_the_first_three() -> Result<()> {
        let sources = NativeApplicationEventSources::default();
        let enabled = ["a", "b", "c", "d", "e"]
            .map(|id| format!("application-events-{id}"))
            .to_vec();
        assert_eq!(sources.bounded_sources(enabled.clone())?, &enabled[..3]);
        *sources.last_source.lock().unwrap() = Some(enabled[2].clone());
        assert_eq!(
            sources.bounded_sources(enabled.clone())?,
            [enabled[3].clone(), enabled[4].clone(), enabled[0].clone()]
        );
        Ok(())
    }
}
