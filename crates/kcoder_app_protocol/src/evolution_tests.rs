use super::*;
use serde_json::json;

#[test]
fn method_and_capability_names_match_the_shared_contract() {
    assert_eq!(CAPABILITY_SELF_EVOLUTION_V1, "selfEvolutionV1");
    assert_eq!(method::STATUS, "evolution/status");
    assert_eq!(method::TARGETS_LIST, "evolution/targets/list");
    assert_eq!(method::PROPOSAL_DECIDE, "evolution/proposal/decide");
    assert_eq!(method::CHANGED, "evolution/changed");
    assert_eq!(method::RATINGS_LIST, "evolution/ratings/list");
    assert_eq!(
        serde_json::to_value(EvolutionErrorCode::EvolutionRevisionConflict).unwrap(),
        "evolution_revision_conflict"
    );
}

#[test]
fn params_reject_unknown_fields_and_bad_values() {
    let list: EvolutionTargetsListParams =
        serde_json::from_value(json!({"type": "project_knowledge", "limit": 200})).unwrap();
    list.validate().unwrap();
    let over: EvolutionTargetsListParams =
        serde_json::from_value(json!({"type": "skill", "limit": 201})).unwrap();
    assert!(over.validate().is_err());
    assert!(
        serde_json::from_value::<EvolutionTargetsListParams>(json!({"type": "agent"})).is_err()
    );
    assert!(
        serde_json::from_value::<EvolutionStatusParams>(json!({"accountId": "other"})).is_err()
    );
    let decide: EvolutionProposalDecideParams = serde_json::from_value(json!({
        "targetKey": "skill:bundled:docx",
        "proposalId": "prop-1",
        "decision": "pin_stable",
        "expectedRevision": "3"
    }))
    .unwrap();
    decide.validate().unwrap();
    assert!(
        serde_json::from_value::<EvolutionProposalDecideParams>(json!({
            "targetKey": "bad", "proposalId": "p", "decision": "accept", "expectedRevision": "1"
        }))
        .is_err()
    );
    let rate: EvolutionRateParams = serde_json::from_value(json!({
        "threadId": "t", "turnId": "u", "rating": "down", "reason": "字".repeat(501)
    }))
    .unwrap();
    assert!(rate.validate().is_err());
    let clear: EvolutionDataClearParams =
        serde_json::from_value(json!({"scope": "all", "confirm": false})).unwrap();
    assert!(clear.validate().is_err());
    let update: EvolutionPreferenceUpdateParams = serde_json::from_value(
        json!({"key": "pref.global.length", "value": null, "expectedRevision": "r"}),
    )
    .unwrap();
    assert!(update.value.is_none());
}

#[test]
fn results_serialize_with_contract_field_names() {
    let read = EvolutionTargetReadResult {
        summary: serde_json::from_value(json!({
            "targetKey": "skill:bundled:docx", "type": "skill", "source": "bundled",
            "name": "docx", "enabled": true, "evolutionMode": "overlay",
            "stable": {"revision": "r@0", "mean": 0.5, "lower": 0.1, "upper": 0.9, "observations": 0},
            "pendingProposals": 0, "needsRevalidation": false, "pinned": false
        }))
        .unwrap(),
        overlay: EvolutionOverlayView {
            stable: EvolutionOverlayContent::default(),
            candidate: None,
            overlay_revision: "0".into(),
        },
        patterns: vec![],
        proposals: vec![],
    };
    let value = serde_json::to_value(&read).unwrap();
    assert_eq!(value["overlay"]["overlayRevision"], "0");
    assert_eq!(value["summary"]["type"], "skill");
    let changed = EvolutionChangedNotification {
        target_key: None,
        reason: EvolutionChangedReason::RolledBack,
    };
    assert_eq!(
        serde_json::to_value(changed).unwrap(),
        json!({"reason": "rolled_back"})
    );
}

