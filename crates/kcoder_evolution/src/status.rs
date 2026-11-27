//! Projections for `evolution/status` and `evolution/targets/list`.

use crate::beta::BetaPrior;
use crate::error::Result;
use crate::overlay::OverlayDocument;
use crate::score::SignalWeights;
use crate::stats::{BetaEvidence, EvolutionStats};
use crate::store::EvolutionStore;
use kcoder_config::EvolutionSettings;
use kcoder_types::evolution::{
    Channel, EvolutionDisabledReason, EvolutionJobStatus, EvolutionModelStatus,
    EvolutionProposalSummary, EvolutionStatusSnapshot, EvolutionTargetSummary,
    EvolutionTargetTypeStatus, EvolutionWriteMode, OverlayCandidateState, Proposal, ProposalState,
    TargetKey, TargetRevision, TargetType,
};
use std::collections::BTreeSet;

/// Caller-provided facts for target summaries.
pub struct TargetSummaryInputs<'a> {
    pub settings: &'a EvolutionSettings,
    /// How each target applies learned content.
    pub write_mode: &'a dyn Fn(&TargetKey) -> EvolutionWriteMode,
}

/// Caller-provided facts for the status snapshot.
pub struct StatusInputs<'a> {
    pub settings: &'a EvolutionSettings,
    /// Overrides the derived reason (training mode, project disabled, model
    /// unavailable). `None` derives `usage_limit` from settings and state.
    pub disabled_reason: Option<EvolutionDisabledReason>,
    pub model: EvolutionModelStatus,
    /// Target types whose integration has shipped.
    pub implemented_types: &'a [TargetType],
    pub jobs: Vec<EvolutionJobStatus>,
    /// Whether the skill store supports candidate slots for direct edits.
    pub skill_file_edits_supported: bool,
    pub now_ms: u64,
}

fn pending(proposal: &Proposal) -> bool {
    matches!(
        proposal.state,
        ProposalState::Draft | ProposalState::Evaluated | ProposalState::Canary
    )
}

/// RPC projection of one proposal. `diff` is the target-file diff when
/// present, otherwise a readable rendering of the overlay changes.
pub fn proposal_summary(proposal: &Proposal) -> EvolutionProposalSummary {
    let diff = proposal.changes.diff.clone().unwrap_or_else(|| {
        let changes = &proposal.changes;
        let mut lines = Vec::new();
        lines.extend(changes.lessons_add.iter().map(|line| format!("+ {line}")));
        for revision in &changes.lessons_revise {
            lines.push(format!("- {}", revision.from));
            lines.push(format!("+ {}", revision.to));
        }
        lines.extend(
            changes
                .lessons_remove
                .iter()
                .map(|line| format!("- {line}")),
        );
        lines.extend(
            changes
                .checklist_edits
                .iter()
                .map(|line| format!("~ checklist: {line}")),
        );
        lines.extend(
            changes
                .examples
                .iter()
                .map(|example| format!("+ example {}", example.name)),
        );
        lines.join("\n")
    });
    let reject_reason = (proposal.state == ProposalState::Rejected)
        .then(|| proposal.history.last().and_then(|step| step.reason.clone()))
        .flatten();
    EvolutionProposalSummary {
        id: proposal.proposal_id.clone(),
        state: proposal.state,
        created_at: crate::time::rfc3339_from_unix_ms(proposal.created_at_ms),
        actor: proposal
            .history
            .first()
            .map(|step| step.actor)
            .unwrap_or(kcoder_types::evolution::ProposalActor::Auto),
        diff,
        evaluation: proposal.evaluation.as_ref().map(Into::into),
        reject_reason,
    }
}

