//! Real terminal choices compile reviewed Agents into disabled Native launchers and owned Undo.
use super::*;
use kcoder_types::{migration_agent::ImportedAgentModel, plugin_prompt::PluginPromptProfile};
use sha2::{Digest, Sha256};

fn seed(f: &Fixture, source: &str) -> (PathBuf, String) {
    let product = f.home.join(if source == "codex" {
        ".codex"
    } else {
        ".claude"
    });
    std::fs::create_dir_all(product.join("agents")).unwrap();
    let (name, body) = if source == "codex" {
        (
            "review.toml",
            "name='review'\ndescription='Review static data'\nmodel='UNRESOLVED_SOURCE_ALIAS'\ndeveloper_instructions='TERMINAL_AGENT_BODY preserve original documents'\n",
        )
    } else {
        (
            "review.md",
            "---\nname: review\ndescription: Review static data\ntools: Read, Write\ndisallowedTools: Write\nmodel: UNRESOLVED_SOURCE_ALIAS\n---\nTERMINAL_AGENT_BODY preserve original documents\n",
        )
    };
    std::fs::write(product.join("agents").join(name), body).unwrap();
    (product, format!("{:x}", Sha256::digest(body.as_bytes())))
}

fn open(f: &Fixture, source: &str) -> (Dialog, String) {
    let mut dialog = Dialog::start_arguments(f, source, None, false, &["--include-definitions"]);
    let page = dialog.prompt("definition_selection");
    dialog.answer(&page, "toggle 1");
    let page = dialog.prompt("definition_selection");
    dialog.answer(&page, "done");
    let menu = dialog.prompt("menu");
    let job = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
    dialog.answer(&menu, "select");
    (dialog, job)
}

