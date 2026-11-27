use super::*;
use serde_json::json;

#[test]
fn defaults_are_disabled_propose_and_match_the_embedded_document() {
    let typed = EvolutionSettings::default();
    assert!(!typed.enabled);
    assert_eq!(typed.mode, EvolutionMode::Propose);
    assert_eq!(typed.distill_min_usages, 20);
    assert_eq!(typed.candidate_traffic, 0.5);
    assert_eq!(typed.promote_threshold, 0.8);
    assert_eq!(typed.rollback_threshold, 0.3);
    assert_eq!(typed.evidence_ttl_days, 90);
    assert!(typed.model.is_none() && typed.stage_models == EvolutionStageModels::default());
    assert_eq!(typed.usage_limit.monthly_max_tokens, None);
    assert_eq!(
        typed.targets.project_knowledge.mode,
        Some(EvolutionMode::Propose)
    );
    assert_eq!(typed.targets.skill.allow_file_edits, Some(false));
    typed.validate().unwrap();

    let from_empty: EvolutionSettings = serde_json::from_value(json!({})).unwrap();
    assert_eq!(from_empty, typed);
    let embedded = crate::Settings::default().evolution;
    assert_eq!(embedded, typed);
    let schema = crate::schema::settings_schema();
    assert_eq!(
        schema["$defs"]["evolution"]["properties"]["mode"]["default"],
        "propose"
    );
    assert_eq!(
        schema["$defs"]["evolution"]["properties"]["enabled"]["default"],
        false
    );
}

#[test]
fn partial_target_objects_keep_their_type_defaults() {
    let settings: EvolutionSettings = serde_json::from_value(json!({
        "targets": {"tool_usage": {"scope": "selected"}, "skill": {"mode": "propose"}}
    }))
    .unwrap();
    assert!(!settings.targets.type_enabled(TargetType::ToolUsage));
    assert!(settings.targets.type_enabled(TargetType::Skill));
    assert!(!settings.targets.type_enabled(TargetType::WorkflowTemplate));
}

#[test]
fn effective_mode_narrows_and_caps_project_knowledge() {
    let mut settings = EvolutionSettings {
        mode: EvolutionMode::Auto,
        ..Default::default()
    };
    assert_eq!(
        settings.effective_mode(TargetType::Skill),
        EvolutionMode::Auto
    );
    assert_eq!(
        settings.effective_mode(TargetType::ProjectKnowledge),
        EvolutionMode::Propose
    );
    settings.targets.skill.mode = Some(EvolutionMode::Observe);
    assert_eq!(
        settings.effective_mode(TargetType::Skill),
        EvolutionMode::Observe
    );
    settings.mode = EvolutionMode::Observe;
    settings.targets.preference.mode = Some(EvolutionMode::Auto);
    assert_eq!(
        settings.effective_mode(TargetType::Preference),
        EvolutionMode::Observe,
        "a per-type mode never widens the global mode"
    );
}

#[test]
fn target_enabled_honours_master_type_scope_and_items() {
    let key = TargetKey::parse("skill:project:deploy-check").unwrap();
    let other = TargetKey::parse("skill:bundled:docx").unwrap();
    let mut settings = EvolutionSettings::default();
    assert!(!settings.target_enabled(&key), "master switch is off");
    settings.enabled = true;
    assert!(settings.target_enabled(&key));
    settings
        .targets
        .skill
        .items
        .insert(key.to_string(), EvolutionItemSettings { enabled: false });
    assert!(!settings.target_enabled(&key));
    assert!(settings.target_enabled(&other));
    settings.targets.skill.scope = EvolutionTargetScope::Selected;
    assert!(!settings.target_enabled(&other));
    settings
        .targets
        .skill
        .items
        .insert(other.to_string(), EvolutionItemSettings { enabled: true });
    assert!(settings.target_enabled(&other));
    settings.targets.skill.enabled = Some(false);
    assert!(!settings.target_enabled(&other));
    let tool = TargetKey::parse("tool_usage:mcp:github.create_issue").unwrap();
    assert!(
        !settings.target_enabled(&tool),
        "tool usage is off by default"
    );
}

#[test]
fn stage_models_fall_back_to_the_evolution_model_only() {
    let mut settings = EvolutionSettings::default();
    assert!(settings.stage_model(EvolutionStage::Distill).is_none());
    settings.model = Some(EvolutionModelRef {
        provider: "KunLun".into(),
        model: "Main-Model".into(),
    });
    settings.stage_models.eval = Some(EvolutionModelRef {
        provider: "Other".into(),
        model: "Judge".into(),
    });
    assert_eq!(
        settings.stage_model(EvolutionStage::Distill).unwrap().model,
        "Main-Model"
    );
    assert_eq!(
        settings.stage_model(EvolutionStage::Eval).unwrap().provider,
        "Other"
    );
}

#[test]
fn validation_rejects_out_of_range_values_and_foreign_items() {
    let invalid = [
        json!({"candidate_traffic": 1.5}),
        json!({"promote_threshold": -0.1}),
        json!({"promote_threshold": 0.3, "rollback_threshold": 0.3}),
        json!({"distill_min_usages": 0}),
        json!({"evidence_ttl_days": 0}),
        json!({"usage_limit": {"monthly_max_tokens": 0}}),
        json!({"model": {"provider": " KunLun", "model": "m"}}),
        json!({"targets": {"skill": {"items": {"preference:user:global": {"enabled": true}}}}}),
        json!({"targets": {"skill": {"items": {"not-a-key": {"enabled": true}}}}}),
        json!({"targets": {"preference": {"allow_file_edits": true}}}),
    ];
    for value in invalid {
        let settings: EvolutionSettings = serde_json::from_value(value.clone()).unwrap();
        assert!(settings.validate().is_err(), "{value} must be rejected");
    }
    for value in [
        json!({"targets": {"agent": {"enabled": true}}}),
        json!({"mode": "always"}),
        json!({"surprise": true}),
    ] {
        assert!(
            serde_json::from_value::<EvolutionSettings>(value.clone()).is_err(),
            "{value} must not deserialize"
        );
    }
}

