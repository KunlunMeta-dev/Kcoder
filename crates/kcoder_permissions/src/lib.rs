use async_trait::async_trait;
use kcoder_config::{PermissionMode, PermissionRule, Settings};
use kcoder_permission_rules::{PermissionTool, RuleEvaluation};
use kcoder_tools::Tool;
use serde_json::Value;
use std::path::PathBuf;

pub mod integrations;
pub use kcoder_permission_rules::{
    AuditRecord, PermissionAudit, PermissionDecision, PermissionRequestContext, PermissionRisk,
    bash_command_matches, classify_bash_read_only, classify_powershell_read_only, glob_match,
    split_bash_command,
};

/// Response from an interactive permission prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionResponse {
    AllowOnce,
    AllowAlways,
    AllowForSession,
    DenyOnce,
    DenyAlways,
    DenyForSession,
    /// Edit the input before allowing.
    Edit,
}

/// Callback invoked when the permission engine needs user input.
#[async_trait]
pub trait PermissionPrompt: Send + Sync {
    /// Bind one invocation without mutating a prompt shared by concurrent tools.
    /// Existing interactive prompts retain their editing and permission semantics.
    fn bind_tool_call(&self, _tool_call_id: &str) -> Option<std::sync::Arc<dyn PermissionPrompt>> {
        None
    }
    /// Present a prompt and return the user's response.
    ///
    /// `input` is the raw tool input JSON so the prompt may render it or
    /// allow the user to edit it when returning [`PermissionResponse::Edit`].
    async fn ask(&self, tool_name: &str, description: String, input: &Value) -> PermissionResponse;

    /// Present a prompt using enriched request context.
    ///
    /// The default implementation delegates to [`Self::ask`] for backwards
    /// compatibility; implementations that want tool-specific detail and risk
    /// badges should override this method.
    async fn ask_context(&self, context: &PermissionRequestContext) -> PermissionResponse {
        self.ask(
            &context.tool_name,
            context.description.clone(),
            &context.input,
        )
        .await
    }

    /// Present a prompt and optionally allow the user to edit the tool input.
    ///
    /// The default implementation delegates to [`Self::ask_context`] and never
    /// returns edited input. Interactive prompts can override this to support
    /// inline editing before allowing a tool.
    async fn ask_context_with_edit(
        &self,
        context: &PermissionRequestContext,
    ) -> PermissionDialogResult {
        let response = self.ask_context(context).await;
        PermissionDialogResult {
            response,
            modified_input: None,
        }
    }

    /// Require a real per-call user response. Noninteractive prompt adapters
    /// must not substitute automatic permission for this boundary.
    async fn ask_explicit_context_with_edit(
        &self,
        _context: &PermissionRequestContext,
    ) -> PermissionDialogResult {
        PermissionDialogResult {
            response: PermissionResponse::DenyOnce,
            modified_input: None,
        }
    }
}

/// Result returned by a permission prompt, optionally including edited input.
#[derive(Debug, Clone)]
pub struct PermissionDialogResult {
    pub response: PermissionResponse,
    /// Edited tool input, populated only when the user chose to edit.
    pub modified_input: Option<Value>,
}

/// Permission prompt that automatically allows every request.
///
/// Useful for sub-agents and headless automation where interactive prompting
/// is not desired.
#[derive(Debug, Clone, Copy, Default)]
pub struct AutoAllowPrompt;

#[async_trait]
impl PermissionPrompt for AutoAllowPrompt {
    async fn ask(
        &self,
        _tool_name: &str,
        _description: String,
        _input: &Value,
    ) -> PermissionResponse {
        PermissionResponse::AllowOnce
    }
}

/// Non-interactive permission prompt that denies every request requiring
/// confirmation. Explicit allow rules and non-interactive permission modes are
/// evaluated before this prompt is reached.
#[derive(Debug, Clone, Copy, Default)]
pub struct AutoDenyPrompt;

