//! Exercise the actual mutator after its host has captured an original directory FD.
#![cfg(target_os = "linux")]
use super::*;
use crate::wiki::{NativeWikiManagementGuard, NativeWikiReadAccess};
use kcoder_config::PrivateDirectory;
use std::sync::Arc;

struct SwappingAccess {
    profile: std::path::PathBuf,
    replacement: std::path::PathBuf,
}
struct HeldGuard {
    original: PrivateDirectory,
    profile: std::path::PathBuf,
    writer: std::sync::Mutex<Option<kcoder_knowledge::DirectoryKnowledgeWriter>>,
    scope: KnowledgeScope,
}
impl NativeWikiReadAccess for SwappingAccess {
    fn read(&self, _: Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
        Err(ToolError::Execution(
            "read unavailable in mutation fixture".into(),
        ))
    }
    fn begin_management(
        &self,
        _: &Value,
        _: &ToolContext,
    ) -> Result<Box<dyn NativeWikiManagementGuard>, ToolError> {
        let original = PrivateDirectory::open_existing(&self.profile.join("knowledge"))
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        let writer = kcoder_knowledge::DirectoryKnowledgeWriter::open(
            original
                .duplicate_handle()
                .map_err(|error| ToolError::Execution(error.to_string()))?,
        )
        .map_err(|error| ToolError::Execution(error.to_string()))?;
        let principal = std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID")
            .unwrap_or_else(|_| format!("profile:{}", self.profile.display()));
        let scope = KnowledgeScope::from_authenticated_host(&principal, "execution-host")
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        std::fs::rename(
            self.profile.join("knowledge"),
            self.profile.join("held-original"),
        )
        .map_err(|error| ToolError::Execution(error.to_string()))?;
        std::fs::rename(&self.replacement, self.profile.join("knowledge"))
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        Ok(Box::new(HeldGuard {
            original,
            profile: self.profile.clone(),
            writer: std::sync::Mutex::new(Some(writer)),
            scope,
        }))
    }
}
impl NativeWikiManagementGuard for HeldGuard {
    fn execute(&self, input: Value, _: &ToolContext) -> Result<Value, ToolError> {
        self.writer
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| ToolError::Execution("writer already used".into()))?
            .with_catalog(|catalog| execute_native_catalog(input, catalog, &self.scope))
            .map_err(|error| ToolError::Execution(error.to_string()))
    }
    fn finish(&self, _: &ToolContext) -> Result<(), ToolError> {
        let current = PrivateDirectory::open_existing(&self.profile.join("knowledge"))
            .and_then(|directory| directory.directory_identity())
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        if self
            .original
            .directory_identity()
            .map_err(|error| ToolError::Execution(error.to_string()))?
            != current
        {
            return Err(ToolError::Execution(
                "WIKI_WRITE_RESULT_NEEDS_RECONCILIATION".into(),
            ));
        }
        Ok(())
    }
}

#[tokio::test]
async fn held_directory_guard_must_not_write_a_replacement_namespace() -> Result<()> {
    let root = tempfile::tempdir()?;
    let profile = root.path().join("profile");
    let replacement = root.path().join("replacement");
    std::fs::create_dir_all(profile.join("knowledge"))?;
    std::fs::create_dir_all(&replacement)?;
    for directory in [&profile, &profile.join("knowledge"), &replacement] {
        kcoder_config::set_user_only_dir_permissions(directory)?;
    }
    let settings = profile.join("settings.json");
    std::fs::write(
        &settings,
        r#"{"knowledge":{"enabled":true,"organization_enabled":true}}"#,
    )?;
    let principal = std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID")
        .unwrap_or_else(|_| format!("profile:{}", profile.display()));
    let scope = KnowledgeScope::from_authenticated_host(&principal, "execution-host")?;
    let library = {
        let mut catalog = KnowledgeCatalog::open(&profile.join("knowledge/state.sqlite"))?;
        catalog.create(&scope, "owned-library", "Original library", "")?
    };
    std::fs::copy(
        profile.join("knowledge/state.sqlite"),
        replacement.join("state.sqlite"),
    )?;
    let tool: Arc<dyn Tool> = Arc::new(WikiManageTool);
    let input = json!({"action":"rename","library":library.id,"expected_revision":library.revision,"name":"Must never enter replacement"});
    let context = ToolContext::new(kcoder_state::AppState::new(root.path()))
        .with_settings_persistence_path(Some(settings))
        .with_tool_call_id("owned-directory-replacement")
        .with_native_wiki_read_access(Some(Arc::new(SwappingAccess {
            profile: profile.clone(),
            replacement,
        })));
    let actual = context.with_native_tool_invocation(&tool, &input)?;
    let error = tool.call(input, &actual).await.unwrap_err();
    assert!(error.to_string().contains("RECONCILIATION"));
    let current = KnowledgeCatalog::open(&profile.join("knowledge/state.sqlite"))?;
    assert_eq!(
        current.read(&scope, &library.id)?.name,
        "Original library",
        "An error after commit does not repair a write into the replacement namespace"
    );
    let original = KnowledgeCatalog::open(&profile.join("held-original/state.sqlite"))?;
    assert_eq!(
        original.read(&scope, &library.id)?.name,
        "Must never enter replacement"
    );
    Ok(())
}