/// Must stay identical to the literal in
/// `kcoder_config::settings::evolution::tests::typed_default_serializes_to_the_wire_literal`.
pub(crate) const DEFAULT_SETTINGS_WIRE: &str = r#"{
  "enabled": false,
  "mode": "propose",
  "targets": {
    "skill": {"enabled": true, "scope": "all", "items": {}, "allow_file_edits": false},
    "preference": {"enabled": true, "scope": "all", "items": {}},
    "project_knowledge": {"enabled": true, "mode": "propose", "scope": "all", "items": {}},
    "tool_usage": {"enabled": false, "scope": "all", "items": {}},
    "workflow_template": {"enabled": false, "scope": "all", "items": {}}
  },
  "signals": {"artifact_edits": true, "procedure_results": true, "chat_corrections": true, "rating_ui": true},
  "distill_min_usages": 20,
  "candidate_traffic": 0.5,
  "promote_threshold": 0.8,
  "rollback_threshold": 0.3,
  "model": null,
  "stage_models": {"classifier": null, "distill": null, "eval": null},
  "evidence_ttl_days": 90,
  "share_aggregates": false,
  "usage_limit": {"monthly_max_tokens": null},
  "eval": {"win_rate": 0.6, "max_diversity_drop": 0.1}
}"#;

#[test]
fn settings_wire_shape_round_trips_the_default_document() {
    let value: serde_json::Value = serde_json::from_str(DEFAULT_SETTINGS_WIRE).unwrap();
    let settings: EvolutionSettings = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&settings).unwrap(), value);
    let mut unknown = value;
    unknown["targets"]["agent"] = json!({});
    assert!(serde_json::from_value::<EvolutionSettings>(unknown).is_err());
    let save = EvolutionSettingsSaveParams {
        settings,
        expected_revision: String::new(),
    };
    assert!(save.validate().is_err());
    assert_eq!(method::SETTINGS_SAVE, "settings/evolution/save");
}

#[test]
fn rating_requests_name_tool_calls_and_the_list_reports_standing_ratings() {
    let rate: EvolutionRateParams = serde_json::from_value(json!({
        "threadId": "t", "subagentId": "agent-1", "turnId": "assistant-1",
        "toolCallIds": ["toolu_1"], "rating": "up"
    }))
    .unwrap();
    rate.validate().unwrap();
    assert_eq!(rate.tool_call_ids, ["toolu_1"]);
    // Older clients omit the field; it is not serialized when empty.
    let legacy: EvolutionRateParams =
        serde_json::from_value(json!({"threadId": "t", "turnId": "turn-1", "rating": "down"}))
            .unwrap();
    assert!(legacy.tool_call_ids.is_empty());
    assert!(
        !serde_json::to_value(&legacy)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("toolCallIds")
    );
    let too_many: EvolutionRateParams = serde_json::from_value(json!({
        "threadId": "t", "turnId": "u", "rating": "up",
        "toolCallIds": (0..65).map(|index| format!("call-{index}")).collect::<Vec<_>>()
    }))
    .unwrap();
    assert!(too_many.validate().is_err());
    let blank: EvolutionRateParams = serde_json::from_value(json!({
        "threadId": "t", "turnId": "u", "rating": "up", "toolCallIds": [" "]
    }))
    .unwrap();
    assert!(blank.validate().is_err());

    let list: EvolutionRatingsListParams =
        serde_json::from_value(json!({"threadId": "t", "subagentId": "agent-1"})).unwrap();
    list.validate().unwrap();
    assert!(
        serde_json::from_value::<EvolutionRatingsListParams>(
            json!({"threadId": "t", "turnId": "u"})
        )
        .is_err()
    );
    let result = EvolutionRatingsListResult {
        items: vec![EvolutionRatableTurn {
            turn_id: "turn-3".into(),
            tool_call_ids: vec!["toolu_1".into()],
            target_keys: vec![EvolutionTargetKey::parse("skill:bundled:docx").unwrap()],
            rating: Some(EvolutionRating::Down),
        }],
        truncated: false,
    };
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({"items": [{"turnId": "turn-3", "toolCallIds": ["toolu_1"],
            "targetKeys": ["skill:bundled:docx"], "rating": "down"}], "truncated": false})
    );
}