#[test]
fn schema_accepts_the_plan_shape_and_rejects_unknown_target_types() {
    let accepted = json!({"evolution": {
        "enabled": true,
        "mode": "propose",
        "targets": {"skill": {"items": {"skill:project:deploy-check": {"enabled": false}}, "allow_file_edits": true}},
        "model": {"provider": "KunLun", "model": "Model-X"},
        "stage_models": {"eval": null},
        "usage_limit": {"monthly_max_tokens": 100000}
    }});
    crate::schema::validate_settings_schema(&accepted).unwrap();
    for rejected in [
        json!({"evolution": {"targets": {"agent": {}}}}),
        json!({"evolution": {"targets": {"preference": {"allow_file_edits": true}}}}),
        json!({"evolution": {"candidate_traffic": 2}}),
        json!({"evolution": {"model": {"provider": "x"}}}),
    ] {
        assert!(
            crate::schema::validate_settings_schema(&rejected).is_err(),
            "{rejected}"
        );
    }
}

#[test]
fn project_layer_may_only_disable_evolution() {
    let mut layer = json!({"evolution": {"enabled": false, "mode": "auto", "model": null}});
    let mut ignored = restrict_project_evolution_layer(&mut layer);
    ignored.sort();
    assert_eq!(ignored, ["evolution.mode", "evolution.model"]);
    assert_eq!(layer, json!({"evolution": {"enabled": false}}));

    let mut enabling = json!({"evolution": {"enabled": true}, "permission_mode": "default"});
    assert_eq!(
        restrict_project_evolution_layer(&mut enabling),
        ["evolution.enabled"]
    );
    assert_eq!(enabling, json!({"permission_mode": "default"}));

    let mut untouched = json!({"permission_mode": "default"});
    assert!(restrict_project_evolution_layer(&mut untouched).is_empty());
}

fn write(path: &std::path::Path, value: serde_json::Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

#[test]
fn loader_ignores_project_evolution_keys_with_warnings() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    write(
        &config.join("settings.json"),
        json!({"evolution": {"enabled": true, "mode": "propose", "candidate_traffic": 0.2}}),
    );
    let loader = crate::SettingsLoader::new(&project).with_config_dir(&config);
    let paths = loader.paths().unwrap();
    write(
        &paths.project_settings,
        json!({"evolution": {"mode": "auto", "candidate_traffic": 0.9, "unknown": 1}}),
    );
    let loaded = loader.load_read_only_configuration().unwrap();
    let evolution = &loaded.settings.evolution;
    assert!(
        evolution.enabled,
        "the project cannot change the switch here"
    );
    assert_eq!(evolution.mode, EvolutionMode::Propose);
    assert_eq!(evolution.candidate_traffic, 0.2);
    let mut ignored: Vec<_> = loaded
        .settings_warnings
        .iter()
        .map(|warning| warning.setting.as_str())
        .collect();
    ignored.sort();
    assert_eq!(
        ignored,
        [
            "evolution.candidate_traffic",
            "evolution.mode",
            "evolution.unknown"
        ]
    );
    assert!(
        loaded
            .settings_warnings
            .iter()
            .all(|warning| warning.scope == crate::ConfigScope::Project)
    );

    write(
        &paths.local_settings,
        json!({"evolution": {"enabled": false}}),
    );
    let loaded = loader.load_read_only_configuration().unwrap();
    assert!(
        !loaded.settings.evolution.enabled,
        "a local layer may disable"
    );
    assert_eq!(loaded.settings.evolution.mode, EvolutionMode::Propose);
}

#[test]
fn project_layer_cannot_enable_evolution() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let loader = crate::SettingsLoader::new(&project).with_config_dir(&config);
    let paths = loader.paths().unwrap();
    write(
        &paths.project_settings,
        json!({"evolution": {"enabled": true}}),
    );
    let loaded = loader.load_read_only_configuration().unwrap();
    assert!(!loaded.settings.evolution.enabled);
    assert_eq!(loaded.settings_warnings.len(), 1);
    assert_eq!(loaded.settings_warnings[0].setting, "evolution.enabled");
}

#[test]
fn invalid_user_evolution_settings_fail_loading() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    write(
        &config.join("settings.json"),
        json!({"evolution": {"promote_threshold": 0.2, "rollback_threshold": 0.5}}),
    );
    let error = crate::SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load_read_only_configuration()
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("rollback_threshold"),
        "{error:#}"
    );
}

#[test]
fn training_mode_disables_evolution() {
    let mut settings = crate::Settings::default();
    settings.evolution.enabled = true;
    settings.enable_training_mode();
    assert!(!settings.evolution.enabled);
}

/// Must stay identical to `DEFAULT_SETTINGS_WIRE` in
/// `kcoder_app_protocol/src/evolution_tests.rs`, the RPC mirror of this type.
#[test]
fn typed_default_serializes_to_the_wire_literal() {
    let wire = json!({
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
    });
    assert_eq!(
        serde_json::to_value(EvolutionSettings::default()).unwrap(),
        wire
    );
    assert_eq!(
        serde_json::from_value::<EvolutionSettings>(wire).unwrap(),
        EvolutionSettings::default()
    );
}
