use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_tools::{FileReadTool, SkillTool, ToolRegistry};
use kcoder_types::{ContentBlock, Message};
use serde_json::json;

fn text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn instruction_only_skills_keep_explicit_empty_tool_rights_and_pin_the_snapshot() -> Result<()> {
    let root = tempfile::tempdir()?;
    let content = "Original embedded expert instructions";
    let definition: OfficeAssistantDefinition = serde_json::from_value(json!({
        "schemaVersion":1,"id":"inline-fixture","scope":"personal","title":"Inline",
        "description":"Fixture","language":"en","inputSchema":{"type":"object"},
        "instructions":"Expert base instructions","allowedTools":[],
        "skills":[{"slug":"demo","title":"Demo","description":"","content":content,"enabled":true}],
        "modelSelection":{"kind":"inherit_current"},"outputKinds":["document"],
        "acceptanceCriteria":["Review"],"externalSend":"deny"
    }))?;
    let snapshot: OfficeExpertResourceSnapshot = serde_json::from_value(json!({
        "owner":{"accountId":"owner","targetId":"target","workspaceId":null},"expertId":"inline-fixture",
        "skills":{"demo":[{"path":"SKILL.md","sha256":format!("{:x}",Sha256::digest(content.as_bytes())),"bytes":content.len()}]}
    }))?;
    let task = TestEngineBuilder::new(root.path()).build_with_profile_directory();
    let expert = task.clone().with_agent_definition_context(definition)?;
    let inline = expert
        .clone()
        .with_agent_skill_resources(snapshot.clone(), root.path().into())?;
    assert!(inline.active_tool_registry().names().is_empty());
    assert!(inline.agent_resource_snapshot().is_some());
    let mut prompt = String::new();
    inline.append_agent_definition_instructions(&mut prompt);
    assert!(prompt.contains(content));
    assert!(!prompt.contains("Load the exact registered expert skill"));
    let mut extra = snapshot;
    let file = extra.skills["demo"][0].clone();
    extra.skills.get_mut("demo").unwrap().push(
        kcoder_types::integrations::office::OfficeExpertFile {
            path: "references/routing.md".into(),
            ..file
        },
    );
    assert!(
        expert
            .with_agent_skill_resources(extra, root.path().into())
            .is_err()
    );
    assert!(task.agent_resource_snapshot().is_none());
    Ok(())
}

#[tokio::test]
async fn expert_resources_use_original_skill_and_read_tools_and_keep_project_cwd() -> Result<()> {
    let root = tempfile::tempdir()?;
    let project = root.path().join("project");
    let cache = root.path().join("cache/skills");
    let base = cache.join("demo");
    std::fs::create_dir_all(&project)?;
    std::fs::create_dir_all(base.join("references"))?;
    let content = "---\nname: demo\ndescription: Read routing when needed\nallowed-tools: [Read, Grep, Glob, Bash, Edit, Write, Task, WebSearch]\n---\nRead references/routing.md before routing.";
    let reference = "ORIGINAL_REFERENCE_RULES_NOT_IN_SYSTEM_PROMPT";
    std::fs::write(base.join("SKILL.md"), content)?;
    std::fs::write(base.join("references/routing.md"), reference)?;
    let definition: OfficeAssistantDefinition = serde_json::from_value(json!({
        "schemaVersion":1,"id":"expert-fixture","scope":"personal","title":"领域专家","description":"Fixture",
        "language":"zh-CN","inputSchema":{"type":"object"},"instructions":"Expert domain instructions",
        "skills":[{"slug":"demo","title":"Demo","description":"Read routing","content":content,"enabled":true}],
        "modelSelection":{"kind":"inherit_current"},"outputKinds":["document"],"acceptanceCriteria":["Review"],"externalSend":"deny"
    }))?;
    let snapshot: OfficeExpertResourceSnapshot = serde_json::from_value(json!({
        "owner":{"accountId":"owner","targetId":"target","workspaceId":null},"expertId":"expert-fixture",
        "skills":{"demo":[
            {"path":"SKILL.md","sha256":format!("{:x}",Sha256::digest(content.as_bytes())),"bytes":content.len()},
            {"path":"references/routing.md","sha256":format!("{:x}",Sha256::digest(reference.as_bytes())),"bytes":reference.len()}
        ]}
    }))?;
    let task = TestEngineBuilder::new(&project)
        .tool_registry(
            ToolRegistry::new()
                .register(SkillTool)
                .register(FileReadTool),
        )
        .build_with_profile_directory();
    assert!(
        !crate::recover_read_lock(&task.settings, "settings")
            .skills
            .trust_external
    );
    task.active_skills
        .write()
        .unwrap()
        .push("expert:user-owned".into());
    let expert = task
        .clone()
        .with_agent_definition_context(definition)?
        .with_agent_skill_resources(snapshot, cache)?;
    assert_eq!(expert.cwd, project);
    assert!(
        crate::recover_read_lock(&task.skill_registry, "skills")
            .names()
            .iter()
            .all(|name| !name.starts_with("expert:"))
    );
    let name = crate::recover_read_lock(&expert.skill_registry, "skills")
        .names()
        .into_iter()
        .find(|name| name.starts_with("expert:"))
        .unwrap();
    let mut prompt = crate::prompt_runtime::build_system_prompt(
        &project,
        "fixture-model",
        false,
        false,
        false,
        &["skill".into(), "read".into()].into_iter().collect(),
    );
    expert.append_agent_definition_instructions(&mut prompt);
    assert!(prompt.contains("领域专家"));
    assert!(!prompt.contains("Read references/routing.md before routing"));
    assert!(!prompt.contains(reference));
    let (loaded, _, _, _) = expert
        .execute_tool(
            "load-expert-skill",
            "skill",
            json!({"skill":name}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await?;
    assert!(!loaded.is_error, "{}", text(&loaded.content));
    let loaded_text = text(&loaded.user_context);
    assert!(loaded_text.contains("Read references/routing.md before routing"));
    assert!(loaded_text.contains("Skill base directory:"));
    assert!(!loaded_text.contains(reference));
    let input = json!({"file_path":base.join("references/routing.md"),"fresh":true});
    let (read, _, _, _) = expert
        .execute_tool(
            "read-expert-reference",
            "read",
            input.clone(),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await?;
    assert!(!read.is_error, "{}", text(&read.content));
    assert!(text(&read.content).contains(reference));
    // A changed cache must not release altered rules into the model's tool result.
    let directory = kcoder_config::PrivateDirectory::open_existing(&base.join("references"))?;
    directory.atomic_replace(std::ffi::OsStr::new("routing.md"), b"ALTERED_RULES")?;
    let (rejected, _, _, _) = expert
        .execute_tool(
            "read-altered-reference",
            "read",
            input,
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await?;
    assert!(rejected.is_error);
    assert!(!text(&rejected.content).contains("ALTERED_RULES"));
    let mut history: kcoder_types::SharedMessages = vec![Message::User {
        origin: kcoder_types::MessageOrigin::Runtime,
        content: loaded.user_context,
    }]
    .into();
    let cleared = expert.without_agent_definition_context();
    assert!(
        cleared
            .active_skills
            .read()
            .unwrap()
            .contains(&"expert:user-owned".into())
    );
    cleared.project_skill_messages(&mut history);
    assert!(
        !serde_json::to_string(&history)?.contains("Read references/routing.md before routing")
    );
    assert!(
        crate::recover_read_lock(&cleared.skill_registry, "skills")
            .names()
            .iter()
            .all(|name| !name.starts_with("expert:"))
    );
    Ok(())
}
