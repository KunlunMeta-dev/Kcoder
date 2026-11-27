use super::*;
use kcoder_state::AppState;

fn fixture() -> (tempfile::TempDir, ToolContext) {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&profile).unwrap();
    kcoder_config::FolderTrustStore::load(&profile)
        .trust(&workspace)
        .unwrap();
    fs::write(workspace.join("README.md"), "Current project contract.").unwrap();
    let context = ToolContext::new(AppState::new(&workspace))
        .with_settings_persistence_path(Some(profile.join("settings.json")));
    (root, context)
}

fn output_json(output: ToolOutput) -> Value {
    let text = output
        .content
        .into_iter()
        .find_map(|block| match block {
            kcoder_types::ContentBlock::Text { text } => Some(text),
            _ => None,
        })
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

fn task_context(context: &ToolContext, prompt: &str) -> Option<String> {
    let paths = task_source_paths(prompt);
    if paths.is_empty() {
        return None;
    }
    Some(
        match execute(
            ProjectKnowledgeInput {
                paths,
                max_total_bytes: DEFAULT_KNOWLEDGE_BYTES,
                scope: None,
                updates: Vec::new(),
            },
            context,
        ) {
            Ok(output) => output_json(output).to_string(),
            Err(error) => {
                serde_json::json!({"status":"unavailable","reason":error.to_string()}).to_string()
            }
        },
    )
}

#[tokio::test]
async fn spec_status_reads_and_previews_in_the_existing_registered_tool() {
    let (_root, context) = fixture();
    let view = output_json(
        SpecStatusTool
            .call(
                serde_json::json!({
                    "knowledge":{"paths":["README.md"]}
                }),
                &context,
            )
            .await
            .unwrap(),
    );
    assert_eq!(view["knowledge"]["sources"][0]["kind"], "project_document");
    let revision = view["knowledge"]["sources"][0]["revision"]
        .as_str()
        .unwrap();
    let scope = view["knowledge"]["scope"].as_str().unwrap();
    let candidate = output_json(SpecStatusTool.call(serde_json::json!({
        "knowledge":{"paths":["README.md"],"scope":scope,"updates":[{
            "path":"README.md","expected_revision":revision,"replacement":"Reviewed next contract."
        }]}
    }), &context).await.unwrap());
    assert_eq!(candidate["candidates"][0]["status"], "candidate_update");
    assert!(
        candidate["candidates"][0]["diff"]
            .as_str()
            .unwrap()
            .contains("Reviewed next contract.")
    );
    assert_eq!(
        fs::read_to_string(context.state.cwd().join("README.md")).unwrap(),
        "Current project contract."
    );
    fs::write(context.state.cwd().join("README.md"), "New user edit.").unwrap();
    let error = SpecStatusTool
        .call(
            serde_json::json!({
                "knowledge":{"paths":["README.md"],"scope":scope,"updates":[{
                    "path":"README.md","expected_revision":revision,"replacement":"Old task update."
                }]}
            }),
            &context,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("stale_revision"));
}

#[tokio::test]
async fn knowledge_does_not_ambiguously_override_the_existing_change_read() {
    let (_root, context) = fixture();
    for field in ["name", "change"] {
        let mut input = serde_json::json!({"knowledge":{"paths":["README.md"]}});
        input[field] = serde_json::json!("existing-change");
        assert!(matches!(
            SpecStatusTool.call(input, &context).await,
            Err(ToolError::InvalidInput(_))
        ));
    }
    let no_profile = ToolContext::new(AppState::new(context.state.cwd()));
    let error = SpecStatusTool
        .call(
            serde_json::json!({"knowledge":{"paths":["README.md"]}}),
            &no_profile,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("missing_profile"));
}

#[test]
fn selected_task_source_adapter_is_bounded_and_fresh() {
    let (_root, context) = fixture();
    assert!(task_context(&context, "Make a localized code fix.").is_none());
    let first = task_context(
        &context,
        "Follow [the contract](README.md) and `README.md`.",
    )
    .unwrap();
    assert!(first.contains("Current project contract."));
    assert_eq!(
        task_source_paths("Read README.md and README.md"),
        ["README.md"]
    );
    fs::write(
        context.state.cwd().join("README.md"),
        "Confirmed newer contract.",
    )
    .unwrap();
    let next = task_context(&context, "Next task follows README.md").unwrap();
    assert!(next.contains("Confirmed newer contract."));
    assert!(!next.contains("Current project contract."));
    fs::remove_file(context.state.cwd().join("README.md")).unwrap();
    assert!(
        task_context(&context, "Follow README.md")
            .unwrap()
            .contains("unavailable")
    );
    let over_budget = (0..9)
        .map(|index| format!("docs/{index}.md"))
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        task_context(&context, &over_budget)
            .unwrap()
            .contains("unavailable")
    );
}