#[async_trait]
impl PermissionPrompt for AutoDenyPrompt {
    async fn ask(
        &self,
        _tool_name: &str,
        _description: String,
        _input: &Value,
    ) -> PermissionResponse {
        PermissionResponse::DenyOnce
    }
}

/// Outcome of evaluating a permission request, including optional modified input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOutcome {
    pub decision: PermissionDecision,
    /// Edited tool input, populated only when the user chose to edit.
    pub modified_input: Option<Value>,
}

impl PermissionOutcome {
    pub fn allow() -> Self {
        Self {
            decision: PermissionDecision::Allow,
            modified_input: None,
        }
    }

    pub fn deny() -> Self {
        Self {
            decision: PermissionDecision::Deny,
            modified_input: None,
        }
    }

    pub fn ask() -> Self {
        Self {
            decision: PermissionDecision::Ask,
            modified_input: None,
        }
    }

    pub fn allow_with_input(input: Value) -> Self {
        Self {
            decision: PermissionDecision::Allow,
            modified_input: Some(input),
        }
    }
}

/// Permission checker that evaluates whether a tool may run.
#[derive(Debug, Clone)]
pub struct PermissionEngine {
    pub mode: PermissionMode,
    /// Persisted allowed tool patterns.
    pub allowed_tools: Vec<String>,
    /// Persisted denied tool patterns.
    pub denied_tools: Vec<String>,
    /// Persisted structured rules.
    pub rules: Vec<PermissionRule>,
    /// Session-only allowed tool patterns.
    pub session_allowed: Vec<String>,
    /// Session-only denied tool patterns.
    pub session_denied: Vec<String>,
    /// Session-only structured rules.
    pub session_rules: Vec<PermissionRule>,
    /// Session-only shell command prefixes authorized by the caller.
    ///
    /// These are intentionally separate from the generic read-only classifier:
    /// validation commands such as `cargo test` execute repository code and
    /// must only be granted to a role that is explicitly allowed to do so.
    pub session_allowed_shell_prefixes: Vec<String>,
    /// Optional audit log writer.
    audit: Option<PermissionAudit>,
}

impl Default for PermissionEngine {
    fn default() -> Self {
        Self {
            mode: PermissionMode::Ask,
            allowed_tools: Vec::new(),
            denied_tools: Vec::new(),
            rules: Vec::new(),
            session_allowed: Vec::new(),
            session_denied: Vec::new(),
            session_rules: Vec::new(),
            session_allowed_shell_prefixes: Vec::new(),
            audit: None,
        }
    }
}

impl PermissionEngine {
    pub fn from_settings(settings: &Settings) -> Self {
        Self {
            mode: settings.permission_mode,
            allowed_tools: settings.allowed_tools.clone(),
            denied_tools: settings.denied_tools.clone(),
            rules: settings.permission_rules.clone(),
            session_allowed: settings.session_allowed_tools.clone(),
            session_denied: settings.session_denied_tools.clone(),
            session_rules: settings.session_permission_rules.clone(),
            session_allowed_shell_prefixes: Vec::new(),
            audit: None,
        }
    }

    /// Refresh persisted configuration while retaining current-session grants,
    /// verifier shell prefixes, and the auditor. Runtime settings updates cannot
    /// replace the entire engine through `from_settings`, which would silently revoke
    /// session grants and lose audit logs.
    pub fn refresh_persisted_settings(&mut self, settings: &Settings) {
        self.mode = settings.permission_mode;
        self.allowed_tools = settings.allowed_tools.clone();
        self.denied_tools = settings.denied_tools.clone();
        self.rules = settings.permission_rules.clone();
    }

    /// Enable an append-only audit log at the given path.
    pub fn with_audit_log(mut self, path: PathBuf) -> Self {
        self.audit = Some(PermissionAudit::new(path));
        self
    }

