use super::{TestAppServer, Value, json, rpc};
#[path = "profile_diagnostics.rs"]
mod diagnostics;

#[test]
fn migration_rpc_imported_template_is_selectable_by_an_actual_thread_without_changing_defaults() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let target = root.path().join("target");
    let source = root.path().join("codex");
    for path in [&workspace, &target, &source] {
        std::fs::create_dir(path).unwrap();
    }
    std::fs::write(
        target.join("settings.json"),
        r#"{"credential_store":"file"}"#,
    )
    .unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    std::fs::write(source.join("config.toml"),"model_provider='Office'\n[model_providers.Office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\nenv_key='MIGRATION_TEMPLATE_RPC_KEY'\n").unwrap();
    std::fs::write(
        source.join("review.config.toml"),
        "model='review-model'\nmodel_reasoning_effort='high'\n",
    )
    .unwrap();
    let mut builder = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&target)
        .without_scenario();
    for (name, path) in [
        ("HOME", root.path()),
        ("USERPROFILE", root.path()),
        ("CODEX_HOME", source.as_path()),
    ] {
        builder
            .extra_env
            .push((name.into(), path.as_os_str().into()));
    }
    builder.extra_env.push((
        "MIGRATION_TEMPLATE_RPC_KEY".into(),
        "SYNTHETIC_TEMPLATE_RPC_PRIVATE_KEY".into(),
    ));
    builder
        .extra_env
        .push(("RUST_LOG".into(), "kcoder::migration=debug".into()));
    let mut server = diagnostics::ObservedServer::new(builder.spawn());
    let initialized = rpc(
        &mut server,
        1,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"template-migration-fixture","version":"test"}}),
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationTemplatesV1"],
        true
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationTemplateReuseV1"],
        true
    );
    let discovered = rpc(
        &mut server,
        2,
        "migration/discover",
        json!({"sources":["codex"]}),
    );
    let selected = discovered["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["displayName"] == "Codex · review.config.toml")
        .unwrap();
    let scanned = rpc(
        &mut server,
        3,
        "migration/batch/scan",
        json!({"sourceIds":[selected["sourceId"]]}),
    );
    let job = scanned["job"]["jobId"].clone();
    let legacy = rpc(&mut server, 4, "migration/items", json!({"jobId":job}));
    assert!(legacy.get("templates").is_none());
    let items = rpc(
        &mut server,
        5,
        "migration/items",
        json!({"jobId":job,"includeTemplates":true}),
    );
    let template = &items["templates"][0];
    let provider = &items["providers"][0];
    assert_eq!(template["providerItemId"], provider["itemId"]);
    assert_eq!(template["providerName"], "Office");
    assert_eq!(template["providerPageIndex"], 0);
    let planned = rpc(
        &mut server,
        6,
        "migration/batch/plan",
        json!({"jobId":job,"expectedSequence":scanned["job"]["sequence"],
            "choices":[{"kind":"template","itemId":template["itemId"],"targetName":"imported-review","providerItemId":provider["itemId"]},
                {"kind":"provider","itemId":provider["itemId"],"targetName":"ImportedOffice","contextWindowTokens":128000,"outputHeadroomTokens":8192,"maxOutputTokens":8192}],
            "credentials":[{"itemId":provider["itemId"],"source":"environment","consentApiKey":true}],
        }),
    );
    let applied = rpc(
        &mut server,
        7,
        "migration/batch/apply",
        json!({"jobId":job,"expectedSequence":planned["job"]["sequence"],"planId":planned["batch"]["planId"],"requestId":"apply-template"}),
    );
    assert_eq!(applied["job"]["committedItems"], 2);
    let legacy_preview = rpc(
        &mut server,
        20,
        "migration/batch/item/plan",
        json!({"jobId":job,"itemId":template["itemId"]}),
    );
    assert!(legacy_preview.get("template").is_none());
    let preview = rpc(
        &mut server,
        21,
        "migration/batch/item/plan",
        json!({"jobId":job,"itemId":template["itemId"],"includeTemplate":true}),
    );
    assert_eq!(
        preview["template"],
        json!({"id":"imported-review","providerName":"ImportedOffice","model":"review-model","reasoningEffort":"high"})
    );
    assert!(!preview.to_string().contains("profile_identity"));
    let before = std::fs::read(target.join("templates/imported-review.jsonc")).unwrap();
    let scanned_again = rpc(
        &mut server,
        22,
        "migration/batch/scan",
        json!({"sourceIds":[selected["sourceId"]]}),
    );
    let new_job = scanned_again["job"]["jobId"].clone();
    let new_items = rpc(
        &mut server,
        23,
        "migration/items",
        json!({"jobId":new_job,"includeTemplates":true}),
    );
    let new_template = &new_items["templates"][0];
    let new_provider = &new_items["providers"][0];
    let reused_plan = rpc(
        &mut server,
        24,
        "migration/batch/plan",
        json!({"jobId":new_job,"expectedSequence":scanned_again["job"]["sequence"],"reuseExisting":true,
        "choices":[{"kind":"template","itemId":new_template["itemId"],"targetName":"imported-review","providerItemId":new_provider["itemId"]},
            {"kind":"provider","itemId":new_provider["itemId"],"targetName":"ImportedOffice","contextWindowTokens":128000,"outputHeadroomTokens":8192,"maxOutputTokens":8192}]}),
    );
    let reused_preview = rpc(
        &mut server,
        25,
        "migration/batch/item/plan",
        json!({"jobId":new_job,"itemId":new_template["itemId"],"includeTemplate":true}),
    );
    assert_eq!(reused_preview["item"]["reused"], true);
    assert_eq!(reused_preview["template"], preview["template"]);
    let resolved = rpc(&mut server, 28, "migration/items", json!({"jobId":new_job}));
    assert_eq!(resolved["providers"][0]["contextWindowTokens"], 128000);
    assert!(
        !resolved["items"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|item| item["issues"].as_array().unwrap())
            .any(|issue| issue["code"] == "missing_model_limits")
    );
    let reused = rpc(
        &mut server,
        26,
        "migration/batch/apply",
        json!({"jobId":new_job,"expectedSequence":reused_plan["job"]["sequence"],"planId":reused_plan["batch"]["planId"],"requestId":"reuse-template"}),
    );
    assert_eq!(reused["batch"]["reusedItems"], 2);
    assert_eq!(reused["job"]["committedItems"], 0);
    let undo_reuse = rpc(
        &mut server,
        27,
        "migration/batch/rollback",
        json!({"jobId":new_job,"expectedSequence":reused["job"]["sequence"],"planId":reused_plan["batch"]["planId"],"requestId":"undo-reuse-template"}),
    );
    assert_eq!(undo_reuse["job"]["status"], "rolled_back");
    assert_eq!(
        std::fs::read(target.join("templates/imported-review.jsonc")).unwrap(),
        before
    );
    assert!(
        !applied
            .to_string()
            .contains("SYNTHETIC_TEMPLATE_RPC_PRIVATE_KEY")
    );
    let native = rpc(&mut server, 8, "settings/templates/list", json!({}));
    assert!(native.get("defaultId").is_none());
    assert_eq!(native["templates"][0]["id"], "imported-review");
    let started = rpc(
        &mut server,
        9,
        "thread/start",
        json!({"settingsTemplate":"imported-review"}),
    );
    assert_eq!(
        started["thread"]["settingsTemplate"]["id"],
        "imported-review"
    );
    assert!(
        started["thread"]["model"]
            .as_str()
            .unwrap()
            .contains("review-model"),
        "{started}"
    );
    let persisted = kcoder_config::read_settings_file(&target.join("settings.json")).unwrap();
    assert_ne!(persisted["active_provider"], "ImportedOffice");
    assert_eq!(
        std::fs::read_to_string(source.join("review.config.toml")).unwrap(),
        "model='review-model'\nmodel_reasoning_effort='high'\n"
    );
    server.shutdown();
}