#[tokio::test]
async fn knowledge_sources_respect_the_target_sandbox_denied_subtree() {
    let (_root, context) = fixture();
    let workspace = context.state.cwd();
    let context = context.with_sandbox(Arc::new(crate::sandbox::Sandbox::new(
        &workspace,
        kcoder_types::SandboxConfig {
            enabled: true,
            denied_paths: vec![workspace.join("README.md").display().to_string()],
            ..Default::default()
        },
    )));
    let error = SpecStatusTool
        .call(
            serde_json::json!({"knowledge":{"paths":["README.md"]}}),
            &context,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("denied"));
    assert!(!error.to_string().contains("Current project contract."));
}

#[tokio::test]
async fn new_change_carries_the_preview_source_guards_into_the_existing_base() {
    let (_root, context) = fixture();
    kcoder_specs::init(&context.state.cwd()).unwrap();
    let context = context.with_active_skills(Arc::new(std::sync::RwLock::new(vec![
        "using-specs".into(),
        "using-superpowers".into(),
    ])));
    let source = ".kcoder/specs/specs/core/spec.md";
    let before = output_json(
        SpecStatusTool
            .call(
                serde_json::json!({"knowledge":{"paths":[source]}}),
                &context,
            )
            .await
            .unwrap(),
    );
    let original = before["knowledge"]["sources"][0]["content"]
        .as_str()
        .unwrap();
    let preview = output_json(SpecStatusTool.call(serde_json::json!({"knowledge":{
        "paths":[source],"scope":before["knowledge"]["scope"],"updates":[{
            "path":source,"expected_revision":before["knowledge"]["sources"][0]["revision"],"replacement":original
        }]
    }}), &context).await.unwrap());
    let base = preview["candidates"][0]["change_base"].clone();
    SpecNewChangeTool
        .call(
            serde_json::json!({"name":"retained-knowledge","knowledge_base":base}),
            &context,
        )
        .await
        .unwrap();
    let persisted: Value = serde_json::from_slice(
        &fs::read(
            context
                .state
                .cwd()
                .join(".kcoder/specs/changes/retained-knowledge/.base.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        persisted["requirements"]["knowledge_sources"][0]["revision"],
        before["knowledge"]["sources"][0]["revision"]
    );
    fs::write(
        context.state.cwd().join(source),
        format!("{original}\nA newer user decision.\n"),
    )
    .unwrap();
    let error = SpecNewChangeTool
        .call(
            serde_json::json!({"name":"stale-knowledge","knowledge_base":base}),
            &context,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("stale_revision"));
}

#[test]
fn knowledge_schema_and_read_only_contract_remain_explicit() {
    let schema = SpecStatusTool.input_schema();
    assert!(schema["properties"].get("knowledge").is_some());
    assert!(SpecStatusTool.is_read_only());
    assert!(
        SpecStatusTool
            .is_concurrency_safe(&serde_json::json!({"knowledge":{"paths":["README.md"]}}))
    );
    assert!(
        SpecStatusTool
            .description()
            .contains("never save or confirm")
    );
}