    /// Evaluate whether `tool` may be invoked with `input`.
    ///
    /// Callers should prompt when this returns [`PermissionDecision::Ask`].
    pub fn decide(&self, tool: &dyn Tool, input: &Value) -> PermissionDecision {
        self.evaluation().decide(&ToolSubject(tool), input)
    }

    /// Check envelope denials without granting execution or writing a synthetic decision audit.
    pub fn is_explicitly_denied(&self, name: &str, input: &Value) -> bool {
        self.evaluation().is_explicitly_denied(name, input)
    }

    /// Add a tool pattern to the session allow list.
    pub fn allow_for_session(&mut self, pattern: &str) {
        if !self.session_allowed.iter().any(|a| a == pattern) {
            self.session_allowed.push(pattern.to_string());
        }
        self.session_denied.retain(|d| d != pattern);
    }

    /// Add a tool pattern to the session deny list.
    pub fn deny_for_session(&mut self, pattern: &str) {
        if !self.session_denied.iter().any(|d| d == pattern) {
            self.session_denied.push(pattern.to_string());
        }
        self.session_allowed.retain(|a| a != pattern);
    }

    /// Remove a pattern from both persisted and session lists (used for /allow reset etc).
    pub fn clear_pattern(&mut self, pattern: &str) {
        self.allowed_tools.retain(|a| a != pattern);
        self.denied_tools.retain(|d| d != pattern);
        self.session_allowed.retain(|a| a != pattern);
        self.session_denied.retain(|d| d != pattern);
    }

    fn evaluation(&self) -> RuleEvaluation<'_> {
        RuleEvaluation {
            mode: self.mode,
            allowed_tools: &self.allowed_tools,
            denied_tools: &self.denied_tools,
            rules: &self.rules,
            session_allowed: &self.session_allowed,
            session_denied: &self.session_denied,
            session_rules: &self.session_rules,
            session_allowed_shell_prefixes: &self.session_allowed_shell_prefixes,
            audit: self.audit.as_ref(),
        }
    }
}

struct ToolSubject<'a>(&'a dyn Tool);

impl PermissionTool for ToolSubject<'_> {
    fn name(&self) -> String {
        self.0.name()
    }

    fn description(&self) -> String {
        self.0.description()
    }

    fn is_builtin(&self) -> bool {
        self.0.source() == kcoder_tools::ToolSource::Builtin
    }

    fn is_read_only(&self) -> bool {
        self.0.is_read_only()
    }
}

