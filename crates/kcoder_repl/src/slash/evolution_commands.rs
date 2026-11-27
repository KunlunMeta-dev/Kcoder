//! `/evolution` and `/rate`: terminal access to the shared self-evolution
//! service (the same `kcoder_tools::evolution_service` the app-server RPCs
//! use), so status, proposal decisions and ratings follow one set of rules.

use crate::ReplApp;
use kcoder_engine::QueryEngine;
use kcoder_engine::evolution::DistillRequestOutcome;
use kcoder_tools::evolution_service::{
    ConfiguredModel, EvolutionService, EvolutionServiceInputs, ProposalDecision, RatingRequest,
    data_root_for, user_layer_enabled,
};
use kcoder_types::MessageRole;
use kcoder_types::evolution::{
    EvolutionStatusSnapshot, EvolutionTargetSummary, TargetKey, TargetType,
};

use super::{SlashCommand, SlashResult};

const LIST_LIMIT: usize = 50;
const EVOLUTION_USAGE: &str = "/evolution [status | list <type> | approve <proposal-id> | reject <proposal-id> | rollback <proposal-id> | distill <target-key>]";
const RATE_USAGE: &str = "/rate up|down [reason]";
/// Same bound as the `evolution/rate` RPC.
const REASON_MAX_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
enum EvolutionAction {
    Status,
    List(TargetType),
    Decide(ProposalDecision, String),
    Distill(TargetKey),
}

fn parse_evolution(args: &str) -> Result<EvolutionAction, String> {
    let mut tokens = args.split_whitespace();
    let action = match (tokens.next(), tokens.next()) {
        (None | Some("status"), None) => EvolutionAction::Status,
        (Some("list"), Some(kind)) => {
            EvolutionAction::List(TargetType::parse(kind).map_err(|_| {
                format!(
                    "Unknown target type `{kind}`. Use one of: {}.",
                    TargetType::ALL.map(TargetType::as_str).join(", ")
                )
            })?)
        }
        (Some(verb @ ("approve" | "reject" | "rollback")), Some(id)) => {
            let decision = match verb {
                "approve" => ProposalDecision::Accept,
                "reject" => ProposalDecision::Reject,
                _ => ProposalDecision::Rollback,
            };
            EvolutionAction::Decide(decision, id.to_string())
        }
        (Some("distill"), Some(key)) => EvolutionAction::Distill(
            TargetKey::parse(key)
                .map_err(|_| format!("`{key}` is not a target key such as `skill:bundled:git`."))?,
        ),
        _ => return Err(format!("Usage: {EVOLUTION_USAGE}")),
    };
    if tokens.next().is_some() {
        return Err(format!("Usage: {EVOLUTION_USAGE}"));
    }
    Ok(action)
}

fn parse_rate(args: &str) -> Result<(bool, Option<String>), String> {
    let args = args.trim();
    let (rating, reason) = args.split_once(char::is_whitespace).unwrap_or((args, ""));
    let up = match rating {
        "up" => true,
        "down" => false,
        _ => return Err(format!("Usage: {RATE_USAGE}")),
    };
    let reason = reason.trim();
    if reason.chars().count() > REASON_MAX_CHARS {
        return Err(format!(
            "The reason is limited to {REASON_MAX_CHARS} characters."
        ));
    }
    Ok((up, (!reason.is_empty()).then(|| reason.to_string())))
}

fn service(engine: &QueryEngine) -> Result<EvolutionService, String> {
    let settings = engine
        .settings
        .read()
        .map_err(|_| "Settings are unavailable.".to_string())?
        .clone();
    let user_settings = engine.settings_persistence_path();
    let data_root = data_root_for(user_settings.as_deref()).map_err(|error| error.message)?;
    let models = QueryEngine::configured_model_profiles_for_settings(&settings)
        .into_iter()
        .map(|profile| ConfiguredModel {
            provider: profile.provider,
            model: profile.model,
            available: profile.available,
        })
        .collect();
    let registry = engine
        .skill_registry
        .read()
        .map_err(|_| "The skill registry is unavailable.".to_string())?;
    Ok(EvolutionService::new(EvolutionServiceInputs {
        settings: &settings,
        user_enabled: user_settings.as_deref().and_then(user_layer_enabled),
        models,
        skills: Some(&registry),
        workspace: Some(engine.state.cwd().to_path_buf()),
        data_root,
        hooks: engine.evolution_hooks(),
    })
    .with_overlay_edit_recorder(kcoder_engine::evolution::record_overlay_user_edit))
}

