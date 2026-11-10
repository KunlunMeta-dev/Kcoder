//! The original parent intent is separate from the parent's current mutable sequence.
use super::super::*;
use super::{attachment_view::*, birth::BirthOutcome};

impl HistoryJobStore {
    /// The caller retains the original parent journal's read lease and validates source plans.
    pub(crate) fn inspect_parent_resource_attachment(
        &self,
        parent: &str,
        current_sequence: u64,
        current_plan: &str,
        mut sources: Vec<(String, String, String)>,
        declared: Option<&kcoder_types::migration_resource::MigrationResourceLimits>,
    ) -> Result<ResourceAttachmentObservation> {
        sources.sort();
        ensure!(
            !sources.is_empty()
                && sources.len() <= 64
                && !sources.windows(2).any(|pair| pair[0].0 == pair[1].0),
            "history_resource_parent_unknown"
        );
        let mut view = ResourceAttachmentObservation {
            job_id: parent.into(),
            owner_job_id: Some(parent.into()),
            current_sequence,
            current_plan_id: Some(current_plan.into()),
            phase: ResourceAttachmentPhase::Unknown,
            original_intent: None,
            issue_code: None,
        };
        let original = match self.parent_resource_intent(parent) {
            Ok(intent) => intent,
            Err(_) => return Ok(view.unknown("history_resource_parent_preparation_unknown")),
        };
        if let Some(intent) = &original {
            if intent.plan != current_plan || intent.sources != sources {
                return Ok(view.unknown("history_resource_parent_intent_changed"));
            }
            view.original_intent = Some(ResourceAttachmentIntent {
                expected_sequence: intent.sequence,
                plan_id: Some(intent.plan.clone()),
                initial_limits: intent.limits.clone(),
            });
        }
        let members = sources
            .iter()
            .map(|source| source.0.clone())
            .collect::<Vec<_>>();
        let group = match self.recorded_batch_resource_budget(parent, members.clone()) {
            Ok(group) => group,
            Err(_) => return Ok(view.unknown("history_resource_attachment_unknown")),
        };
        let Some(group) = group else {
            if original.is_some() || declared.is_some() {
                return Ok(view.unknown("history_resource_ledger_missing"));
            }
            for child in &members {
                let job = self.load(child)?;
                if job.resource_budget.is_some() || self.resource_birth(child)?.is_some() {
                    return Ok(view.unknown("history_resource_ledger_missing"));
                }
            }
            if self.parent_resource_intent(parent)?.is_some() {
                return Ok(view.unknown("history_resource_attachment_changed"));
            }
            view.phase = ResourceAttachmentPhase::Untracked;
            return Ok(view);
        };
        if declared.is_some_and(|limits| limits != &group.initial_limits)
            || original.as_ref().is_some_and(|intent| {
                intent.limits != group.initial_limits
                    || intent
                        .reference
                        .as_ref()
                        .is_some_and(|reference| reference != &group.reference)
            })
        {
            return Ok(view.unknown("history_resource_parent_preparation_unknown"));
        }
        let mut bound = true;
        for child in &members {
            let job = self.load(child)?;
            let birth = self.resource_birth(child)?;
            if let Some(binding) = &job.resource_budget {
                if binding.owner != parent
                    || binding.members != members
                    || binding.member != *child
                    || binding.reference != group.reference
                    || binding.initial_limits != group.initial_limits
                    || self
                        .verify_standalone_resource_budget(
                            child,
                            &job.resource_source_identity()?,
                            binding,
                        )
                        .is_err()
                {
                    return Ok(view.unknown("history_resource_birth_unknown"));
                }
            } else {
                bound = false;
                if let Some(birth) = birth
                    && (birth.resource_owner != parent
                        || birth.members != members
                        || birth.member != *child
                        || birth.source_identity != job.resource_source_identity()?
                        || birth.initial_limits != group.initial_limits
                        || !matches!(birth.outcome, BirthOutcome::Bound { reference } if reference == group.reference))
                {
                    return Ok(view.unknown("history_resource_birth_unknown"));
                }
            }
        }
        view.phase = match original {
            None => ResourceAttachmentPhase::Tracked,
            Some(intent) if bound && declared.is_some() && intent.reference.is_some() => {
                ResourceAttachmentPhase::Attached
            }
            Some(_) => ResourceAttachmentPhase::Pending,
        };
        Ok(view)
    }
}