fn summarize(
    key: &TargetKey,
    stats: &EvolutionStats,
    document: Option<&OverlayDocument>,
    proposals: &[Proposal],
    inputs: &TargetSummaryInputs<'_>,
) -> EvolutionTargetSummary {
    let empty = BetaEvidence::default();
    let (stable_revision, stable_evidence) = match document {
        Some(document) => {
            let revision = TargetRevision::new(
                document.base_revision.clone(),
                document.stable.as_ref().map_or(0, |slot| slot.revision),
            );
            let evidence = stats
                .bucket(key, &revision, Channel::Stable)
                .copied()
                .unwrap_or_default();
            (revision, evidence)
        }
        None => match stats.latest_bucket(key, Channel::Stable) {
            Some((bucket, evidence)) => (bucket.revision.clone(), *evidence),
            None => (TargetRevision::new("", 0), empty),
        },
    };
    let stable_posterior = stable_evidence.posterior(BetaPrior::UNIFORM);
    let stable = stable_evidence.score(&stable_revision, BetaPrior::UNIFORM);
    let candidate = document
        .and_then(|document| {
            document
                .candidate
                .as_ref()
                .filter(|candidate| {
                    matches!(
                        candidate.state,
                        OverlayCandidateState::Staged | OverlayCandidateState::Canary
                    )
                })
                .map(|candidate| {
                    TargetRevision::new(document.base_revision.clone(), candidate.revision)
                })
        })
        .map(|revision| {
            let evidence = stats
                .bucket(key, &revision, Channel::Candidate)
                .copied()
                .unwrap_or_default();
            evidence.score(
                &revision,
                BetaPrior::from_previous_stable(&stable_posterior),
            )
        });
    let channel_traffic = document
        .filter(|document| document.canary_active())
        .and_then(|document| document.candidate.as_ref())
        .and_then(|candidate| candidate.traffic);
    let pending_proposals = proposals
        .iter()
        .filter(|proposal| &proposal.target_key == key && pending(proposal))
        .count();
    EvolutionTargetSummary {
        target_key: key.clone(),
        target_type: key.target_type(),
        source: key.source().to_string(),
        name: key.name().to_string(),
        enabled: inputs.settings.target_enabled(key),
        evolution_mode: (inputs.write_mode)(key),
        stable,
        candidate,
        channel_traffic,
        pending_proposals: u32::try_from(pending_proposals).unwrap_or(u32::MAX),
        needs_revalidation: document.is_some_and(|document| document.needs_revalidation),
        pinned: document.is_some_and(|document| document.pinned_stable),
    }
}

impl EvolutionStore {
    /// Summary of one target (stats, overlay pointers and proposals).
    pub fn target_summary(
        &self,
        key: &TargetKey,
        inputs: &TargetSummaryInputs<'_>,
    ) -> Result<EvolutionTargetSummary> {
        let stats = self.stats(&SignalWeights::from_settings(&inputs.settings.signals))?;
        let document = self.overlay_document(key)?;
        let proposals = self.list_proposals()?;
        Ok(summarize(
            key,
            &stats,
            document.as_ref(),
            &proposals,
            inputs,
        ))
    }

    /// Summaries of every known target of a type: those with statistics,
    /// an overlay or a proposal, sorted by target key.
    pub fn list_target_summaries(
        &self,
        target_type: TargetType,
        inputs: &TargetSummaryInputs<'_>,
    ) -> Result<Vec<EvolutionTargetSummary>> {
        let stats = self.stats(&SignalWeights::from_settings(&inputs.settings.signals))?;
        let documents = self.list_overlay_documents()?;
        let proposals = self.list_proposals()?;
        let mut keys: BTreeSet<TargetKey> = stats.targets();
        keys.extend(documents.iter().map(|document| document.target_key.clone()));
        keys.extend(proposals.iter().map(|proposal| proposal.target_key.clone()));
        Ok(keys
            .into_iter()
            .filter(|key| key.target_type() == target_type)
            .map(|key| {
                let document = documents.iter().find(|document| document.target_key == key);
                summarize(&key, &stats, document, &proposals, inputs)
            })
            .collect())
    }

    /// Scope-level snapshot for `evolution/status`.
    pub fn status_snapshot(&self, inputs: StatusInputs<'_>) -> Result<EvolutionStatusSnapshot> {
        let settings = inputs.settings;
        let stats = self.stats(&SignalWeights::from_settings(&settings.signals))?;
        let documents = self.list_overlay_documents()?;
        let proposals = self.list_proposals()?;
        let state = self.read_state()?;
        let targets = TargetType::ALL
            .into_iter()
            .map(|target_type| EvolutionTargetTypeStatus {
                target_type,
                enabled: settings.enabled && settings.targets.type_enabled(target_type),
                implemented: inputs.implemented_types.contains(&target_type),
                learned_items: documents
                    .iter()
                    .filter(|document| {
                        document.target_key.target_type() == target_type
                            && document.stable.is_some()
                    })
                    .count() as u32,
                pending_proposals: proposals
                    .iter()
                    .filter(|proposal| {
                        proposal.target_key.target_type() == target_type && pending(proposal)
                    })
                    .count() as u32,
            })
            .collect();
        let disabled_reason = inputs.disabled_reason.or_else(|| {
            (settings.enabled
                && state
                    .usage_limit_reached(inputs.now_ms, settings.usage_limit.monthly_max_tokens))
            .then_some(EvolutionDisabledReason::UsageLimit)
        });
        Ok(EvolutionStatusSnapshot {
            enabled: settings.enabled,
            mode: settings.mode,
            disabled_reason,
            model: inputs.model,
            targets,
            usage_this_month: (&state.month_usage_at(inputs.now_ms)).into(),
            jobs: inputs.jobs,
            skill_file_edits_supported: inputs.skill_file_edits_supported,
            diagnostics: stats.diagnostics.into(),
        })
    }
}