fn status_text(status: &EvolutionStatusSnapshot) -> String {
    let mut lines = vec!["## Self-evolution".to_string(), String::new()];
    let state = if !status.enabled {
        "off".to_string()
    } else if let Some(reason) = status.disabled_reason {
        format!(
            "paused ({})",
            serde_json::to_value(reason)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_default()
        )
    } else {
        "on".to_string()
    };
    let mode = serde_json::to_value(status.mode)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    lines.push(format!("- State: {state}; mode: {mode}"));
    let model = match (&status.model.provider, &status.model.model) {
        (Some(provider), Some(model)) => format!(
            "{provider}/{model}{}",
            if status.model.available {
                ""
            } else {
                " (unavailable)"
            }
        ),
        _ => "follows the session model".to_string(),
    };
    lines.push(format!("- Model: {model}"));
    lines.push(format!(
        "- Model usage this month: {} input / {} output tokens",
        status.usage_this_month.input_tokens, status.usage_this_month.output_tokens
    ));
    if status.diagnostics.project_scope_issue.is_some() {
        lines.push(
            "- Project data is skipped: the data directory is inside this project.".to_string(),
        );
    }
    lines.push(String::new());
    for target in &status.targets {
        let note = if !target.implemented {
            " (coming soon)".to_string()
        } else {
            format!(
                ": {} learned, {} pending proposals",
                target.learned_items, target.pending_proposals
            )
        };
        lines.push(format!(
            "- `{}` {}{note}",
            target.target_type,
            if target.enabled { "on" } else { "off" }
        ));
    }
    lines.join("\n")
}

fn list_text(target_type: TargetType, items: &[EvolutionTargetSummary], more: bool) -> String {
    if items.is_empty() {
        return format!("No `{target_type}` targets are known yet.");
    }
    let mut lines = vec![format!("## `{target_type}` targets"), String::new()];
    for item in items {
        let mut flags = Vec::new();
        if !item.enabled {
            flags.push("off");
        }
        if item.pinned {
            flags.push("pinned");
        }
        if item.needs_revalidation {
            flags.push("needs revalidation");
        }
        if item.candidate.is_some() {
            flags.push("candidate");
        }
        let flags = if flags.is_empty() {
            String::new()
        } else {
            format!(" [{}]", flags.join(", "))
        };
        lines.push(format!(
            "- `{}` score {:.2} ({} obs), {} pending{flags}",
            item.target_key, item.stable.mean, item.stable.observations, item.pending_proposals
        ));
    }
    if more {
        lines.push(format!(
            "- … more than {LIST_LIMIT} targets; use Studio to page through them."
        ));
    }
    lines.join("\n")
}

fn run_evolution(service: &EvolutionService, action: EvolutionAction) -> String {
    match action {
        EvolutionAction::Status => match service.status() {
            Ok(status) => status_text(&status),
            Err(error) => format!("Self-evolution status failed: {}", error.message),
        },
        EvolutionAction::List(target_type) => {
            match service.list_targets(target_type, None, Some(LIST_LIMIT)) {
                Ok((items, next)) => list_text(target_type, &items, next.is_some()),
                Err(error) => format!("Listing targets failed: {}", error.message),
            }
        }
        EvolutionAction::Decide(decision, id) => {
            let result = service.find_proposal(&id).and_then(|(key, proposal)| {
                let revision = service.overlay_revision(&key)?;
                service
                    .decide_with_notice(&key, &proposal, decision, &revision)
                    .map(|(summary, _, notice)| (proposal, summary, notice))
            });
            match result {
                Ok((proposal, summary, notice)) => {
                    let verb = match decision {
                        ProposalDecision::Accept => "Approved",
                        ProposalDecision::Reject => "Rejected",
                        ProposalDecision::Rollback => "Rolled back",
                        ProposalDecision::PinStable => "Pinned",
                    };
                    let mut text =
                        format!("{verb} proposal `{proposal}` for `{}`.", summary.target_key);
                    if let Some(notice) = notice {
                        text.push_str("\n\n");
                        text.push_str(&notice);
                    }
                    text
                }
                Err(error) => format!(
                    "Proposal decision failed ({}): {}",
                    error.code, error.message
                ),
            }
        }
        EvolutionAction::Distill(_) => unreachable!("distillation runs on the engine"),
    }
}

