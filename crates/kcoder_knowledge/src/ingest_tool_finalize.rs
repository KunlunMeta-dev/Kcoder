//! Delivery validation, partial publication and pending derivation for the
//! file contract. Citation exactness and base revisions are never relaxed:
//! a page that still fails them is withheld, not published. Required units
//! without a confirmed placement become pending; unconfirmed published ranges
//! are recorded as unverified findings and never counted as verified.
use super::super::wiki_files::delivery::{self, Delivery, Located};
use super::*;
use kcoder_types::wiki_findings::{
    WikiPendingUnitRecord, WikiPublicationFindings, WikiUnverifiedRange, WikiWithheldUpdate,
};

pub(in crate::ingest) struct Checked {
    pub delivery: Delivery,
    pub problems: Vec<Located>,
    pub gaps: Vec<String>,
}

pub(in crate::ingest) struct LoopOutcome {
    pub proposal: WikiProposal,
    pub publication: WikiPublicationFindings,
}

fn located(error: &anyhow::Error, delivery: &Delivery) -> Located {
    let (code, field) = error
        .downcast_ref::<WikiCandidateFailure>()
        .map_or(("wiki_candidate_invalid", "/".to_owned()), |failure| {
            (failure.code, failure.field.clone())
        });
    let (path, line) = delivery::locate(&field, &delivery.maps, &delivery.proposal);
    Located {
        path,
        line,
        code: code.into(),
    }
}

/// Explicit `sourceUnits` placements replace derived ones on that page only.
fn merge_proof(
    inventory: &ingest_organization::Inventory,
    proposal: &mut WikiProposal,
    refs: &ingest_citation_refs::CitationRefs,
) -> Result<()> {
    let explicit = proposal.organization_proof.take();
    inventory.derive_omitted_proof(proposal, refs, true)?;
    if let Some(explicit) = explicit {
        let declared: BTreeSet<String> = explicit
            .placements
            .iter()
            .map(|placement| placement.page_id.clone())
            .collect();
        match proposal.organization_proof.as_mut() {
            Some(derived) => {
                derived
                    .placements
                    .retain(|placement| !declared.contains(&placement.page_id));
                derived.placements.extend(explicit.placements);
            }
            None => proposal.organization_proof = Some(explicit),
        }
    }
    Ok(())
}

fn drop_pages(delivery: &mut Delivery, excluded: &BTreeSet<String>) {
    delivery
        .proposal
        .pages
        .retain(|page| !excluded.contains(&page.page_id));
    delivery.maps.retain(|map| !excluded.contains(&map.page_id));
    // Deterministically drop links to pages that will not exist.
    for page in &mut delivery.proposal.pages {
        page.related_page_ids
            .retain(|target| !excluded.contains(target));
    }
    if let Some(proof) = delivery.proposal.organization_proof.as_mut() {
        proof
            .placements
            .retain(|placement| !excluded.contains(&placement.page_id));
    }
}

