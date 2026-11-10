use super::*;
use crate::test_support::{engine_builder::TestEngineBuilder, providers::RequestRecordingProvider};
use kcoder_permissions::{AutoAllowPrompt, PermissionResponse};
use sha2::{Digest, Sha256};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

const SOURCE: &str = ".kcoder/specs/specs/core/spec.md";
const CHANGE: &str = "confirmed-interface-update";
const V1: &str = "# Spec: core\n\n## Purpose\n\nProject contract.\n\n## Requirements\n\n### Requirement: Stable interface\nThe interface MUST return version one.\n\n#### Scenario: Read interface\n- WHEN a task reads it\n- THEN it sees version one\n";

fn text(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn call(engine: &QueryEngine, name: &str, input: Value) -> ToolOutput {
    let (output, decision, _, _) = engine
        .execute_tool(
            &uuid::Uuid::new_v4().to_string(),
            name,
            input,
            &AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert_eq!(
        decision,
        PermissionDecision::Allow,
        "{name}: {}",
        text(&output)
    );
    assert!(!output.is_error, "{name}: {}", text(&output));
    output
}

struct ArchiveConfirmation {
    source: std::path::PathBuf,
    allow: bool,
    asked: AtomicUsize,
}

#[async_trait::async_trait]
impl PermissionPrompt for ArchiveConfirmation {
    async fn ask(&self, name: &str, _description: String, input: &Value) -> PermissionResponse {
        assert_eq!(name, "SpecArchive");
        assert_eq!(input["name"], CHANGE);
        assert_eq!(std::fs::read(&self.source).unwrap(), V1.as_bytes());
        self.asked.fetch_add(1, Ordering::SeqCst);
        if self.allow {
            PermissionResponse::AllowOnce
        } else {
            PermissionResponse::DenyOnce
        }
    }
}

#[tokio::test]
async fn confirmed_archive_reaches_a_new_tasks_actual_provider_request() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    std::fs::create_dir_all(workspace.join(".kcoder/specs/specs/core")).unwrap();
    std::fs::create_dir(&profile).unwrap();
    std::fs::write(workspace.join(SOURCE), V1).unwrap();
    kcoder_config::FolderTrustStore::load(&profile)
        .trust(&workspace)
        .unwrap();
    let settings = Settings {
        permission_mode: kcoder_config::PermissionMode::Auto,
        ..Settings::default()
    };
    let tools = ToolRegistry::new()
        .register(kcoder_tools::SpecInitTool)
        .register(kcoder_tools::SpecConfigTool)
        .register(kcoder_tools::SpecStatusTool)
        .register(kcoder_tools::SpecNewChangeTool)
        .register(kcoder_tools::SpecCheckTool)
        .register(kcoder_tools::SpecReviewTool)
        .register(kcoder_tools::SpecRecordVerificationTool)
        .register(kcoder_tools::SpecArchiveTool);
    let first = TestEngineBuilder::new(&workspace)
        .settings(settings.clone())
        .folder_trusted(Some(true))
        .tool_registry(tools)
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    call(&first, "SpecInit", serde_json::json!({})).await;
    call(
        &first,
        "SpecConfig",
        serde_json::json!({"action":"set", "key":"schema", "value":"spec-driven-superpowers"}),
    )
    .await;
    let before: Value = serde_json::from_str(&text(
        &call(
            &first,
            "SpecStatus",
            serde_json::json!({"knowledge":{"paths":[SOURCE]}}),
        )
        .await,
    ))
    .unwrap();
    let old_revision = before["knowledge"]["sources"][0]["revision"]
        .as_str()
        .unwrap();
    assert_eq!(old_revision, format!("{:x}", Sha256::digest(V1.as_bytes())));
    let update = serde_json::json!({"knowledge":{
        "paths":[SOURCE], "scope":before["knowledge"]["scope"], "updates":[{
            "path":SOURCE, "expected_revision":old_revision,
            "replacement":V1.replace("version one", "version two")
        }]
    }});
    let preview: Value =
        serde_json::from_str(&text(&call(&first, "SpecStatus", update.clone()).await)).unwrap();
    assert_eq!(preview["candidates"][0]["status"], "candidate_update");
    assert_eq!(
        std::fs::read(workspace.join(SOURCE)).unwrap(),
        V1.as_bytes()
    );
    call(
        &first,
        "SpecNewChange",
        serde_json::json!({
            "name":CHANGE, "knowledge_base":preview["candidates"][0]["change_base"]
        }),
    )
    .await;
    let change = workspace.join(".kcoder/specs/changes").join(CHANGE);
    // Only the existing change artifacts are edited. Authoritative v2 is written
    // exclusively by the normal confirmed archive transaction below.
    std::fs::write(
        change.join("specs/core/spec.md"),
        preview["candidates"][0]["delta"].as_str().unwrap(),
    )
    .unwrap();
    std::fs::write(
        change.join("tasks.md"),
        "- [x] 1.1 Confirm the interface contract\n",
    )
    .unwrap();
    std::fs::write(change.join("plan.md"), "# Plan\n\n## Covers\n\n- 1.1\n").unwrap();
    std::fs::write(
        change.join("review.md"),
        "# Review\n\n## Readiness Decision\n\nready\n\n## Blocked By\n\nnone\n",
    )
    .unwrap();
    let checked = call(
        &first,
        "SpecCheck",
        serde_json::json!({"action":"validate", "change":CHANGE}),
    )
    .await;
    assert!(
        text(&checked).contains("Validation passed"),
        "{}",
        text(&checked)
    );
    let review = call(
        &first,
        "SpecReview",
        serde_json::json!({"name":CHANGE, "base_sha":"HEAD"}),
    )
    .await;
    assert!(text(&review).contains("version two"));
    call(&first, "SpecReview", serde_json::json!({"action":"writeback", "name":CHANGE,
        "review_status":"approved", "findings_summary":["Reviewed interface candidate is ready for explicit confirmation."]})).await;
    call(&first, "SpecRecordVerification", serde_json::json!({"name":CHANGE,
        "completion_decision":"complete", "evidence":["Deterministic contract fixture; no live-model or project-test claim."]})).await;
    let preflight: Value = serde_json::from_str(&text(
        &call(
            &first,
            "SpecCheck",
            serde_json::json!({"action":"preflight", "change":CHANGE}),
        )
        .await,
    ))
    .unwrap();
    assert_eq!(preflight["ok"], true, "{preflight}");
    for allow in [false, true] {
        let confirmation = ArchiveConfirmation {
            source: workspace.join(SOURCE),
            allow,
            asked: AtomicUsize::new(0),
        };
        let (output, decision, _, _) = first
            .execute_tool(
                &uuid::Uuid::new_v4().to_string(),
                "SpecArchive",
                serde_json::json!({"name":CHANGE}),
                &confirmation,
            )
            .await
            .unwrap();
        assert_eq!(confirmation.asked.load(Ordering::SeqCst), 1);
        if !allow {
            assert_eq!(decision, PermissionDecision::Deny);
            assert!(output.is_error);
            assert_eq!(
                std::fs::read(workspace.join(SOURCE)).unwrap(),
                V1.as_bytes()
            );
            assert!(change.exists());
        } else {
            assert_eq!(decision, PermissionDecision::Allow);
            assert!(!output.is_error, "{}", text(&output));
            assert!(text(&output).contains("Archived change"));
            assert!(!change.exists());
        }
    }
    let published = std::fs::read(workspace.join(SOURCE)).unwrap();
    assert!(String::from_utf8_lossy(&published).contains("version two"));
    let revision = format!("{:x}", Sha256::digest(&published));
    assert_ne!(revision, old_revision);
    let stale = call_error(&first, update).await;
    assert!(text(&stale).contains("stale_revision"), "{}", text(&stale));

    let requests = Arc::new(Mutex::new(Vec::new()));
    let next = TestEngineBuilder::new(&workspace)
        .settings(settings)
        .folder_trusted(Some(true))
        .tool_registry(ToolRegistry::new().register(kcoder_tools::SpecStatusTool))
        .provider(Arc::new(RequestRecordingProvider {
            requests: Arc::clone(&requests),
        }))
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    assert_ne!(first.state.session_id(), next.state.session_id());
    next.state.add_message(Message::user_text(format!(
        "Next task follows {SOURCE}. Read the confirmed interface."
    )));
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut stream = next.run_turn_stream(&AutoAllowPrompt);
        while let Some(event) = stream.next().await {
            assert!(
                !matches!(
                    event,
                    EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
                ),
                "{event:?}"
            );
        }
    })
    .await
    .expect("the bounded recording provider must finish the next task");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let knowledge = requests[0]
        .messages
        .iter()
        .find_map(|message| match message {
            Message::User { content, .. } => content.iter().find_map(|block| match block {
                ContentBlock::Text { text }
                    if text.starts_with("Current task project knowledge ") =>
                {
                    Some(serde_json::from_str::<Value>(text.split_once('\n').unwrap().1).unwrap())
                }
                _ => None,
            }),
            _ => None,
        })
        .expect("the actual provider request must carry current project knowledge");
    let source = &knowledge["knowledge"]["sources"][0];
    assert_eq!(source["path"], SOURCE);
    assert_eq!(source["kind"], "authoritative_spec");
    assert_eq!(source["revision"], revision);
    assert!(source["content"].as_str().unwrap().contains("version two"));
    assert_ne!(
        knowledge["knowledge"]["scope"],
        before["knowledge"]["scope"]
    );
    assert!(
        !serde_json::to_string(&requests[0].messages)
            .unwrap()
            .contains("version one")
    );
}

async fn call_error(engine: &QueryEngine, input: Value) -> ToolOutput {
    let (output, _, _, _) = engine
        .execute_tool(
            &uuid::Uuid::new_v4().to_string(),
            "SpecStatus",
            input,
            &AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(output.is_error, "{}", text(&output));
    output
}