fn distill_text(key: &TargetKey, outcome: DistillRequestOutcome) -> String {
    match outcome {
        DistillRequestOutcome::Queued => {
            format!("Queued `{key}`; feedback is organized the next time the session is idle.")
        }
        DistillRequestOutcome::Disabled => {
            format!("Not queued: self-evolution, `{key}` or its propose mode is off.")
        }
        DistillRequestOutcome::UnknownTarget => {
            format!("Not queued: `{key}` is not a skill of this session.")
        }
        DistillRequestOutcome::ModelUnavailable(reason) => {
            format!("Not queued: the distill model is unavailable ({reason}).")
        }
    }
}

fn run_rate(service: &EvolutionService, request: &RatingRequest) -> String {
    match service.rate(request) {
        Ok(true) => format!(
            "Rated {} {}.",
            request.turn_id,
            if request.up { "up" } else { "down" }
        ),
        Ok(false) => "Nothing to rate: no evolution target was used in the last turn.".to_string(),
        Err(error) if error.code == "evolution_disabled" => {
            "Self-evolution is off; turn it on to record ratings.".to_string()
        }
        Err(error) => format!("Rating failed: {}", error.message),
    }
}

#[derive(Default)]
pub(super) struct EvolutionCommand;

#[async_trait::async_trait]
impl SlashCommand for EvolutionCommand {
    fn name(&self) -> &'static str {
        "/evolution"
    }
    fn description(&self) -> &'static str {
        "Show self-evolution status, list targets, or decide proposals."
    }
    fn usage(&self) -> &'static str {
        EVOLUTION_USAGE
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let text = match parse_evolution(args).and_then(|action| match action {
            EvolutionAction::Distill(key) => {
                Ok(distill_text(&key, engine.request_evolution_distill(&key)))
            }
            action => service(engine).map(|service| run_evolution(&service, action)),
        }) {
            Ok(text) | Err(text) => text,
        };
        app.push_message(MessageRole::System, text);
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct RateCommand;

