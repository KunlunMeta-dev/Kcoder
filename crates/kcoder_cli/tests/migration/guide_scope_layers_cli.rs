//! Real CLI processes select Native layer views and frozen project destinations without model calls.
use super::*;
use std::path::Path;

fn trust(f: &Fixture, project: &Path) {
    std::fs::write(
        f.profile.join("trusted-folders.json"),
        json!({"trusted":[project],"never":[]}).to_string(),
    )
    .unwrap();
}

fn operate(f: &Fixture, id: &str, action: &str, confirmation: &str) -> Value {
    let mut dialog = Dialog::start(f, "", Some(id));
    let frame = dialog.prompt("menu");
    dialog.answer(&frame, action);
    let frame = dialog.prompt("request_id");
    dialog.answer(&frame, "");
    let frame = dialog.prompt("confirm_operation");
    dialog.answer(&frame, confirmation);
    let frame = dialog.prompt("menu");
    let result = dialog.state.clone();
    dialog.answer(&frame, "quit");
    dialog.finish();
    result
}

#[test]
fn guided_project_settings_scope_publishes_reopens_and_undoes_only_its_original_workspace() {
    project_settings_guide(false);
}

#[test]
fn guided_project_mcp_catalog_selects_a_later_page_without_copying_inherited_private_values() {
    project_settings_guide(true);
}

fn project_settings_guide(inherit_mcp: bool) {
    let f = Fixture::new("claude-code");
    kcoder_config::PrivateDirectory::open_or_create(&f.profile).unwrap();
    let workspace = f.root.path().join("workspace");
    trust(&f, &workspace);
    let inherited = if inherit_mcp {
        (0..13).map(|index| json!({"name":format!("user-{index:02}"),"command":"NEVER_RUN_INHERITED_GUIDE_MCP","env":{"TOKEN":"SYNTHETIC_INHERITED_GUIDE_PRIVATE_VALUE"}})).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    std::fs::write(
        f.profile.join("settings.json"),
        json!({"credential_store":"file","mcp_servers":inherited}).to_string(),
    )
    .unwrap();
    let user = std::fs::read(f.profile.join("settings.json")).unwrap();
    let mut dialog = Dialog::start(&f, "claude-code", None);
    let frame = dialog.prompt("target_settings_scope");
    dialog.answer(&frame, "current_workspace");
    let frame = dialog.prompt("menu");
    assert_eq!(
        dialog.state["targetSettingsScope"]["kind"],
        "current_workspace"
    );
    let id = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
    dialog.answer(&frame, "select");
    let mut selected = false;
    let mut inherited_selected = false;
    loop {
        let frame = dialog.next();
        if frame["type"] != "prompt" {
            continue;
        }
        let code = frame["code"].as_str().unwrap();
        let answer = match code {
            "selection" => {
                if selected {
                    "preview".into()
                } else {
                    let row = frame["choices"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|row| row["item"]["category"] == "mcp")
                        .unwrap();
                    selected = true;
                    format!("toggle {}", row["number"])
                }
            }
            "target_name" => "ProjectDocs".into(),
            "mcp_cwd" => String::new(),
            "enable_mcp" | "reuse" => "no".into(),
            "project_mcp_inheritance" => {
                assert!(inherit_mcp);
                assert!(frame["choices"]["items"].as_array().unwrap().len() <= 10);
                assert!(
                    !frame
                        .to_string()
                        .contains("SYNTHETIC_INHERITED_GUIDE_PRIVATE_VALUE")
                );
                if frame["choices"]["page"] == 0 {
                    "next".into()
                } else if !inherited_selected {
                    inherited_selected = true;
                    "toggle 2".into()
                } else {
                    "confirm".into()
                }
            }
            "menu" => {
                dialog.answer(&frame, "quit");
                dialog.finish();
                break;
            }
            _ => panic!("unexpected prompt {code}"),
        };
        dialog.answer(&frame, &answer);
    }
    let published = operate(&f, &id, "apply", "IMPORT");
    assert!(
        matches!(
            published["job"]["status"].as_str(),
            Some("completed" | "completed_with_issues")
        ),
        "{published}"
    );
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        user
    );
    let project: Value =
        serde_json::from_slice(&std::fs::read(workspace.join(".kcoder/settings.json")).unwrap())
            .unwrap();
    assert_eq!(project["mcp_servers"][0]["name"], "ProjectDocs");
    if inherit_mcp {
        assert_eq!(project["mcp_inherited_servers"], json!(["user-11"]));
    }
    assert!(
        !project
            .to_string()
            .contains("SYNTHETIC_INHERITED_GUIDE_PRIVATE_VALUE")
    );
    assert_eq!(
        project["mcp_servers"][0]["policy"]["workspace"],
        workspace.to_str().unwrap()
    );
    let saved = kcoder_migration::store::MigrationStore::open_existing(&f.profile)
        .unwrap()
        .read(&id)
        .unwrap();
    assert!(saved.batch.as_ref().unwrap().received.is_none());
    assert_eq!(saved.project_target().unwrap().root(), workspace.as_path());
    std::fs::rename(&f.home, f.root.path().join("withheld-source")).unwrap();
    let undone = operate(&f, &id, "undo", "UNDO");
    assert_eq!(undone["job"]["status"], "rolled_back");
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        user
    );
    assert!(
        std::fs::read_dir(f.root.path().join("model-requests"))
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    );
}