/// Build the permission prompt details for a tool and its input.
pub fn request_context_for(tool: &dyn Tool, input: &Value) -> PermissionRequestContext {
    kcoder_permission_rules::request_context_for(&ToolSubject(tool), input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_config::PermissionAction;
    use kcoder_tools::{ToolContext, ToolError, ToolOutput};
    use serde_json::json;

    struct DummyTool {
        name: &'static str,
        read_only: bool,
    }

    #[async_trait]
    impl Tool for DummyTool {
        fn name(&self) -> String {
            self.name.to_string()
        }

        fn description(&self) -> String {
            "dummy".to_string()
        }

        fn input_schema(&self) -> Value {
            json!({})
        }

        fn is_read_only(&self) -> bool {
            self.read_only
        }

        async fn call(&self, _input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
            Ok(ToolOutput::text(""))
        }
    }

    fn engine_with_mode(mode: PermissionMode) -> PermissionEngine {
        PermissionEngine {
            mode,
            ..PermissionEngine::default()
        }
    }

    #[test]
    fn denied_list_takes_precedence() {
        let mut engine = engine_with_mode(PermissionMode::Bypass);
        engine.allowed_tools.push("bash".into());
        engine.denied_tools.push("bash".into());
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };
        assert_eq!(engine.decide(&tool, &json!({})), PermissionDecision::Deny);
    }

    #[test]
    fn persisted_denied_list_takes_precedence_over_session_allow() {
        let mut engine = PermissionEngine::default();
        engine.denied_tools.push("bash".into());
        engine.session_allowed.push("bash".into());
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };
        assert_eq!(engine.decide(&tool, &json!({})), PermissionDecision::Deny);
    }

    #[test]
    fn tool_search_is_auto_approvable_state_but_explicit_denial_still_wins() {
        let mut engine = PermissionEngine {
            mode: PermissionMode::Auto,
            ..Default::default()
        };
        let tool = kcoder_tools::tool_search::ToolSearchTool;
        assert!(!tool.is_read_only());
        assert_eq!(
            engine.decide(&tool, &json!({"query":"mail"})),
            PermissionDecision::Allow
        );
        engine.deny_for_session("tool_search");
        assert_eq!(
            engine.decide(&tool, &json!({"query":"mail"})),
            PermissionDecision::Deny
        );
    }

    #[test]
    fn persisted_refresh_preserves_session_shell_and_audit_state() {
        let mut engine = PermissionEngine::default()
            .with_audit_log(std::env::temp_dir().join("kcoder-permission-refresh-audit.jsonl"));
        engine.allow_for_session("write");
        engine.session_denied.push("delete".into());
        engine.session_rules.push(PermissionRule {
            tool: "bash".into(),
            input_pattern: Some("cargo test".into()),
            action: PermissionAction::Allow,
        });
        engine
            .session_allowed_shell_prefixes
            .push("cargo test".into());

        let settings = Settings {
            permission_mode: PermissionMode::Yolo,
            allowed_tools: vec!["read".into()],
            denied_tools: vec!["network".into()],
            permission_rules: vec![PermissionRule {
                tool: "bash".into(),
                input_pattern: Some("rm -rf /".into()),
                action: PermissionAction::Deny,
            }],
            ..Settings::default()
        };
        engine.refresh_persisted_settings(&settings);

        assert_eq!(engine.mode, PermissionMode::Yolo);
        assert_eq!(engine.allowed_tools, vec!["read"]);
        assert_eq!(engine.denied_tools, vec!["network"]);
        assert_eq!(engine.rules, settings.permission_rules);
        assert_eq!(engine.session_allowed, vec!["write"]);
        assert_eq!(engine.session_denied, vec!["delete"]);
        assert_eq!(engine.session_rules.len(), 1);
        assert_eq!(engine.session_allowed_shell_prefixes, vec!["cargo test"]);
        assert!(engine.audit.is_some());
    }

    #[test]
    fn auto_allows_read_only_bash() {
        let engine = engine_with_mode(PermissionMode::Auto);
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };
        assert_eq!(
            engine.decide(&tool, &json!({"command": "ls -la"})),
            PermissionDecision::Allow
        );
        assert_eq!(
            engine.decide(&tool, &json!({"command": "rm -rf /"})),
            PermissionDecision::Ask
        );
        assert_eq!(
            engine.decide(&tool, &json!({"command": "ls -la && rm -rf /"})),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn role_grant_allows_common_validation_commands_but_not_chained_mutation() {
        let mut engine = engine_with_mode(PermissionMode::AcceptEdits);
        engine.session_allowed_shell_prefixes = [
            "cargo test",
            "cargo check",
            "cargo clippy",
            "pytest",
            "go test",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };
        for command in [
            "cargo test --workspace",
            "cargo check -p kcoder_engine",
            "cargo clippy --workspace",
            "pytest -q",
            "go test ./...",
        ] {
            assert_eq!(
                engine.decide(&tool, &json!({"command": command})),
                PermissionDecision::Allow,
                "{command}"
            );
        }
        assert_eq!(
            engine.decide(
                &tool,
                &json!({"command": "cargo test --workspace; rm -rf target"})
            ),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn auto_allows_read_only_powershell_but_prompts_for_mutation() {
        let engine = engine_with_mode(PermissionMode::Auto);
        let tool = DummyTool {
            name: "PowerShell",
            read_only: false,
        };
        for command in [
            "Get-ChildItem -Force",
            "Get-Content Cargo.toml | Select-Object -First 20",
        ] {
            assert_eq!(
                engine.decide(&tool, &json!({"command": command})),
                PermissionDecision::Allow,
                "{command}"
            );
        }
        assert_eq!(
            engine.decide(&tool, &json!({"command": "cargo test --workspace"})),
            PermissionDecision::Ask
        );
        for command in [
            "Remove-Item -Recurse target",
            "Get-ChildItem; Remove-Item secret.txt",
            "Set-Content out.txt value",
        ] {
            assert_eq!(
                engine.decide(&tool, &json!({"command": command})),
                PermissionDecision::Ask,
                "{command}"
            );
        }
    }

    #[test]
    fn default_engine_mode_is_ask() {
        let engine = PermissionEngine::default();
        assert_eq!(engine.mode, PermissionMode::Ask);

        let read_tool = DummyTool {
            name: "read",
            read_only: true,
        };
        assert_eq!(
            engine.decide(&read_tool, &json!({"file_path": "/tmp/a"})),
            PermissionDecision::Ask
        );

        let write_tool = DummyTool {
            name: "write",
            read_only: false,
        };
        assert_eq!(
            engine.decide(&write_tool, &json!({"file_path": "/tmp/a"})),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn structured_rule_with_input_pattern() {
        let mut engine = engine_with_mode(PermissionMode::Ask);
        engine.rules.push(PermissionRule {
            tool: "bash".into(),
            input_pattern: Some("rm -rf".into()),
            action: PermissionAction::Deny,
        });
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };
        assert_eq!(
            engine.decide(&tool, &json!({"command": "rm -rf /tmp"})),
            PermissionDecision::Deny
        );
        assert_eq!(
            engine.decide(&tool, &json!({"command": "ls /tmp"})),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn structured_deny_rule_matches_repeated_suffix() {
        let mut engine = engine_with_mode(PermissionMode::Auto);
        engine.rules.push(PermissionRule {
            tool: "bash".into(),
            input_pattern: Some("*test".into()),
            action: PermissionAction::Deny,
        });
        let tool = DummyTool {
            name: "bash",
            read_only: true,
        };
        assert_eq!(
            engine.decide(&tool, &json!({"command": "echo test foo test"})),
            PermissionDecision::Deny
        );
    }

    #[test]
    fn structured_rule_input_pattern_matches_values_not_json_keys() {
        let mut engine = engine_with_mode(PermissionMode::Ask);
        engine.rules.push(PermissionRule {
            tool: "bash".into(),
            input_pattern: Some("command".into()),
            action: PermissionAction::Deny,
        });
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };

        assert_eq!(
            engine.decide(&tool, &json!({"command": "ls /tmp"})),
            PermissionDecision::Ask
        );
        assert_eq!(
            engine.decide(&tool, &json!({"command": "echo command"})),
            PermissionDecision::Deny
        );
    }

    #[test]
    fn structured_rule_input_pattern_supports_field_match() {
        let mut engine = engine_with_mode(PermissionMode::Ask);
        engine.rules.push(PermissionRule {
            tool: "bash".into(),
            input_pattern: Some("command=rm -rf".into()),
            action: PermissionAction::Deny,
        });
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };

        assert_eq!(
            engine.decide(&tool, &json!({"command": "rm -rf /tmp"})),
            PermissionDecision::Deny
        );
        assert_eq!(
            engine.decide(&tool, &json!({"description": "rm -rf", "command": "ls"})),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn structured_shell_allow_rule_requires_the_complete_command() {
        let mut engine = engine_with_mode(PermissionMode::Ask);
        engine.rules.push(PermissionRule {
            tool: "bash".into(),
            input_pattern: Some("command=cargo test".into()),
            action: PermissionAction::Allow,
        });
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };

        assert_eq!(
            engine.decide(&tool, &json!({"command": "cargo test"})),
            PermissionDecision::Allow
        );
        assert_eq!(
            engine.decide(&tool, &json!({"command": "cargo test; rm -rf target"})),
            PermissionDecision::Ask
        );
        assert_eq!(
            engine.decide(&tool, &json!({"command": "cargo test --workspace"})),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn structured_deny_rule_takes_precedence_over_session_allow() {
        let mut engine = engine_with_mode(PermissionMode::Ask);
        engine.session_allowed.push("bash".into());
        engine.rules.push(PermissionRule {
            tool: "bash".into(),
            input_pattern: Some("command=rm -rf".into()),
            action: PermissionAction::Deny,
        });
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };

        assert_eq!(
            engine.decide(&tool, &json!({"command": "rm -rf /tmp"})),
            PermissionDecision::Deny
        );
    }

    #[test]
    fn wildcard_pattern() {
        let mut engine = PermissionEngine::default();
        engine.allowed_tools.push("file:*".into());
        let tool = DummyTool {
            name: "file:read",
            read_only: true,
        };
        assert_eq!(engine.decide(&tool, &json!({})), PermissionDecision::Allow);
    }

    #[test]
    fn classify_bash_commands() {
        assert!(classify_bash_read_only("ls -la"));
        // Even observational git commands may execute repository-controlled
        // fsmonitor, external-diff, or textconv helpers, so they require the
        // normal permission path rather than the global read-only bypass.
        assert!(!classify_bash_read_only("git status"));
        assert!(!classify_bash_read_only("git diff"));
        assert!(!classify_bash_read_only("git log -1"));
        assert!(!classify_bash_read_only("git show HEAD"));
        assert!(classify_bash_read_only("pwd"));
        assert!(!classify_bash_read_only("rm -rf /"));
        assert!(!classify_bash_read_only("docker build -t foo ."));
        assert!(!classify_bash_read_only("env perl -e 'unlink q(x)'"));
        assert!(!classify_bash_read_only("find . -exec rm {} +"));
        assert!(!classify_bash_read_only("rg --pre 'sh mutate.sh' needle"));
        assert!(!classify_bash_read_only("ls && rm -rf /tmp/x"));
        assert!(!classify_bash_read_only("cargo test"));
        assert!(!classify_bash_read_only("history -w /tmp/history"));
    }

    #[test]
    fn auto_shell_classification_uses_literal_arguments() {
        let tool = kcoder_tools::BashTool;
        let engine = engine_with_mode(PermissionMode::Auto);
        for command in [
            "file -C -m magic",
            "file '--compile' -m magic",
            "file -bC -m magic",
            "file --comp -m magic",
            "file -z sample.txt",
            "file --preserve-date sample.txt",
            "rg '--pre' helper needle",
            "rg \"--pre\" helper needle",
            "rg --p\\re helper needle",
            "rg --hostname-bin=helper needle",
            "rg '--hostname-bin' helper needle",
            "rg --unknown-future-option needle",
            "rg -z needle archive.gz",
            "rg $FLAGS needle",
            "rg \"$FLAGS\" needle",
            "rg $'--pre' helper needle",
            "cat\u{a0}other",
            "cat\rother",
        ] {
            assert!(!classify_bash_read_only(command), "{command}");
            assert_eq!(
                engine.decide(&tool, &json!({"command": command})),
                PermissionDecision::Ask,
                "{command}"
            );
        }
        for command in [
            "file sample.txt",
            "file -b --mime-type sample.txt",
            "rg -n 'a b' src",
            "rg --fixed-strings -- '--pre' sample.txt",
            "cat 'a b' | head -n 2",
            "'pwd'",
        ] {
            assert!(classify_bash_read_only(command), "{command}");
            assert_eq!(
                engine.decide(&tool, &json!({"command": command})),
                PermissionDecision::Allow,
                "{command}"
            );
        }
    }

    #[test]
    fn shell_argument_classification_preserves_explicit_authorization() {
        let tool = kcoder_tools::BashTool;
        let input = json!({"command": "file --compile -m magic"});
        for mode in [PermissionMode::Yolo, PermissionMode::Bypass] {
            let mut engine = engine_with_mode(mode);
            assert_eq!(engine.decide(&tool, &input), PermissionDecision::Allow);
            engine.denied_tools.push("bash".into());
            assert_eq!(engine.decide(&tool, &input), PermissionDecision::Deny);
        }
    }

    #[test]
    fn shell_role_prefix_uses_bash_word_boundaries() {
        let tool = kcoder_tools::BashTool;
        let mut engine = engine_with_mode(PermissionMode::Auto);
        engine
            .session_allowed_shell_prefixes
            .push("docker exec exact".into());
        assert_eq!(
            engine.decide(&tool, &json!({"command": "docker exec exact true"})),
            PermissionDecision::Allow
        );
        for command in [
            "docker exec exact\u{a0}other true",
            "\u{a0}docker exec exact true",
            "docker exec exact\rother true",
        ] {
            assert_eq!(
                engine.decide(&tool, &json!({"command": command})),
                PermissionDecision::Ask,
                "{command:?}"
            );
        }
    }

    #[test]
    fn validation_commands_require_explicit_role_session_grant() {
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };
        let auto = engine_with_mode(PermissionMode::Auto);
        assert_eq!(
            auto.decide(&tool, &json!({"command": "cargo test -p example"})),
            PermissionDecision::Ask
        );

        let mut verifier = engine_with_mode(PermissionMode::AcceptEdits);
        verifier.session_allowed_shell_prefixes =
            vec!["cargo test".to_string(), "pytest".to_string()];
        assert_eq!(
            verifier.decide(&tool, &json!({"command": "cargo test -p example"})),
            PermissionDecision::Allow
        );
        assert_eq!(
            verifier.decide(
                &tool,
                &json!({"command": "cargo test -p example && rm -rf /tmp/x"})
            ),
            PermissionDecision::Ask
        );
        assert_eq!(
            verifier.decide(
                &tool,
                &json!({"command": "cargo test -p example & rm -rf /tmp/x"})
            ),
            PermissionDecision::Ask
        );
        let powershell = DummyTool {
            name: "PowerShell",
            read_only: false,
        };
        assert_eq!(
            verifier.decide(
                &powershell,
                &json!({"command": "cargo test -p example & Remove-Item victim"})
            ),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn powershell_classifier_is_exact_not_generic_verb_based() {
        assert!(classify_powershell_read_only(
            "Get-ChildItem . | Select-Object Name"
        ));
        assert!(!classify_powershell_read_only("Get-EvilThing -Run payload"));
        assert!(!classify_powershell_read_only(
            "Get-ChildItem .; Remove-Item victim"
        ));
        assert!(!classify_powershell_read_only(
            "Write-Output (Remove-Item victim)"
        ));
        assert!(!classify_powershell_read_only(
            "Write-Output (& { Remove-Item victim })"
        ));
        assert!(!classify_powershell_read_only(
            "Write-Output ([IO.File]::WriteAllText('victim','x'))"
        ));
    }

    #[test]
    fn request_context_flags_high_risk_bash() {
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };
        let ctx = request_context_for(&tool, &json!({"command": "rm -rf /tmp"}));
        assert_eq!(ctx.risk, PermissionRisk::High);
        assert!(ctx.detail_lines.iter().any(|l| l.contains("rm -rf")));
    }

    #[test]
    fn request_context_read_only_bash_is_safe() {
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };
        let ctx = request_context_for(&tool, &json!({"command": "ls -la"}));
        assert_eq!(ctx.risk, PermissionRisk::None);
    }

    #[test]
    fn ocr_preview_is_auto_allowed_but_full_review_requires_prompt() {
        let engine = PermissionEngine {
            mode: PermissionMode::Auto,
            ..PermissionEngine::default()
        };
        let tool = DummyTool {
            name: "ocr",
            read_only: false,
        };

        assert_eq!(
            engine.decide(&tool, &json!({"command": "review", "preview": true})),
            PermissionDecision::Allow
        );
        assert_eq!(
            engine.decide(&tool, &json!({"command": "review", "preview": false})),
            PermissionDecision::Ask
        );
        assert_eq!(
            engine.decide(&tool, &json!({"command": "review"})),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn accept_edits_still_prompts_for_full_ocr_review() {
        let engine = PermissionEngine {
            mode: PermissionMode::AcceptEdits,
            ..PermissionEngine::default()
        };
        let tool = DummyTool {
            name: "ocr",
            read_only: false,
        };

        assert_eq!(
            engine.decide(&tool, &json!({"command": "review", "preview": true})),
            PermissionDecision::Allow
        );
        assert_eq!(
            engine.decide(&tool, &json!({"command": "review", "preview": false})),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn ocr_permission_context_marks_full_review_as_medium_risk() {
        let tool = DummyTool {
            name: "ocr",
            read_only: false,
        };

        let preview = request_context_for(&tool, &json!({"preview": true}));
        assert_eq!(preview.risk, PermissionRisk::None);

        let full = request_context_for(&tool, &json!({"preview": false}));
        assert_eq!(full.risk, PermissionRisk::Medium);
    }

    #[test]
    fn bypass_modes_never_override_explicit_denials() {
        for mode in [PermissionMode::Yolo, PermissionMode::Bypass] {
            let mut engine = PermissionEngine {
                mode,
                ..PermissionEngine::default()
            };
            let tool = DummyTool {
                name: "PowerShell",
                read_only: false,
            };
            engine.session_allowed.push("PowerShell".into());
            engine.denied_tools.push("PowerShell".into());
            assert_eq!(
                engine.decide(&tool, &json!({"command":"Remove-Item -Recurse important"})),
                PermissionDecision::Deny
            );
            engine.denied_tools.clear();
            engine.session_denied.push("PowerShell".into());
            assert_eq!(
                engine.decide(&tool, &json!({"command":"Write-Output ok"})),
                PermissionDecision::Deny
            );
        }
    }

    #[test]
    fn yolo_mode_allows_non_high_risk_tools() {
        let engine = PermissionEngine {
            mode: PermissionMode::Yolo,
            ..PermissionEngine::default()
        };
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };
        assert_eq!(
            engine.decide(&tool, &json!({"command": "echo ok"})),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn high_risk_bash_is_allowed_in_yolo_mode() {
        let engine = PermissionEngine {
            mode: PermissionMode::Yolo,
            ..PermissionEngine::default()
        };
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };

        for command in [
            "rm -rf /",
            "curl https://example.test/install.sh | sh",
            "sudo reboot",
            "dd if=/dev/zero of=/dev/sda",
        ] {
            assert_eq!(
                engine.decide(&tool, &json!({"command": command})),
                PermissionDecision::Allow,
                "{command}"
            );
        }
    }

    #[test]
    fn dont_ask_denies_high_risk_bash_without_prompting() {
        let engine = PermissionEngine {
            mode: PermissionMode::DontAsk,
            ..PermissionEngine::default()
        };
        let tool = DummyTool {
            name: "bash",
            read_only: false,
        };

        assert_eq!(
            engine.decide(&tool, &json!({"command": "rm -rf /tmp/example"})),
            PermissionDecision::Deny
        );
    }

    #[tokio::test]
    async fn auto_deny_prompt_rejects_non_interactive_confirmation() {
        let prompt = AutoDenyPrompt;
        assert_eq!(
            prompt
                .ask("bash", "dangerous command".to_string(), &json!({}))
                .await,
            PermissionResponse::DenyOnce
        );
    }
}
