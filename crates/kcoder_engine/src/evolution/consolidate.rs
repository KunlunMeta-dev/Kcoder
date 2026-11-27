//! Curator-side overlay consolidation (plan section 13.1).
//!
//! With evolution enabled, merging overlay lessons is never a direct write:
//! repeated lessons (equal after case and whitespace normalization) become a
//! "consolidate" proposal that removes every variant and keeps one. Like any
//! proposal it waits for the user (`propose`); `observe` records nothing.
//! The proposal is identified by the `P-consolidate` pattern id.

use kcoder_evolution::{EvolutionStore, ProposalDraft};
use kcoder_types::evolution::{
    EvolutionMode, OverlayContent, ProposalActor, ProposalChanges, ProposalLocation, ProposalState,
    TargetKey,
};
use std::collections::BTreeMap;

/// Pattern id marking consolidation proposals.
pub(crate) const CONSOLIDATE_PATTERN: &str = "P-consolidate";

fn normalize(line: &str) -> String {
    let trimmed = line.trim();
    let text = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .unwrap_or(trimmed);
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Changes that merge repeated lessons, or `None` when there are none.
pub(crate) fn consolidation_changes(content: &OverlayContent) -> Option<ProposalChanges> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for line in content
        .lessons
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        let trimmed = line.trim();
        let text = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .unwrap_or(trimmed)
            .trim()
            .to_string();
        groups.entry(normalize(line)).or_default().push(text);
    }
    let mut changes = ProposalChanges::default();
    for variants in groups.values().filter(|variants| variants.len() > 1) {
        let mut unique = variants.clone();
        unique.dedup();
        changes.lessons_remove.extend(unique.iter().cloned());
        changes.lessons_add.push(variants[0].clone());
    }
    (!changes.lessons_remove.is_empty()).then_some(changes)
}

/// Propose consolidation for every served overlay of `store` that repeats
/// lessons. Returns the created proposal ids.
pub(crate) fn propose_consolidations(
    store: &EvolutionStore,
    mode: EvolutionMode,
    enabled: &dyn Fn(&TargetKey) -> bool,
    now_ms: u64,
) -> Vec<String> {
    if mode < EvolutionMode::Propose {
        return Vec::new();
    }
    let Ok(documents) = store.list_overlay_documents() else {
        return Vec::new();
    };
    let pending: Vec<TargetKey> = store
        .list_proposals()
        .map(|proposals| {
            proposals
                .into_iter()
                .filter(|proposal| {
                    matches!(
                        proposal.state,
                        ProposalState::Draft | ProposalState::Evaluated
                    ) && proposal
                        .pattern_ids
                        .iter()
                        .any(|id| id == CONSOLIDATE_PATTERN)
                })
                .map(|proposal| proposal.target_key)
                .collect()
        })
        .unwrap_or_default();
    let mut created = Vec::new();
    for document in documents {
        if document.needs_revalidation
            || !enabled(&document.target_key)
            || pending.contains(&document.target_key)
        {
            continue;
        }
        let Some(stable) = store
            .read_overlay(&document.target_key)
            .ok()
            .flatten()
            .and_then(|view| view.stable)
        else {
            continue;
        };
        let Some(changes) = consolidation_changes(&stable) else {
            continue;
        };
        if let Ok(result) = store.create_proposal(
            ProposalDraft {
                target_key: document.target_key.clone(),
                base_revision: document.base_revision.clone(),
                location: ProposalLocation::Overlay,
                changes,
                pattern_ids: vec![CONSOLIDATE_PATTERN.into()],
                evidence_ids: Vec::new(),
                actor: ProposalActor::Auto,
            },
            now_ms,
        ) && result.created
        {
            created.push(result.proposal.proposal_id);
        }
    }
    created
}