#[test]
fn guided_codex_effective_view_replaces_singles_and_saved_report_survives_source_removal() {
    let f = Fixture::new("codex");
    kcoder_config::PrivateDirectory::open_or_create(&f.profile).unwrap();
    let project = f.root.path().join("workspace");
    trust(&f, &project);
    // This specific hierarchy fixture has a confirmed project marker; non-Git
    // project settings are covered independently by the destination-scope test.
    std::fs::create_dir(project.join(".codex")).unwrap();
    std::fs::write(project.join(".codex/config.toml"),"model='nearest'\nmodel_reasoning_effort='medium'\napproval_policy='on-request'\nsandbox_mode='read-only'\n[model_providers.ProjectOnly]\nbase_url='https://must-not-promote.invalid/v1'\nwire_api='responses'\nenv_key='MUST_NOT_READ_PROJECT_ENV'\n").unwrap();
    let source = std::fs::read(&f.config).unwrap();
    let mut dialog = Dialog::start_arguments(
        &f,
        "codex",
        None,
        false,
        &[
            "--project",
            project.to_str().unwrap(),
            "--target-scope",
            "user",
        ],
    );
    let frame = dialog.prompt("configuration_sources");
    let row = frame["choices"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["scope"] == "user")
        .unwrap();
    dialog.answer(&frame, &format!("layers {}", row["number"]));
    let frame = dialog.prompt("configuration_sources");
    assert!(
        frame["choices"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["scope"] == "user")
    );
    // A failed unconfirmed hierarchy does not silently select a different source.
    std::fs::create_dir(project.join(".git")).unwrap();
    let row = frame["choices"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["scope"] == "user")
        .unwrap();
    dialog.answer(&frame, &format!("layers {}", row["number"]));
    let frame = dialog.prompt("configuration_layers_page");
    assert_eq!(frame["choices"]["hasNextPage"], true);
    dialog.answer(&frame, "next");
    let frame = dialog.prompt("configuration_layers_page");
    assert_eq!(frame["choices"]["page"], 1);
    dialog.answer(&frame, "back");
    let frame = dialog.prompt("configuration_sources");
    assert!(
        frame["choices"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["scope"] == "codex-project-layers" && row["selected"] == true)
    );
    assert!(
        !frame["choices"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| matches!(row["scope"].as_str(), Some("user" | "project")))
    );
    dialog.answer(&frame, "done");
    let frame = dialog.prompt("menu");
    let id = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
    dialog.answer(&frame, "quit");
    dialog.finish();
    assert_eq!(std::fs::read(&f.config).unwrap(), source);
    std::fs::rename(&f.home, f.root.path().join("withheld-source")).unwrap();
    std::fs::rename(
        project.join(".codex"),
        project.join("withheld-project-source"),
    )
    .unwrap();
    let mut restored = Dialog::start(&f, "", Some(&id));
    let frame = restored.prompt("menu");
    restored.answer(&frame, "layers");
    let frame = restored.prompt("saved_configuration_layers");
    assert_eq!(frame["choices"]["items"].as_array().unwrap().len(), 1);
    restored.answer(&frame, "1");
    let frame = restored.prompt("configuration_layers_page");
    restored.answer(&frame, "back");
    let frame = restored.prompt("saved_configuration_layers");
    restored.answer(&frame, "back");
    let frame = restored.prompt("menu");
    restored.answer(&frame, "quit");
    restored.finish();
}

