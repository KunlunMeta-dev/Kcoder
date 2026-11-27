use super::*;
use kcoder_types::migration_agent::ImportedAgentModel;

fn compile(format: Format, text: &str, tools: &[&str]) -> Result<SkillPackage> {
    package(
        format,
        text.as_bytes(),
        "reviewed-agent",
        "original-plan",
        &ImportedContextScope::Global,
        &MigrationAgentAdaptation {
            reviewed_source_sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
            model: ImportedAgentModel::Target {
                provider: "chosen-provider".into(),
                model: "chosen-model".into(),
            },
            tools: tools.iter().map(|name| (*name).into()).collect(),
        },
    )
}
#[test]
fn claude_restrictions_and_literal_prompt_are_preserved_in_disabled_native_package() {
    let text = "---\nname: reviewer\ndescription: Review changes\nmodel: sonnet\ntools: Read, Write, Grep\ndisallowedTools: Write\nmaxTurns: 7\n---\nKeep $0 and ${CLAUDE_PROJECT_DIR} literal.\n";
    let compiled = compile(Format::ClaudeAgentMarkdown, text, &["read", "grep"]).unwrap();
    let profile: PluginPromptProfile = serde_json::from_slice(&compiled.files[1].content).unwrap();
    assert_eq!(
        profile.allowed_tools,
        Some(vec!["read".into(), "grep".into()])
    );
    assert_eq!(profile.max_turns, Some(7));
    assert!(
        profile
            .instructions
            .contains("$0 and ${CLAUDE_PROJECT_DIR}")
    );
    assert_eq!(
        profile.imported_agent.unwrap().model,
        ImportedAgentModel::Target {
            provider: "chosen-provider".into(),
            model: "chosen-model".into(),
        }
    );
    let header = std::str::from_utf8(&compiled.files[0].content).unwrap();
    assert!(header.contains("default_enabled: false"));
    assert!(!header.contains("Keep $0"));
    assert!(compile(Format::ClaudeAgentMarkdown, text, &["write"]).is_err());
    assert!(compile(Format::ClaudeAgentMarkdown, text, &["WebSearch"]).is_err());
}
#[test]
fn current_codex_static_agent_schema_adapts_without_claiming_other_settings() {
    let text = "name='reviewer'\ndescription='Review changes'\nmodel='source-alias'\ndeveloper_instructions='Only review.'\n";
    let compiled = compile(Format::CodexAgentToml, text, &["read"]).unwrap();
    let profile: PluginPromptProfile = serde_json::from_slice(&compiled.files[1].content).unwrap();
    assert_eq!(profile.instructions, "Only review.");
    for extra in [
        "\n[features]\nshell_tool=false",
        "\nmodel_reasoning_effort='high'",
        "\napproval_policy='never'",
    ] {
        assert!(
            compile(
                Format::CodexAgentToml,
                &(text.to_owned() + extra),
                &["read"]
            )
            .is_err()
        );
    }
}
#[test]
fn source_privileges_unknown_semantics_and_unsupported_tool_aliases_stay_pending() {
    for header in [
        "permissionMode: bypassPermissions",
        "hooks: {}",
        "skills: [x]",
        "tools: AskUserQuestion",
        "tools: MultiEdit",
        "tools: mcp__server__*",
        "futurePolicy: true",
    ] {
        let text = format!("---\nname: reviewer\ndescription: Review\n{header}\n---\nReview.\n");
        assert!(compile(Format::ClaudeAgentMarkdown, &text, &["read"]).is_err());
    }
    let text = "---\nname: first\nname: second\ndescription: Review\n---\nReview.\n";
    assert!(compile(Format::ClaudeAgentMarkdown, text, &[]).is_err());
}
#[test]
fn original_review_hash_and_target_names_are_required() {
    let text = "name='reviewer'\ndescription='Review'\ndeveloper_instructions='Review.'";
    let mut choice = MigrationAgentAdaptation {
        reviewed_source_sha256: "0".repeat(64),
        model: ImportedAgentModel::Inherit,
        tools: vec![],
    };
    assert!(
        package(
            Format::CodexAgentToml,
            text.as_bytes(),
            "agent",
            "plan",
            &ImportedContextScope::Global,
            &choice
        )
        .is_err()
    );
    choice.reviewed_source_sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
    choice.model = ImportedAgentModel::Target {
        provider: String::new(),
        model: "m".into(),
    };
    assert!(
        package(
            Format::CodexAgentToml,
            text.as_bytes(),
            "agent",
            "plan",
            &ImportedContextScope::Global,
            &choice
        )
        .is_err()
    );
}
