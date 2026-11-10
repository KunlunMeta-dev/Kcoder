//! One fixed set of received offers enters the existing settings group in one job checkpoint.
use super::*;
use crate::source_transfer::private_credentials::{
    PreparationConsent, PreparationIntent, PublicationClaim, existing_preparation_intent,
};
use crate::source_transfer::private_credentials::{
    ReceivedPrivateCredentialLease, private_credential_bundle_digest,
};

#[cfg(test)]
thread_local! {
    pub(crate) static FAIL_BEFORE_FIRST_BUNDLE_CLAIM: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(crate) static FAIL_AFTER_FIRST_BUNDLE_CLAIM: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(super) fn original_bindings(
    job: &MigrationJob,
) -> Result<Vec<&ReceivedPrivateCredentialBinding>> {
    let mut bindings: Vec<&ReceivedPrivateCredentialBinding> = Vec::new();
    for source in job
        .credential_plans
        .iter()
        .map(|plan| &plan.source)
        .chain(job.mcp_credential_plans.iter().map(|plan| &plan.source))
    {
        let received = source
            .received_offer()
            .context("private_credentials_publication_binding_changed")?;
        if let Some(previous) = bindings
            .iter()
            .find(|previous| previous.offer_id() == received.offer_id())
        {
            ensure!(
                *previous == received,
                "private_credentials_publication_binding_changed"
            );
        } else {
            bindings.push(received);
        }
    }
    bindings.sort_by(|a, b| a.offer_id().cmp(b.offer_id()));
    Ok(bindings)
}
pub(super) fn exact_existing(
    job: &MigrationJob,
    offers: &[&ReceivedPrivateCredentialBinding],
) -> Result<bool> {
    if job.credential_plans.is_empty() && job.mcp_credential_plans.is_empty() {
        return Ok(false);
    }
    let saved = original_bindings(job)?;
    ensure!(
        saved == offers,
        "private_credentials_publication_binding_changed"
    );
    for offer in offers {
        let count = job
            .credential_plans
            .iter()
            .filter(|plan| plan.source.received_offer() == Some(*offer))
            .count()
            + job
                .mcp_credential_plans
                .iter()
                .filter(|plan| plan.source.received_offer() == Some(*offer))
                .count();
        ensure!(
            count == offer.selections().len(),
            "private_credentials_publication_binding_changed"
        );
    }
    Ok(true)
}
fn matches_selection(step: &SettingsStep, selection: &PrivateCredentialSelection) -> bool {
    let (kind, name, target) = selection.identity();
    step.item().preview.source_name == name
        && step.target_name() == target
        && matches!(
            (kind, step),
            ("provider", SettingsStep::Provider(_)) | ("mcp", SettingsStep::Mcp(_))
        )
}
fn first_revision(step: &SettingsStep) -> &str {
    match step {
        SettingsStep::Provider(plan) => &plan.expected_revision,
        SettingsStep::Mcp(plan) => &plan.expected_revision,
    }
}
impl MigrationStore {
    #[cfg(test)]
    pub(crate) fn lose_next_received_bundle_intent_reply() {
        FAIL_BEFORE_FIRST_BUNDLE_CLAIM.with(|flag| flag.set(true));
    }
    #[cfg(test)]
    pub(crate) fn lose_next_received_bundle_claim_reply() {
        FAIL_AFTER_FIRST_BUNDLE_CLAIM.with(|flag| flag.set(true));
    }

    pub fn prepare_received_batch_credentials_bundle(
        &self,
        job_id: &str,
        expected_sequence: u64,
        received: &[ReceivedPrivateCredentialBinding],
        consent: PrivateCredentialConsent,
        targets: &BatchTargets<'_>,
    ) -> Result<MigrationJob> {
        job_file(job_id)?;
        ensure!(
            !received.is_empty() && received.len() <= 16,
            "private_credentials_budget_exceeded"
        );
        let mut offers = received.iter().collect::<Vec<_>>();
        offers.sort_by(|a, b| a.offer_id().cmp(b.offer_id()));
        ensure!(
            offers
                .windows(2)
                .all(|pair| pair[0].offer_id() != pair[1].offer_id()),
            "private_credentials_duplicate_selection"
        );
        ensure!(
            offers
                .iter()
                .map(|offer| offer.selections().len())
                .sum::<usize>()
                <= 64,
            "private_credentials_budget_exceeded"
        );
        for offer in &offers {
            consent.require(offer.selections())?;
        }
        let _runner = self
            .directory
            .try_exclusive_lock(OsStr::new(&format!(".{job_id}.runner.lock")))?
            .ok_or_else(|| crate::contention::busy(crate::contention::LeaseKind::BatchRunner))?;
        let keys = targets
            .credentials
            .as_ref()
            .context("migration_credential_target_required")?;
        ensure!(
            keys.target.directory_identity()? == targets.provider.directory_identity()?
                && targets.provider.settings_target_id() == targets.mcp.settings_target_id(),
            "migration_wrong_target"
        );
        let sources = offers
            .iter()
            .map(|offer| {
                ensure!(
                    keys.policy == offer.policy(),
                    "private_credentials_policy_changed"
                );
                let source = offer.configuration_binding()?;
                source.verify_batch_parent(&self.directory)?;
                Ok(source)
            })
            .collect::<Result<Vec<_>>>()?;
        // Keep these guards outside the callback so writerRunning stays true until
        // the atomic job checkpoint itself has completed or failed.
        let mut execution: Vec<ReceivedPrivateCredentialLease> = Vec::new();
        self.update(job_id,expected_sequence,|job| {
            if exact_existing(job,&offers)? {
                if let Some(saved)=existing_preparation_intent(&self.profile,job_id)? {
                    ensure!(saved.expected_sequence==expected_sequence && saved.consent==PreparationConsent::from(consent) && saved.members==offers.iter().map(|member|(*member).clone()).collect::<Vec<_>>(),"private_credentials_publication_binding_changed");
                }
                return Ok(false);
            }
            ensure!(job.sequence==expected_sequence,"migration_revision_conflict");
            ensure!(job.status==JobStatus::Ready,"migration_invalid_transition");
            let batch=job.batch.as_ref().context("migration_batch_plan_required")?;
            let old_plan=batch.plan_id.as_deref().context("migration_batch_plan_required")?;
            let action_index=batch.actions.iter().position(|action| {
                let BatchActionKind::Settings {plan}=&action.action else { return false; };
                offers.iter().enumerate().all(|(index,offer)|offer.selections().iter().all(|selection| {
                    plan.steps.iter().any(|step| matches_selection(step,selection)
                        && matches!(batch.source_for(&step.item().preview.id),Ok(BatchSource::TransferredConfiguration(source)) if **source==sources[index]))
                }))
            }).context("private_credentials_saved_plan_required")?;
            let action=&batch.actions[action_index];
            ensure!(action.status==ItemStatus::Staged,"migration_invalid_transition");
            let BatchActionKind::Settings {plan}=&action.action else { unreachable!() };
            let mut selected_ids=BTreeSet::new();
            let mut mapped=Vec::new();
            for (index,offer) in offers.iter().enumerate() {
                for selection in offer.selections() {
                    let steps=plan.steps.iter().enumerate().filter(|(_,step)|matches_selection(step,selection)
                        && matches!(batch.source_for(&step.item().preview.id),Ok(BatchSource::TransferredConfiguration(source)) if **source==sources[index])).collect::<Vec<_>>();
                    ensure!(steps.len()==1,"private_credentials_source_not_selected");
                    let (step_index,step)=steps[0];
                    ensure!(selected_ids.insert(step.item().preview.id.clone()),"private_credentials_duplicate_selection");
                    offer.validate_source(&sources[index],step.item())?;
                    mapped.push((index,selection,step_index));
                }
            }
            let mut current=targets.provider.read_settings()?;
            let before=crate::providers::revision(&current);
            ensure!(plan.steps.first().is_some_and(|step|first_revision(step)==before.as_str()),"private_credentials_publication_binding_changed");
            let bundle_sha=private_credential_bundle_digest(job_id,old_plan,&action.action_id,&offers)?;
            for offer in &offers { execution.push(offer.publication_lease(&self.profile)?); }
            let claims=execution.iter().map(ReceivedPrivateCredentialLease::existing_claim).collect::<Result<Vec<_>>>()?;
            let existing_intent=execution[0].existing_preparation(job_id)?;
            if let Some(saved)=&existing_intent {
                ensure!(saved.job_id==job_id && saved.original_plan_id==old_plan && saved.action_id==action.action_id && saved.bundle_sha256==bundle_sha
                    && saved.expected_sequence==expected_sequence && saved.consent==PreparationConsent::from(consent)
                    && saved.members==offers.iter().map(|member|(*member).clone()).collect::<Vec<_>>(), "private_credentials_publication_binding_changed");
            }
            let mut plan_id=existing_intent.as_ref().map(|intent|intent.plan_id.clone());
            for claim in claims.iter().flatten() {
                ensure!(claim.job_id==job_id && claim.original_plan_id==old_plan && claim.action_id==action.action_id
                    && (claim.bundle_sha256.as_deref()==Some(bundle_sha.as_str()) || offers.len()==1 && claim.bundle_sha256.is_none()),
                    "private_credentials_publication_binding_changed");
                if let Some(id)=&plan_id { ensure!(id==&claim.plan_id,"private_credentials_publication_binding_changed"); }
                else { plan_id=Some(claim.plan_id.clone()); }
            }
            let plan_id=plan_id.unwrap_or_else(||format!("batch-{}",uuid::Uuid::new_v4().simple()));
            let claim=PublicationClaim {job_id:job_id.into(),original_plan_id:old_plan.into(),action_id:action.action_id.clone(),plan_id:plan_id.clone(),bundle_sha256:Some(bundle_sha.clone())};
            let intent=PreparationIntent {job_id:job_id.into(),request_id:offers[0].received_request_id().into(),expected_sequence,consent:consent.into(),original_plan_id:old_plan.into(),action_id:action.action_id.clone(),plan_id:plan_id.clone(),bundle_sha256:bundle_sha,members:offers.iter().map(|member|(*member).clone()).collect()};
            intent.validate()?;
            let mcp_target=McpCredentialTarget::open(&self.profile)?;
            let mut providers=Vec::new(); let mut mcps=Vec::new();
            for (index,selection,step_index) in mapped {
                let step=&plan.steps[step_index];
                let input=ReceivedCredentialInput {source:&sources[index],material:offers[index],execution:Some(&execution[index]),policy:keys.policy,backend:keys.backend};
                match (selection,step) {
                    (PrivateCredentialSelection::Provider {selector,..},SettingsStep::Provider(plan))=> {
                        let mut key=keys.target.prepare_received_prospective(step.item(),input,(plan.target_name(),plan.provider().clone()),selector.clone(),consent.api_keys)?;
                        key.atomic_group_id=Some(action.action_id.clone()); providers.push(key);
                    }
                    (PrivateCredentialSelection::Mcp {fields,..},SettingsStep::Mcp(plan))=> {
                        mcps.push(mcp_target.prepare_received_prospective(step.item(),input,plan.config(),fields,consent.mcp_private_fields)?);
                    }
                    _=>anyhow::bail!("private_credentials_source_not_selected"),
                }
            }
            let mut next=job.clone(); let batch=next.batch.as_mut().unwrap(); let action=&mut batch.actions[action_index];
            let BatchActionKind::Settings {plan}=&mut action.action else { unreachable!() };
            for step in &mut plan.steps {
                if let SettingsStep::Mcp(mcp)=step && let Some(key)=mcps.iter().find(|key|key.item_id==mcp.item().preview.id) {
                    mcp.item.mcp.as_mut().unwrap().config=key.config.clone(); if mcp.enabled() { key.validate_activation()?; }
                }
                step.rebase(&mut current)?;
            }
            let after=crate::providers::revision(&current);
            for key in &mut mcps { key.bind_group(&action.action_id,&before,&after); }
            batch.credential_plan_ids.extend(providers.iter().map(|plan|plan.plan_id.clone()).chain(mcps.iter().map(|plan|plan.plan_id.clone())));
            batch.plan_id=Some(plan_id); batch.atomic_credentials=true;
            next.credential_plans.extend(providers); next.mcp_credential_plans.extend(mcps);
            ensure!(next.credential_plans.iter().all(|plan|plan.phase==CredentialPhase::Ready),"private_credentials_publication_unknown");
            next.sequence=job.sequence.checked_add(1).context("migration_sequence_exhausted")?;
            ensure!(serde_json::to_vec(&next)?.len() as u64<=MAX_JOURNAL_BYTES,"migration_journal_budget_exceeded");
            next.sequence=job.sequence;
            execution[0].reserve_preparation(&intent)?;
            #[cfg(test)]
            if FAIL_BEFORE_FIRST_BUNDLE_CLAIM.with(|flag|flag.replace(false)) { anyhow::bail!("private_credentials_outcome_unknown"); }
            // Every member, destination and encoded job budget is validated before
            // the first publication birth. Claims contain identifiers and hashes only.
            for (index,lease) in execution.iter().enumerate() {
                lease.claim(&claim,offers.len()==1)?;
                #[cfg(test)]
                if index==0 && offers.len()>1 && FAIL_AFTER_FIRST_BUNDLE_CLAIM.with(|flag|flag.replace(false)) {
                    anyhow::bail!("private_credentials_outcome_unknown");
                }
                #[cfg(not(test))]
                let _=index;
            }
            for lease in &execution { lease.ensure_active()?; }
            *job=next;
            Ok(true)
        })
    }
}

impl MigrationJob {
    /// The actual persisted set, for a redacted reply after successful preparation.
    pub fn received_private_credential_offer_ids(&self) -> Result<Vec<String>> {
        Ok(original_bindings(self)?
            .iter()
            .map(|binding| binding.offer_id().to_owned())
            .collect())
    }
}
