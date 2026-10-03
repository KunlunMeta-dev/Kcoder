use crate::{
    QueryEngine, SettingsPersistenceTarget, YoloUserQuestioner, recover_read_lock,
    recover_write_lock,
};
use anyhow::Context;
use kcoder_config::{
    PermissionAction, PermissionMode, PermissionRule, Settings, set_dotted_value,
    update_settings_file,
};
use kcoder_permissions::{PermissionDecision, PermissionDialogResult, PermissionResponse};
use kcoder_tools::UserQuestioner;
use serde_json::Value;
use std::sync::Arc;
use tracing::warn;

#[derive(Debug, Clone)]
enum PermissionPersistenceMutation {
    AllowTool(String),
    DenyTool(String),
    AddRule(PermissionRule),
}

impl PermissionPersistenceMutation {
    fn description(&self) -> &'static str {
        match self {
            Self::AllowTool(_) => "allowed tool setting",
            Self::DenyTool(_) => "denied tool setting",
            Self::AddRule(_) => "command permission rule",
        }
    }

    fn apply_to_settings(&self, settings: &mut Settings) {
        match self {
            Self::AllowTool(name) => {
                if !settings.allowed_tools.iter().any(|tool| tool == name) {
                    settings.allowed_tools.push(name.clone());
                }
                settings.denied_tools.retain(|tool| tool != name);
            }
            Self::DenyTool(name) => {
                if !settings.denied_tools.iter().any(|tool| tool == name) {
                    settings.denied_tools.push(name.clone());
                }
                settings.allowed_tools.retain(|tool| tool != name);
            }
            Self::AddRule(rule) => {
                if !settings.permission_rules.contains(rule) {
                    settings.permission_rules.push(rule.clone());
                }
            }
        }
    }

    fn apply_to_document(&self, document: &mut Value) -> anyhow::Result<()> {
        match self {
            Self::AllowTool(name) => {
                let mut allowed = document_string_list(document, "allowed_tools")?;
                let mut denied = document_string_list(document, "denied_tools")?;
                if !allowed.iter().any(|tool| tool == name) {
                    allowed.push(name.clone());
                }
                denied.retain(|tool| tool != name);
                set_dotted_value(document, "allowed_tools", serde_json::to_value(allowed)?)?;
                set_dotted_value(document, "denied_tools", serde_json::to_value(denied)?)?;
            }
            Self::DenyTool(name) => {
                let mut allowed = document_string_list(document, "allowed_tools")?;
                let mut denied = document_string_list(document, "denied_tools")?;
                if !denied.iter().any(|tool| tool == name) {
                    denied.push(name.clone());
                }
                allowed.retain(|tool| tool != name);
                set_dotted_value(document, "allowed_tools", serde_json::to_value(allowed)?)?;
                set_dotted_value(document, "denied_tools", serde_json::to_value(denied)?)?;
            }
            Self::AddRule(rule) => {
                let mut rules = document_permission_rules(document)?;
                if !rules.contains(rule) {
                    rules.push(rule.clone());
                }
                set_dotted_value(document, "permission_rules", serde_json::to_value(rules)?)?;
            }
        }
        Ok(())
    }
}

fn document_string_list(document: &Value, key: &str) -> anyhow::Result<Vec<String>> {
    document.get(key).map_or_else(
        || Ok(Vec::new()),
        |value| {
            serde_json::from_value(value.clone())
                .with_context(|| format!("invalid persisted permission field '{key}'"))
        },
    )
}

fn document_permission_rules(document: &Value) -> anyhow::Result<Vec<PermissionRule>> {
    document.get("permission_rules").map_or_else(
        || Ok(Vec::new()),
        |value| {
            serde_json::from_value(value.clone())
                .context("invalid persisted permission field 'permission_rules'")
        },
    )
}

impl QueryEngine {
    fn current_permission_mode(&self) -> PermissionMode {
        recover_read_lock(&self.settings, "settings").permission_mode
    }

    pub(super) fn permission_mode_bypasses_prompts(&self) -> bool {
        self.current_permission_mode().bypasses_prompts()
    }

    pub(super) fn permission_mode_suppresses_user_elicitation(&self) -> bool {
        self.current_permission_mode().suppresses_user_elicitation()
    }

    pub(crate) fn effective_user_questioner(&self) -> Arc<dyn UserQuestioner> {
        if self.permission_mode_suppresses_user_elicitation() {
            Arc::new(YoloUserQuestioner)
        } else {
            Arc::clone(&self.user_questioner)
        }
    }

    fn allow_for_session(&self, pattern: &str) {
        let mut permissions = recover_write_lock(&self.permissions, "permissions");
        permissions.allow_for_session(pattern);
    }

    fn deny_for_session(&self, pattern: &str) {
        let mut permissions = recover_write_lock(&self.permissions, "permissions");
        permissions.deny_for_session(pattern);
    }