#[test]
fn guided_first_project_provider_selects_itself_on_a_fresh_profile_and_undo_restores_it() {
    let f = Fixture::new("codex");
    kcoder_config::PrivateDirectory::open_or_create(&f.profile).unwrap();
    let project = f.root.path().join("workspace");
    trust(&f, &project);
    std::fs::write(f.profile.join("settings.json"), "{}").unwrap();
    let original = kcoder_config::SettingsLoader::new(&project)
        .with_config_dir(&f.profile)
        .load()
        .unwrap()
        .settings;
    let mut dialog = Dialog::start_arguments(
        &f,
        "codex",
        None,
        false,
        &["--target-scope", "current-workspace"],
    );
    let frame = dialog.prompt("menu");
    let id = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
    dialog.answer(&frame, "select");
    let mut selected = false;
    loop {
        let frame = dialog.next();
        if frame["type"] != "prompt" {
            continue;
        }
        let answer = match frame["code"].as_str().unwrap() {
            "selection" => {
                if selected {
                    "preview".into()
                } else {
                    selected = true;
                    let row = frame["choices"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|row| row["mappingKind"] == "provider")
                        .unwrap();
                    format!("toggle {}", row["number"])
                }
            }
            "target_name" => "ProjectOffice".into(),
            "endpoint" | "model" => String::new(),
            "context_window_tokens" => "128000".into(),
            "output_headroom_tokens" | "max_output_tokens" => "8192".into(),
            "credential_consent" | "reuse" => "no".into(),
            "menu" => {
                dialog.answer(&frame, "quit");
                dialog.finish();
                break;
            }
            code => panic!("unexpected project provider prompt {code}"),
        };
        dialog.answer(&frame, &answer);
    }
    let result = operate(&f, &id, "apply", "IMPORT");
    assert!(
        matches!(
            result["job"]["status"].as_str(),
            Some("completed" | "completed_with_issues")
        ),
        "{result}"
    );
    assert_eq!(result["batch"]["committedActions"], 1);
    let loaded = kcoder_config::SettingsLoader::new(&project)
        .with_config_dir(&f.profile)
        .load()
        .unwrap()
        .settings;
    assert!(loaded.providers.contains_key("ProjectOffice"));
    for (name, provider) in &original.providers {
        assert_eq!(loaded.providers.get(name), Some(provider));
    }
    // A fresh profile selects nothing, so the first imported Provider may
    // become the project's selection; an existing selection never moves.
    assert_eq!(original.active_provider, None);
    assert_eq!(loaded.active_provider.as_deref(), Some("ProjectOffice"));
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        "{}"
    );
    std::fs::rename(&f.home, f.root.path().join("withheld-provider-source")).unwrap();
    assert_eq!(
        operate(&f, &id, "undo", "UNDO")["job"]["status"],
        "rolled_back"
    );
    let loaded = kcoder_config::SettingsLoader::new(&project)
        .with_config_dir(&f.profile)
        .load()
        .unwrap()
        .settings;
    assert_eq!(loaded.providers, original.providers);
    assert_eq!(loaded.active_provider, original.active_provider);
    assert_eq!(loaded.model, original.model);
}
