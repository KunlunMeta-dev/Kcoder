//! Actual terminal commands explicitly select passive definitions and reopen the original immutable plan.
use super::*;
#[path = "agent_adaptation_cli.rs"]
mod agent_adaptation;
#[test]
fn definitions_guide_selects_pending_assets_previews_without_sources_and_undoes_original_owner() {
    for kind in ["claude-code", "codex"] {
        let f = Fixture::new(kind);
        let product = f
            .home
            .join(if kind == "codex" { ".codex" } else { ".claude" });
        std::fs::create_dir_all(product.join("agents")).unwrap();
        let name = if kind == "codex" {
            "review.toml"
        } else {
            "review.md"
        };
        let body = if kind == "codex" {
            "name='fixture'\ndescription='inert definition'\ndeveloper_instructions='EXPLICIT_BODY_CANARY never execute'\nmodel='fixture-model'\n"
        } else {
            "---\nname: fixture\ndescription: inert definition\ntools: Bash\npermissionMode: bypassPermissions\n---\nEXPLICIT_BODY_CANARY never execute"
        };
        std::fs::write(product.join("agents").join(name), body).unwrap();
        let mut dialog = Dialog::start_arguments(&f, kind, None, false, &["--include-definitions"]);
        let prompt = dialog.prompt("definition_selection");
        assert!(prompt["choices"]["items"].as_array().unwrap().len() <= 10);
        dialog.answer(&prompt, "toggle 1");
        let prompt = dialog.prompt("definition_selection");
        dialog.answer(&prompt, "done");
        let menu = dialog.prompt("menu");
        let job = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
        dialog.answer(&menu, "select");
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
                        let row = frame["choices"]["items"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|row| row["item"]["category"] == "agent");
                        if let Some(row) = row {
                            selected = true;
                            format!("toggle {}", row["number"])
                        } else {
                            assert!(
                                frame["choices"]["page"].as_u64().unwrap() + 1
                                    < frame["choices"]["pages"].as_u64().unwrap(),
                                "explicit definition source missing: {}",
                                dialog.transcript
                            );
                            "next".into()
                        }
                    }
                }
                "target_name" => "pending-agent".into(),
                "definition_save_consent" => "yes".into(),
                "agent_adapt" => if kind == "claude-code" { "yes" } else { "no" }.into(),
                "reuse" => "no".into(),
                "menu" => {
                    dialog.answer(&frame, "quit");
                    break;
                }
                code => panic!("unexpected activation/provider prompt: {code}"),
            };
            dialog.answer(&frame, &answer);
        }
        let trace = dialog.finish();
        assert!(!trace.contains("EXPLICIT_BODY_CANARY"));
        assert!(!f.profile.join("skills/pending-agent").exists());
        let mut dialog = Dialog::start(&f, "", Some(&job));
        let menu = dialog.prompt("menu");
        dialog.answer(&menu, "apply");
        let prompt = dialog.prompt("request_id");
        dialog.answer(&prompt, "save-pending-definition");
        let prompt = dialog.prompt("confirm_operation");
        dialog.answer(&prompt, "IMPORT");
        let menu = dialog.prompt("menu");
        assert_eq!(dialog.state["job"]["committedItems"], 1);
        dialog.answer(&menu, "quit");
        dialog.finish();
        std::fs::rename(&product, f.home.join("withheld-source")).unwrap();
        let mut dialog = Dialog::start(&f, "", Some(&job));
        let menu = dialog.prompt("menu");
        dialog.answer(&menu, "definitions");
        let prompt = dialog.prompt("definition_saved");
        dialog.answer(&prompt, "1");
        let prompt = dialog.prompt("definition_page");
        assert!(dialog.transcript.contains("executionAllowed\":false"));
        assert!(!dialog.transcript.contains("EXPLICIT_BODY_CANARY"));
        dialog.answer(&prompt, "body");
        let prompt = dialog.prompt("definition_page");
        assert!(dialog.transcript.contains("EXPLICIT_BODY_CANARY"));
        dialog.answer(&prompt, "back");
        let prompt = dialog.prompt("definition_saved");
        dialog.answer(&prompt, "back");
        let menu = dialog.prompt("menu");
        dialog.answer(&menu, "undo");
        let prompt = dialog.prompt("request_id");
        dialog.answer(&prompt, "undo-pending-definition");
        let prompt = dialog.prompt("confirm_operation");
        dialog.answer(&prompt, "UNDO");
        let menu = dialog.prompt("menu");
        assert_eq!(dialog.state["job"]["status"], "rolled_back");
        dialog.answer(&menu, "quit");
        dialog.finish();
        assert!(!f.profile.join("skills/pending-agent").exists());
        let state: Value = serde_json::from_slice(
            &std::fs::read(
                f.profile
                    .join("migrations/pending-definitions/migration-pending-definitions.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(state["records"], json!({}));
    }
}