#[test]
fn migration_rpc_exposes_distinct_profile_views_with_base_inheritance_and_expiring_source_facts() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let target = root.path().join("target-profile");
    let codex = root.path().join("codex-source");
    for directory in [&workspace, &target, &codex] {
        std::fs::create_dir(directory).unwrap();
    }
    std::fs::write(target.join("settings.json"), "{}").unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let original = "profile='review'\nmodel='base-model'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\nenv_key='MIGRATION_PROFILE_RPC_FIXTURE_KEY'\n[profiles.review]\nmodel='legacy-model'\n";
    std::fs::write(codex.join("config.toml"), original).unwrap();
    std::fs::write(codex.join("review.config.toml"), "model='current-model'").unwrap();
    std::fs::write(
        codex.join("auth.json"),
        "invalid; must never be parsed or imported",
    )
    .unwrap();
    let mut builder = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&target)
        .without_scenario();
    for (name, path) in [
        ("HOME", root.path()),
        ("USERPROFILE", root.path()),
        ("CODEX_HOME", codex.as_path()),
    ] {
        builder
            .extra_env
            .push((name.into(), path.as_os_str().into()));
    }
    let mut server = builder.spawn();
    rpc(
        &mut server,
        1,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"profile-migration-fixture","version":"test"}}),
    );
    let discovered = rpc(
        &mut server,
        2,
        "migration/discover",
        json!({"sources":["codex"]}),
    );
    assert!(
        discovered["problems"].as_array().unwrap().is_empty(),
        "{discovered}"
    );
    let sources = discovered["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 3);
    let source = |name: &str| -> Value {
        sources
            .iter()
            .find(|source| source["displayName"] == name)
            .unwrap()
            .clone()
    };
    let current = source("Codex · review.config.toml");
    let legacy = source("Codex · profiles.review");
    assert_ne!(current["sourceId"], legacy["sourceId"]);
    assert_eq!(current["formatRevision"], "codex-profile-file/v1");
    assert_eq!(legacy["formatRevision"], "codex-profile-table/v1");
    for (offset, entry, model) in [
        (0, current.clone(), "current-model"),
        (10, legacy, "legacy-model"),
        (20, source("Codex"), "base-model"),
    ] {
        let scanned = rpc(
            &mut server,
            3 + offset,
            "migration/scan",
            json!({"sourceId":entry["sourceId"]}),
        );
        let items = rpc(
            &mut server,
            4 + offset,
            "migration/items",
            json!({"jobId":scanned["job"]["jobId"]}),
        );
        let providers = items["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0]["model"], model);
        assert_eq!(providers[0]["endpoint"], "https://example.invalid/v1");
        assert!(!items.to_string().contains(root.path().to_str().unwrap()));
        if offset != 20 {
            assert!(items["items"].as_array().unwrap().iter().any(|item| {
                item["issues"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|issue| issue["field"] == "session_template")
            }));
        }
    }
    assert_eq!(
        std::fs::read_to_string(codex.join("config.toml")).unwrap(),
        original
    );
    assert_eq!(
        std::fs::read_to_string(target.join("settings.json")).unwrap(),
        "{}"
    );
    std::fs::write(codex.join("config.toml"), format!("# changed\n{original}")).unwrap();
    server.send(json!({"jsonrpc":"2.0","id":40,"method":"migration/scan","params":{"sourceId":current["sourceId"]}}));
    let rejected = server.response(40);
    assert_eq!(rejected["error"]["code"], -32047, "{rejected}");
    assert_eq!(rejected["error"]["message"], "migration_source_changed");
    server.shutdown();
}