fn check_with(
    contract: &FileContract<'_>,
    tree: &WikiTree,
    existing: &[StoredPage],
    excluded: &BTreeSet<String>,
) -> Result<Checked> {
    let unit_ids = contract.unit_ids();
    let context = contract.draft_context(existing, &unit_ids);
    let mut delivery = delivery::deliver(tree, &context);
    let mut problems: Vec<Located> = delivery
        .errors
        .iter()
        .filter(|problem| {
            !excluded
                .iter()
                .any(|page| problem.path == format!("draft/{page}.md"))
        })
        .cloned()
        .collect();
    drop_pages(&mut delivery, excluded);
    let plan = contract.plan();
    let all_required = || {
        plan.map(|plan| {
            plan.units
                .iter()
                .filter(|unit| unit.disposition == ingest_organization::Disposition::Required)
                .map(|unit| unit.unit_id.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
    };
    if delivery.proposal.pages.is_empty() {
        return Ok(Checked {
            delivery,
            problems,
            gaps: all_required(),
        });
    }
    let proposal = &mut delivery.proposal;
    crate::citation_repair::normalize_new_citation_quotes(
        proposal,
        contract.source_id,
        contract.revision_id,
        contract.chunks,
        existing,
    );
    if plan.is_some() {
        if let Err(error) = merge_proof(contract.inventory, proposal, contract.refs) {
            problems.push(located(&error, &delivery));
            return Ok(Checked {
                delivery,
                problems,
                gaps: Vec::new(),
            });
        }
        if let Err(error) =
            contract
                .inventory
                .derive_omitted_refs(&mut delivery.proposal, contract.refs, true)
        {
            problems.push(located(&error, &delivery));
            return Ok(Checked {
                delivery,
                problems,
                gaps: Vec::new(),
            });
        }
    }
    if let Err(error) = validate_candidate_with(
        &delivery.proposal,
        existing,
        contract.new_ids,
        contract.overview_id,
        CandidateLimits {
            max_pages: MAX_FILE_CONTRACT_PAGES,
            max_new_topics: contract.topic_limit,
        },
    ) {
        problems.push(located(&error, &delivery));
        return Ok(Checked {
            delivery,
            problems,
            gaps: Vec::new(),
        });
    }
    let citations = crate::citation_repair::errors(
        &delivery.proposal,
        contract.source_id,
        contract.revision_id,
        contract.chunks,
        existing,
    );
    for (code, field) in &citations.located {
        let (path, line) = delivery::locate(field, &delivery.maps, &delivery.proposal);
        problems.push(Located {
            path,
            line,
            code: (*code).into(),
        });
    }
    // Only required inventory units are drafting gaps. Purpose aspects the
    // source cannot cover and uncertain dispositions are plan facts, recorded
    // separately rather than sent back to the model.
    let required: BTreeSet<String> = all_required().into_iter().collect();
    let gaps = match plan {
        Some(plan) => match contract.inventory.validate_proof(
            plan,
            &mut delivery.proposal,
            contract.refs,
            true,
        ) {
            Ok(gaps) => gaps
                .into_iter()
                .filter(|gap| required.contains(gap))
                .collect(),
            Err(error) => {
                problems.push(located(&error, &delivery));
                Vec::new()
            }
        },
        None => Vec::new(),
    };
    problems.sort_by(|left, right| (&left.path, left.line).cmp(&(&right.path, right.line)));
    problems.dedup();
    Ok(Checked {
        delivery,
        problems,
        gaps,
    })
}

pub(in crate::ingest) fn check(
    contract: &FileContract<'_>,
    tree: &WikiTree,
    existing: &[StoredPage],
) -> Result<Checked> {
    check_with(contract, tree, existing, &BTreeSet::new())
}

fn marked(checked: &Checked) -> BTreeMap<String, BTreeMap<usize, Vec<usize>>> {
    checked
        .delivery
        .maps
        .iter()
        .map(|map| (map.page_id.clone(), map.marked.clone()))
        .collect()
}

/// Verify changed bodies. With a previous round, only pages whose body changed
/// since that round are assessed again; other findings carry over.
pub(in crate::ingest) async fn verify_round(
    contract: &FileContract<'_>,
    checked: &Checked,
    existing: &[StoredPage],
    previous: Option<&VerifiedRound>,
) -> Result<VerifiedRound> {
    let proposal = &checked.delivery.proposal;
    let bodies: BTreeMap<String, String> = proposal
        .pages
        .iter()
        .filter(|page| page.kind != KnowledgePageKind::Source)
        .map(|page| {
            (
                page.page_id.clone(),
                crate::objects::digest(page.markdown.as_bytes()),
            )
        })
        .collect();
    let mut round = VerifiedRound {
        bodies: bodies.clone(),
        ..VerifiedRound::default()
    };
    let mut check_pages = BTreeSet::new();
    for (page, hash) in &bodies {
        match previous {
            Some(previous) if previous.bodies.get(page) == Some(hash) => {
                round.unverified.extend(
                    previous
                        .unverified
                        .iter()
                        .filter(|finding| &finding.page_id == page)
                        .cloned(),
                );
                if let Some(count) = previous.verified_units.get(page) {
                    round.verified_units.insert(page.clone(), *count);
                }
            }
            _ => {
                check_pages.insert(page.clone());
            }
        }
    }
    if let Some(previous) = previous {
        round.unsettled = previous.unsettled.clone();
    }
    if check_pages.is_empty() {
        return Ok(round);
    }
    let organization = previous
        .is_none()
        .then_some((contract.inventory, contract.plan()));
    let result = ingest_support::lenient::verify(
        proposal,
        &check_pages,
        &contract.context_request()?,
        contract.model,
        contract.context_tokens,
        contract.cancel,
        contract.chunks,
        existing,
        organization,
        &marked(checked),
        if previous.is_some() {
            "verify-2"
        } else {
            "verify-1"
        },
    )
    .await?;
    round.unverified.extend(result.unverified);
    round.verified_units.extend(result.verified_units);
    if previous.is_none() {
        round.unsettled = result
            .organization_unsettled
            .into_iter()
            .map(|(unit, code)| (unit, code.to_owned()))
            .collect();
    }
    Ok(round)
}

fn page_of(path: &str) -> Option<&str> {
    path.strip_prefix("draft/")?.strip_suffix(".md")
}

/// Publish what passed, withhold what did not, and record pending units.
pub(in crate::ingest) async fn outcome(
    contract: &FileContract<'_>,
    state: LoopState,
    generation: &WikiModelRequest,
) -> Result<LoopOutcome> {
    let existing = state.existing_all(contract.existing);
    let before = check(contract, &state.tree, &existing)?;
    let placed_before: BTreeMap<String, BTreeSet<String>> = before
        .delivery
        .proposal
        .organization_proof
        .as_ref()
        .map(|proof| {
            let mut units: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            for placement in &proof.placements {
                units
                    .entry(placement.unit_id.clone())
                    .or_default()
                    .insert(placement.page_id.clone());
            }
            units
        })
        .unwrap_or_default();
    let mut excluded: BTreeSet<String> = BTreeSet::new();
    let mut reasons: BTreeMap<String, String> = BTreeMap::new();
    let mut checked = before;
    for _ in 0..=MAX_FILE_CONTRACT_PAGES + 2 {
        let mut added = false;
        for problem in checked
            .problems
            .iter()
            .filter(|problem| problem.path != "review.md")
        {
            match page_of(&problem.path) {
                Some(page) if !excluded.contains(page) => {
                    excluded.insert(page.to_owned());
                    reasons
                        .entry(page.to_owned())
                        .or_insert_with(|| problem.code.clone());
                    added = true;
                }
                Some(_) => {}
                None if problem.code == "wiki_candidate_page_count"
                    || problem.code == "wiki_candidate_new_topic_count" =>
                {
                    // Keep existing-page updates; withhold the last new topics.
                    if let Some(page) = checked
                        .delivery
                        .proposal
                        .pages
                        .iter()
                        .rev()
                        .find(|page| {
                            page.expected_revision.is_none() && page.page_id != contract.overview_id
                        })
                        .or_else(|| checked.delivery.proposal.pages.last())
                    {
                        excluded.insert(page.page_id.clone());
                        reasons.insert(page.page_id.clone(), problem.code.clone());
                        added = true;
                    }
                }
                None => {
                    // Unattributable proof/structure failure: publish no model page.
                    for page in &checked.delivery.proposal.pages {
                        if excluded.insert(page.page_id.clone()) {
                            reasons.insert(page.page_id.clone(), problem.code.clone());
                            added = true;
                        }
                    }
                }
            }
        }
        if !added {
            break;
        }
        checked = check_with(contract, &state.tree, &existing, &excluded)?;
    }
    let mut proposal = std::mem::take(&mut checked.delivery.proposal);
    proposal.review_notes.truncate(MAX_REVIEW_NOTES);
    proposal
        .review_notes
        .retain(|note| note.len() <= MAX_REVIEW_NOTE_BYTES);
    proposal
        .advisory_notes
        .retain(|note| note.len() <= MAX_REVIEW_NOTE_BYTES);
    proposal
        .advisory_notes
        .truncate(MAX_REVIEW_NOTES.saturating_sub(proposal.review_notes.len()));
    checked.delivery.proposal = proposal;
    // Verification of exactly the published candidate (cached across restarts).
    let round = if checked.delivery.proposal.pages.is_empty() {
        VerifiedRound::default()
    } else {
        verify_round(contract, &checked, &existing, state.first_round.as_ref()).await?
    };
    let proposal = std::mem::take(&mut checked.delivery.proposal);
    let final_bodies: BTreeMap<&str, String> = proposal
        .pages
        .iter()
        .map(|page| {
            (
                page.page_id.as_str(),
                crate::objects::digest(page.markdown.as_bytes()),
            )
        })
        .collect();
    let unverified: Vec<WikiUnverifiedRange> = round
        .unverified
        .into_iter()
        .filter(|finding| final_bodies.get(finding.page_id.as_str()) == Some(&finding.body_hash))
        .collect();
    let verified_units = round
        .verified_units
        .iter()
        .filter(|(page, _)| final_bodies.contains_key(page.as_str()))
        .map(|(_, count)| *count)
        .sum();
    let mut withheld = Vec::new();
    for page in &excluded {
        if let Some(base) = existing
            .iter()
            .find(|prior| &prior.draft.page_id == page)
            .map(|prior| prior.revision_id.clone())
        {
            withheld.push(WikiWithheldUpdate {
                page_id: page.clone(),
                expected_revision: base,
                code: reasons
                    .get(page)
                    .cloned()
                    .unwrap_or_else(|| "wiki_page_withheld".into()),
            });
        }
    }
    let unit_record = |unit_id: &str, reason: &str| {
        let unit = contract
            .inventory
            .units
            .iter()
            .find(|unit| unit.id == unit_id);
        WikiPendingUnitRecord {
            source_id: contract.source_id.into(),
            source_revision: contract.revision_id.into(),
            unit_id: unit_id.into(),
            chunk_ids: unit
                .map(|unit| vec![unit.chunk_id.clone()])
                .unwrap_or_default(),
            first_line: unit.map_or(0, |unit| unit.first_line),
            last_line: unit.map_or(0, |unit| unit.last_line),
            reason_code: reason.into(),
        }
    };
    let mut pending: Vec<WikiPendingUnitRecord> = Vec::new();
    let mut push = |record: WikiPendingUnitRecord| {
        if !pending.iter().any(|known| known.unit_id == record.unit_id) {
            pending.push(record);
        }
    };
    match contract.plan() {
        None => push(WikiPendingUnitRecord {
            source_id: contract.source_id.into(),
            source_revision: contract.revision_id.into(),
            unit_id: "batch".into(),
            chunk_ids: contract
                .chunks
                .iter()
                .map(|chunk| chunk.chunk_id.clone())
                .collect(),
            first_line: contract.chunks.first().map_or(0, |chunk| chunk.first_line),
            last_line: contract.chunks.last().map_or(0, |chunk| chunk.last_line),
            reason_code: "wiki_organization_plan_missing".into(),
        }),
        Some(plan) => {
            for gap in &checked.gaps {
                let withheld_page = placed_before
                    .get(gap)
                    .is_some_and(|pages| pages.iter().any(|page| excluded.contains(page)));
                push(unit_record(
                    gap,
                    if withheld_page {
                        "wiki_page_withheld"
                    } else {
                        "wiki_organization_unit_unplaced"
                    },
                ));
            }
            for unit in plan
                .units
                .iter()
                .filter(|unit| unit.disposition == ingest_organization::Disposition::Uncertain)
            {
                push(unit_record(
                    &unit.unit_id,
                    "wiki_organization_uncertain_disposition",
                ));
            }
            for (unit, code) in &round.unsettled {
                push(unit_record(unit, code));
            }
        }
    }
    let publication = WikiPublicationFindings {
        verified_units,
        unverified,
        pending,
        withheld,
        tool_turns: state.turns as u32,
        tool_calls: state.calls as u32,
        loop_end: state.end.clone(),
    };
    if !proposal.pages.is_empty() {
        ingest_pipeline::completed(contract.model, generation, &proposal)?;
    } else {
        model_stage_without_pages(contract.model, generation)?;
    }
    Ok(LoopOutcome {
        proposal,
        publication,
    })
}

fn model_stage_without_pages(model: &dyn WikiModel, generation: &WikiModelRequest) -> Result<()> {
    ingest_pipeline::completed(model, generation, &serde_json::json!({"pages":[]}))
}