    async fn persist_permission_settings(
        &self,
        mutation: PermissionPersistenceMutation,
    ) -> anyhow::Result<()> {
        let _order = self.settings_persistence_order.lock().await;
        let target = recover_read_lock(
            &self.settings_persistence_target,
            "settings_persistence_target",
        )
        .clone();
        let SettingsPersistenceTarget::UserFile(path) = target else {
            anyhow::bail!("permission persistence is disabled for this engine");
        };
        let operation = mutation.description();
        let disk_mutation = mutation.clone();
        tokio::task::spawn_blocking(move || {
            update_settings_file(&path, move |document| {
                disk_mutation.apply_to_document(document)
            })
            .map(|_| ())
        })
        .await
        .with_context(|| format!("failed to join {operation} persistence task"))??;

        // Publish in-memory state only after the disk transaction succeeds, so the UI cannot claim a permanent grant that disappears on restart.
        {
            let mut settings = recover_write_lock(&self.settings, "settings");
            mutation.apply_to_settings(&mut settings);
            recover_write_lock(&self.permissions, "permissions")
                .refresh_persisted_settings(&settings);
        }
        Ok(())
    }

    /// Atomically allow a tool and remove its same-name deny entry. Merge disk updates
    /// under the file lock for shared use by TUI `/allow` and permission prompts,
    /// preventing stale Settings snapshots from overwriting another engine.
    pub async fn persist_allowed_tool(&self, name: &str) -> anyhow::Result<()> {
        self.persist_permission_settings(PermissionPersistenceMutation::AllowTool(name.to_string()))
            .await
    }

    /// Atomically deny a tool and remove its same-name allow entry.
    pub async fn persist_denied_tool(&self, name: &str) -> anyhow::Result<()> {
        self.persist_permission_settings(PermissionPersistenceMutation::DenyTool(name.to_string()))
            .await
    }

    /// Persist an Allow rule for a specific shell command (approval memory).
    async fn persist_allowed_command(&self, name: &str, command: &str) -> anyhow::Result<()> {
        self.persist_command_rule(name, command, PermissionAction::Allow)
            .await
    }

    /// Persist a Deny rule for a specific shell command.
    async fn persist_denied_command(&self, name: &str, command: &str) -> anyhow::Result<()> {
        self.persist_command_rule(name, command, PermissionAction::Deny)
            .await
    }

    async fn persist_command_rule(
        &self,
        name: &str,
        command: &str,
        action: PermissionAction,
    ) -> anyhow::Result<()> {
        self.persist_permission_settings(PermissionPersistenceMutation::AddRule(PermissionRule {
            tool: name.to_string(),
            input_pattern: Some(command.to_string()),
            action,
        }))
        .await
    }
}

pub(super) fn apply_edited_input(result: PermissionDialogResult, fallback: Value) -> Value {
    if result.response == PermissionResponse::Edit {
        result.modified_input.unwrap_or(fallback)
    } else {
        fallback
    }
}

pub(super) async fn permission_response_to_decision(
    response: PermissionResponse,
    name: &str,
    input: &Value,
    engine: &QueryEngine,
) -> PermissionDecision {
    match response {
        PermissionResponse::AllowOnce => PermissionDecision::Allow,
        PermissionResponse::AllowAlways => {
            // Shell approvals persist the specific command (a permission rule),
            // not a blanket grant for the whole tool.
            let result = if let Some(command) = shell_command_for_persist(name, input) {
                engine.persist_allowed_command(name, command).await
            } else {
                engine.persist_allowed_tool(name).await
            };
            if let Err(error) = result {
                warn!("failed to persist allow-always response; applying it once: {error}");
            }
            PermissionDecision::Allow
        }
        PermissionResponse::AllowForSession => {
            engine.allow_for_session(name);
            PermissionDecision::Allow
        }
        PermissionResponse::DenyOnce => PermissionDecision::Deny,
        PermissionResponse::DenyAlways => {
            let result = if let Some(command) = shell_command_for_persist(name, input) {
                engine.persist_denied_command(name, command).await
            } else {
                engine.persist_denied_tool(name).await
            };
            if let Err(error) = result {
                warn!("failed to persist deny-always response; applying it once: {error}");
            }
            PermissionDecision::Deny
        }
        PermissionResponse::DenyForSession => {
            engine.deny_for_session(name);
            PermissionDecision::Deny
        }
        PermissionResponse::Edit => {
            // The edited input is applied separately; approve the modified request.
            PermissionDecision::Allow
        }
    }
}

fn shell_command_for_persist<'a>(name: &str, input: &'a Value) -> Option<&'a str> {
    if !matches!(
        name,
        "bash" | "BashTool" | "PowerShell" | "powershell" | "PowerShellTool"
    ) {
        return None;
    }
    input
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|command| !command.is_empty())
}
