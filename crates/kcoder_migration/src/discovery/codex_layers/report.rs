use super::*;
pub(super) const UNOBSERVED: [&str; 5] = [
    "command_line_overrides",
    "source_process_environment",
    "system_cloud_managed_defaults",
    "managed_requirements",
    "separate_mcp_namespaces",
];
impl CodexLayersBinding {
    pub(crate) fn snapshot_report(&self) -> Result<Option<CodexLayerReport>> {
        let Some(report) = &self.snapshot_report else {
            return Ok(None);
        };
        let expected = std::iter::once(self.user.present())
            .chain(self.profile.iter().map(|_| true))
            .chain(self.projects.iter().map(Layer::present))
            .collect::<Vec<_>>();
        ensure!(
            self.version == 1
                && !self.projects.is_empty()
                && self.projects.len() <= MAX_LAYERS
                && report.profile_selected == self.profile.is_some()
                && report.present == expected
                && report.fields.len() <= 1024
                && report.unobserved.iter().map(String::as_str).eq(UNOBSERVED),
            "migration_invalid_source_binding"
        );
        for field in &report.fields {
            ensure!(
                report.present.get(field.layer as usize) == Some(&true)
                    && field.provider_index.is_none_or(|index| index < 1024),
                "migration_invalid_source_binding"
            );
            ensure!(
                field.field.as_deref().is_none_or(|name| matches!(
                    name,
                    "/model"
                        | "/model_context_window"
                        | "/model_reasoning_effort"
                        | "/model_provider"
                        | "/model_providers"
                        | "/project_root_markers"
                        | "/profile"
                        | "/profiles"
                        | "/projects"
                        | "/openai_base_url"
                        | "/chatgpt_base_url"
                        | "/apps_mcp_product_sku"
                        | "/notify"
                        | "/otel"
                        | "/experimental_realtime_ws_base_url"
                        | "/mcp_servers"
                        | "/hooks"
                        | "/permissions"
                        | "/sandbox_mode"
                        | "/approval_policy"
                        | "/model_instructions_file"
                        | "/model_providers/name"
                        | "/model_providers/base_url"
                        | "/model_providers/wire_api"
                        | "/model_providers/env_key"
                        | "/model_providers/requires_openai_auth"
                        | "/model_providers/auth"
                        | "/model_providers/experimental_bearer_token"
                        | "/model_providers/http_headers"
                        | "/model_providers/env_http_headers"
                )),
                "migration_invalid_source_binding"
            );
        }
        Ok(Some(report.clone()))
    }
}