#[async_trait::async_trait]
impl SlashCommand for RateCommand {
    fn name(&self) -> &'static str {
        "/rate"
    }
    fn description(&self) -> &'static str {
        "Rate the last turn for self-evolution."
    }
    fn usage(&self) -> &'static str {
        RATE_USAGE
    }
    fn needs_arguments(&self) -> bool {
        true
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let text = match parse_rate(args) {
            Err(text) => text,
            Ok((up, reason)) => {
                // The same turn identity the Engine records usages under
                // (an attempt's turn id, or `turn-N` for legacy sessions).
                let turn = kcoder_engine::evolution::latest_rating_turn_id(&engine.state);
                match turn {
                    None => "There is no turn to rate yet.".to_string(),
                    Some(turn_id) => match service(engine) {
                        Ok(service) => run_rate(
                            &service,
                            &RatingRequest {
                                thread_id: engine.session_id(),
                                turn_id,
                                tool_call_ids: Vec::new(),
                                target_key: None,
                                up,
                                reason,
                            },
                        ),
                        Err(text) => text,
                    },
                }
            }
        };
        app.push_message(MessageRole::System, text);
        SlashResult::Handled
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn service_at(root: &std::path::Path, enabled: bool) -> EvolutionService {
        let mut settings = kcoder_config::Settings::default();
        settings.evolution.enabled = enabled;
        EvolutionService::new(EvolutionServiceInputs {
            settings: &settings,
            user_enabled: None,
            models: Vec::new(),
            skills: None,
            workspace: None,
            data_root: PathBuf::from(root),
            hooks: std::sync::Arc::new(kcoder_tools::evolution_service::DefaultEngineHooks),
        })
    }

    #[test]
    fn arguments_parse_to_service_actions() {
        assert_eq!(parse_evolution("").unwrap(), EvolutionAction::Status);
        assert_eq!(parse_evolution("status").unwrap(), EvolutionAction::Status);
        assert_eq!(
            parse_evolution("list skill").unwrap(),
            EvolutionAction::List(TargetType::Skill)
        );
        assert_eq!(
            parse_evolution("approve prop-1").unwrap(),
            EvolutionAction::Decide(ProposalDecision::Accept, "prop-1".into())
        );
        assert_eq!(
            parse_evolution("rollback prop-1").unwrap(),
            EvolutionAction::Decide(ProposalDecision::Rollback, "prop-1".into())
        );
        assert!(
            parse_evolution("list tools")
                .unwrap_err()
                .contains("tool_usage")
        );
        assert_eq!(
            parse_evolution("distill skill:bundled:git").unwrap(),
            EvolutionAction::Distill(TargetKey::parse("skill:bundled:git").unwrap())
        );
        assert!(parse_evolution("distill nonsense").is_err());
        assert!(
            distill_text(
                &TargetKey::parse("skill:bundled:git").unwrap(),
                DistillRequestOutcome::ModelUnavailable("no key".into())
            )
            .contains("no key")
        );
        assert!(parse_evolution("approve").is_err());
        assert!(parse_evolution("approve a b").is_err());
        assert_eq!(parse_rate("up").unwrap(), (true, None));
        assert_eq!(
            parse_rate("down  missed the tests ").unwrap(),
            (false, Some("missed the tests".into()))
        );
        assert!(parse_rate("sideways").is_err());
        assert!(parse_rate(&format!("up {}", "x".repeat(501))).is_err());
    }

    #[test]
    fn status_list_and_decisions_use_the_shared_service() {
        let temp = tempfile::tempdir().unwrap();
        let service = service_at(temp.path(), true);
        let status = run_evolution(&service, EvolutionAction::Status);
        assert!(status.contains("State: on"), "{status}");
        for target_type in TargetType::ALL {
            let coming_soon = status.lines().any(|line| {
                line.starts_with(&format!("- `{target_type}`")) && line.ends_with("(coming soon)")
            });
            assert_eq!(
                coming_soon,
                !kcoder_evolution::IMPLEMENTED_TARGET_TYPES.contains(&target_type),
                "{status}"
            );
        }
        assert_eq!(
            run_evolution(&service, EvolutionAction::List(TargetType::Skill)),
            "No `skill` targets are known yet."
        );

        let store = kcoder_evolution::EvolutionStore::open(temp.path()).unwrap();
        let key = kcoder_types::evolution::TargetKey::parse("skill:bundled:docx").unwrap();
        let proposal = store
            .create_proposal(
                kcoder_evolution::ProposalDraft {
                    target_key: key,
                    base_revision: String::new(),
                    location: kcoder_types::evolution::ProposalLocation::Overlay,
                    changes: kcoder_types::evolution::ProposalChanges {
                        lessons_add: vec!["Keep headings".into()],
                        ..Default::default()
                    },
                    pattern_ids: Vec::new(),
                    evidence_ids: Vec::new(),
                    actor: kcoder_types::evolution::ProposalActor::Auto,
                },
                1,
            )
            .unwrap()
            .proposal;
        let list = run_evolution(&service, EvolutionAction::List(TargetType::Skill));
        assert!(
            list.contains("`skill:bundled:docx`") && list.contains("1 pending"),
            "{list}"
        );
        let prefix = proposal.proposal_id[..10].to_string();
        let approved = run_evolution(
            &service,
            EvolutionAction::Decide(ProposalDecision::Accept, prefix.clone()),
        );
        assert!(approved.starts_with("Approved proposal"), "{approved}");
        let again = run_evolution(
            &service,
            EvolutionAction::Decide(ProposalDecision::Accept, prefix.clone()),
        );
        assert!(again.contains("evolution_invalid_transition"), "{again}");
        let rolled = run_evolution(
            &service,
            EvolutionAction::Decide(ProposalDecision::Rollback, prefix),
        );
        assert!(rolled.starts_with("Rolled back proposal"), "{rolled}");
    }

    #[test]
    fn ratings_report_disabled_and_missing_usages() {
        let temp = tempfile::tempdir().unwrap();
        let request = RatingRequest {
            thread_id: "thread".into(),
            turn_id: "turn-1".into(),
            tool_call_ids: Vec::new(),
            target_key: None,
            up: true,
            reason: None,
        };
        assert!(run_rate(&service_at(temp.path(), false), &request).contains("is off"));
        assert!(run_rate(&service_at(temp.path(), true), &request).starts_with("Nothing to rate"));
    }
}