#[test]
fn agent_guide_explicitly_maps_both_source_models_tools_and_sha_then_reopens_original_undo() {
    for source in ["claude-code", "codex"] {
        let f = Fixture::new(source);
        std::fs::write(f.profile.join("settings.json"), json!({"credential_store":"file","provider":"local","local_base_url":"http://127.0.0.1:9","api_format":"openai_chat_completions","model":"exact-native-model","context_window_tokens":128000,"context_output_headroom":8192,"max_tokens":8192}).to_string()).unwrap();
        let original_settings = std::fs::read(f.profile.join("settings.json")).unwrap();
        let (product, sha256) = seed(&f, source);
        let (mut dialog, job) = open(&f, source);
        let mut selected = false;
        let mut reviewed_body = false;
        let mut read_selected = false;
        loop {
            let frame = dialog.next();
            if frame["type"] == "agent_compatibility" {
                assert_eq!(frame["result"]["sourceSha256"], sha256);
                assert_eq!(frame["result"]["canAdapt"], true);
                if source == "claude-code" {
                    assert_eq!(frame["result"]["availableTools"], json!(["read"]));
                }
            }
            if frame["type"] != "prompt" {
                continue;
            }
            let answer = match frame["code"].as_str().unwrap() {
                "selection" => {
                    if selected {
                        "preview".into()
                    } else if let Some(row) = frame["choices"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|row| row["item"]["category"] == "agent")
                    {
                        selected = true;
                        format!("toggle {}", row["number"])
                    } else {
                        "next".into()
                    }
                }
                "target_name" => "terminal-reviewed-agent".into(),
                "agent_adapt" | "agent_original_body" => "yes".into(),
                "definition_page" if !reviewed_body => {
                    reviewed_body = true;
                    assert!(!dialog.transcript.contains("TERMINAL_AGENT_BODY"));
                    "body".into()
                }
                "definition_page" => {
                    assert!(dialog.transcript.contains("TERMINAL_AGENT_BODY"));
                    "back".into()
                }
                "agent_model_kind" => if source == "claude-code" {
                    "inherit"
                } else {
                    "target"
                }
                .into(),
                "agent_provider" => "local".into(),
                "agent_model" => "exact-native-model".into(),
                "agent_tools" => {
                    assert!(frame["choices"]["items"].as_array().unwrap().len() <= 10);
                    if read_selected {
                        "done".into()
                    } else {
                        assert_eq!(frame["choices"]["selected"], 0);
                        let row = frame["choices"]["items"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|row| row["tool"] == "read")
                            .unwrap();
                        read_selected = true;
                        format!("toggle {}", row["number"])
                    }
                }
                "agent_reviewed_sha256" => sha256.clone(),
                "reuse" => "no".into(),
                "menu" => {
                    dialog.answer(&frame, "quit");
                    break;
                }
                code => panic!("unexpected Agent privilege/activation prompt {code}: {frame}"),
            };
            dialog.answer(&frame, &answer);
        }
        dialog.finish();
        assert!(reviewed_body && read_selected);
        assert!(!f.profile.join("skills/terminal-reviewed-agent").exists());
        let mut dialog = Dialog::start(&f, "", Some(&job));
        for (code, answer) in [
            ("menu", "apply"),
            ("request_id", "publish-reviewed-agent"),
            ("confirm_operation", "IMPORT"),
        ] {
            let prompt = dialog.prompt(code);
            dialog.answer(&prompt, answer);
        }
        let menu = dialog.prompt("menu");
        assert_eq!(dialog.state["job"]["committedItems"], 1);
        dialog.answer(&menu, "quit");
        dialog.finish();
        let native: PluginPromptProfile = serde_json::from_slice(
            &std::fs::read(
                f.profile
                    .join("skills/terminal-reviewed-agent/plugin-agent.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(native.allowed_tools, Some(vec!["read".into()]));
        let execution = native.imported_agent.unwrap();
        assert_eq!(execution.source_sha256, sha256);
        assert_eq!(
            execution.model,
            if source == "claude-code" {
                ImportedAgentModel::Inherit
            } else {
                ImportedAgentModel::Target {
                    provider: "local".into(),
                    model: "exact-native-model".into(),
                }
            }
        );
        let registry = kcoder_skills::SkillRegistry::load_for_profile(
            &f.root.path().join("workspace"),
            std::iter::empty::<&std::path::Path>(),
            &f.profile,
            false,
        )
        .unwrap();
        assert!(
            registry
                .list_catalog()
                .iter()
                .any(|row| row.name == "terminal-reviewed-agent")
        );
        assert!(registry.get_active("terminal-reviewed-agent").is_none());
        std::fs::rename(&product, f.home.join("source-withheld")).unwrap();
        let store = kcoder_migration::store::MigrationStore::open_existing(&f.profile).unwrap();
        let before = store.read(&job).unwrap();
        let mut dialog = Dialog::start(&f, "", Some(&job));
        let menu = dialog.prompt("menu");
        dialog.answer(&menu, "select");
        let menu = dialog.prompt("menu");
        assert!(dialog.transcript.contains("migration_plan_already_exists"));
        assert!(
            store.read(&job).unwrap() == before,
            "reopening selection must not replace the original plan or mapping"
        );
        dialog.answer(&menu, "undo");
        let prompt = dialog.prompt("request_id");
        dialog.answer(&prompt, "undo-reviewed-agent");
        let prompt = dialog.prompt("confirm_operation");
        dialog.answer(&prompt, "UNDO");
        let menu = dialog.prompt("menu");
        assert_eq!(dialog.state["job"]["status"], "rolled_back");
        dialog.answer(&menu, "quit");
        dialog.finish();
        assert!(!f.profile.join("skills/terminal-reviewed-agent").exists());
        assert_eq!(
            std::fs::read(f.profile.join("settings.json")).unwrap(),
            original_settings
        );
        let requests = f.root.path().join("model-requests");
        assert!(!requests.exists() || std::fs::read_dir(requests).unwrap().next().is_none());
    }
}

#[test]
fn agent_guide_rejects_unresolved_current_alias_and_wrong_review_without_a_plan_or_fallback() {
    for invalid_model in [true, false] {
        let f = Fixture::new("codex");
        seed(&f, "codex");
        let (mut dialog, job) = open(&f, "codex");
        let mut failed = false;
        loop {
            let frame = dialog.next();
            if frame["type"] == "notice" && frame["code"] != "migration_agent_model_boundary" {
                assert_eq!(
                    frame["code"],
                    if invalid_model {
                        "migration_agent_invalid_model_mapping"
                    } else {
                        "migration_agent_review_changed"
                    }
                );
                failed = true;
            }
            if frame["type"] != "prompt" {
                continue;
            }
            let answer = match frame["code"].as_str().unwrap() {
                "selection" if failed => {
                    assert_eq!(frame["choices"]["selected"], 0);
                    "quit".into()
                }
                "selection" => {
                    if let Some(row) = frame["choices"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|row| row["item"]["category"] == "agent")
                    {
                        format!("toggle {}", row["number"])
                    } else {
                        "next".into()
                    }
                }
                "target_name" => "must-not-publish-agent".into(),
                "agent_adapt" => "yes".into(),
                "agent_original_body" => "no".into(),
                "agent_model_kind" => if invalid_model { "target" } else { "inherit" }.into(),
                "agent_provider" => "current".into(),
                "agent_model" => "explicit-model".into(),
                "agent_tools" => "done".into(),
                "agent_reviewed_sha256" => "b".repeat(64),
                "menu" => {
                    dialog.answer(&frame, "quit");
                    break;
                }
                code => panic!("unexpected fallback or activation prompt {code}: {frame}"),
            };
            dialog.answer(&frame, &answer);
        }
        assert!(failed);
        dialog.finish();
        let saved = kcoder_migration::store::MigrationStore::open_existing(&f.profile)
            .unwrap()
            .read(&job)
            .unwrap();
        assert!(saved.batch.unwrap().plan_id.is_none());
        assert!(!f.profile.join("skills/must-not-publish-agent").exists());
    }
}
