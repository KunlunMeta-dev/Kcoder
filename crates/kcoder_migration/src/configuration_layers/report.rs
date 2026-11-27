//! Only bounded predefined metadata can leave a private persisted binding.
use super::*;

pub(super) const UNOBSERVED: [&str; 5] = [
    "managed_settings",
    "command_line_settings",
    "source_process_environment",
    "git_worktree_local_routing",
    "separate_mcp_namespaces",
];

impl ConfigurationLayersBinding {
    pub(crate) fn snapshot_report(&self) -> Result<Option<ConfigurationLayerReport>> {
        self.validate()?;
        let Some(report) = &self.snapshot_report else {
            return Ok(None);
        };
        ensure!(
            report.adapter_revision == CLAUDE_LAYERS_REVISION
                && report.layers
                    == self
                        .layers
                        .iter()
                        .map(|layer| ConfigurationLayerState {
                            scope: layer.scope(),
                            present: layer.present(),
                        })
                        .collect::<Vec<_>>()
                && report.fields.len() <= MAX_FIELDS
                && report.unobserved.iter().map(String::as_str).eq(UNOBSERVED),
            "migration_invalid_source_binding"
        );
        for (index, field) in report.fields.iter().enumerate() {
            ensure!(
                field.ordinal == index as u32
                    && !field.scopes.is_empty()
                    && field.scopes.len() <= 3
                    && field.scopes.iter().enumerate().all(|(at, scope)| {
                        report
                            .layers
                            .iter()
                            .any(|layer| layer.scope == *scope && layer.present)
                            && !field.scopes[..at].contains(scope)
                    }),
                "migration_invalid_source_binding"
            );
            let supported = match field.field.as_deref() {
                Some(
                    "/model"
                    | "/$schema"
                    | "/env"
                    | "/env/ANTHROPIC_MODEL"
                    | "/env/ANTHROPIC_BASE_URL"
                    | "/env/ANTHROPIC_API_KEY",
                ) => true,
                None
                | Some(
                    "/env/ANTHROPIC_AUTH_TOKEN"
                    | "/env/CLAUDE_CODE_OAUTH_TOKEN"
                    | "/apiKeyHelper"
                    | "/hooks"
                    | "/permissions"
                    | "/mcpServers",
                ) => false,
                _ => anyhow::bail!("migration_invalid_source_binding"),
            };
            ensure!(
                supported == field.supported,
                "migration_invalid_source_binding"
            );
        }
        Ok(Some(report.clone()))
    }
}
