//! Inspect the original birth without creating a marker or claiming execution authority.
use super::super::*;
use super::{attachment_view::*, birth::BirthOutcome};

impl HistoryJobStore {
    pub fn resource_attachment(&self, job_id: &str) -> Result<ResourceAttachmentObservation> {
        let job = self.load(job_id)?;
        let mut view = ResourceAttachmentObservation {
            job_id: job_id.into(),
            owner_job_id: None,
            current_sequence: job.view.sequence,
            current_plan_id: None,
            phase: ResourceAttachmentPhase::Unknown,
            original_intent: None,
            issue_code: None,
        };
        let birth = match self.resource_birth(job_id) {
            Ok(birth) => birth,
            Err(_) => return Ok(view.unknown("history_resource_birth_unknown")),
        };
        let Some(birth) = birth else {
            if job.resource_budget.is_some() {
                return Ok(view.unknown("history_resource_birth_unknown"));
            }
            return match self.known_legacy_resource_budget(&job) {
                Ok(Some(recipe)) => {
                    view.owner_job_id = Some(recipe.owner.clone());
                    view.phase = if recipe.owner == job_id {
                        ResourceAttachmentPhase::Tracked
                    } else {
                        ResourceAttachmentPhase::ParentOwned
                    };
                    Ok(view)
                }
                Ok(None) => match self.original_resource_parent(&job) {
                    Ok(Some(parent)) => {
                        view.owner_job_id = Some(parent.owner);
                        view.phase = ResourceAttachmentPhase::ParentOwned;
                        Ok(view)
                    }
                    Ok(None) => {
                        // An attachment may have started after the first header observation.
                        // Report uncertainty instead of calling a newly born intent absent.
                        if self.resource_birth(job_id)?.is_some() {
                            return Ok(view.unknown("history_resource_attachment_changed"));
                        }
                        view.owner_job_id = Some(job_id.into());
                        view.phase = ResourceAttachmentPhase::Untracked;
                        Ok(view)
                    }
                    Err(_) => Ok(view.unknown("history_resource_parent_unknown")),
                },
                Err(_) => Ok(view.unknown("history_resource_attachment_unknown")),
            };
        };
        let identity = match job.resource_source_identity() {
            Ok(identity) => identity,
            Err(_) => return Ok(view.unknown("history_resource_attachment_unknown")),
        };
        if birth.source_identity != identity {
            return Ok(view.unknown("history_resource_birth_unknown"));
        }
        let recipe = match self.archives.recorded_resource_budget_for_plan(
            &birth.resource_owner,
            birth.members.clone(),
            birth.initial_limits.clone(),
        ) {
            Ok(recipe) => recipe,
            Err(_) => return Ok(view.unknown("history_resource_attachment_unknown")),
        };
        view.owner_job_id = Some(birth.resource_owner.clone());
        if birth.resource_owner != job_id {
            return match self.original_resource_parent(&job) {
                Ok(Some(parent)) if parent.owner == birth.resource_owner => {
                    view.phase = ResourceAttachmentPhase::ParentOwned;
                    Ok(view)
                }
                _ => Ok(view.unknown("history_resource_parent_unknown")),
            };
        }
        if birth.members != [job_id] || birth.member != job_id {
            return Ok(view.unknown("history_resource_birth_unknown"));
        }
        if let Some(expected_sequence) = birth.upgrade_sequence {
            view.original_intent = Some(ResourceAttachmentIntent {
                expected_sequence,
                plan_id: None,
                initial_limits: birth.initial_limits.clone(),
            });
        }
        let Some(reference) = recipe else {
            return Ok(view.unknown("history_resource_ledger_missing"));
        };
        match birth.outcome {
            BirthOutcome::Pending => {
                view.phase = ResourceAttachmentPhase::Pending;
            }
            BirthOutcome::Bound {
                reference: original,
            } => {
                if original != reference {
                    return Ok(view.unknown("history_resource_birth_unknown"));
                }
                if let Some(binding) = &job.resource_budget {
                    if self
                        .verify_standalone_resource_budget(job_id, &identity, binding)
                        .is_err()
                    {
                        return Ok(view.unknown("history_resource_birth_unknown"));
                    }
                    view.phase = if view.original_intent.is_some() {
                        ResourceAttachmentPhase::Attached
                    } else {
                        ResourceAttachmentPhase::Tracked
                    };
                } else if view.original_intent.is_some() {
                    view.phase = ResourceAttachmentPhase::Pending;
                } else {
                    return Ok(view.unknown("history_resource_attachment_unknown"));
                }
            }
        }
        Ok(view)
    }
}
