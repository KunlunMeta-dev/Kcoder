//! Provider and MCP edits share one settings transaction and an immutable revision chain.
use super::BatchResolution;
use crate::{
    NormalizedItem,
    mcp::{McpPlan, McpTarget},
    providers::{ProviderPlan, ProviderPublication, ProviderTarget, revision},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
mod atomic;
mod credential;
pub(crate) use atomic::AtomicSettings;
pub(crate) use credential::AtomicCredential;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "plan",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum SettingsStep {
    Provider(Box<ProviderPlan>),
    Mcp(Box<McpPlan>),
}
impl SettingsStep {
    fn before(&self) -> &str {
        match self {
            Self::Provider(plan) => &plan.expected_revision,
            Self::Mcp(plan) => &plan.expected_revision,
        }
    }
    fn after(&self) -> &str {
        match self {
            Self::Provider(plan) => &plan.published_revision,
            Self::Mcp(plan) => &plan.published_revision,
        }
    }
    pub fn item(&self) -> &NormalizedItem {
        match self {
            Self::Provider(plan) => plan.item(),
            Self::Mcp(plan) => plan.item(),
        }
    }
    pub fn target_name(&self) -> &str {
        match self {
            Self::Provider(plan) => plan.target_name(),
            Self::Mcp(plan) => &plan.config().name,
        }
    }
    fn insert(&self, current: &mut Value) -> Result<()> {
        ensure!(revision(current) == self.before(), "migration_plan_changed");
        match self {
            Self::Provider(plan) => crate::providers::insert_planned_provider(current, plan)?,
            Self::Mcp(plan) => crate::mcp::insert(current, plan)?,
        }
        ensure!(revision(current) == self.after(), "migration_plan_changed");
        Ok(())
    }
    pub(crate) fn rebase(&mut self, current: &mut Value) -> Result<()> {
        let before = revision(current);
        match self {
            Self::Provider(plan) => {
                plan.expected_revision = before;
                crate::providers::insert_planned_provider(current, plan)?;
                plan.published_revision = revision(current);
            }
            Self::Mcp(plan) => {
                plan.expected_revision = before;
                crate::mcp::insert(current, plan)?;
                plan.published_revision = revision(current);
            }
        }
        Ok(())
    }
    fn remove(&self, current: &mut Value) -> Result<()> {
        ensure!(revision(current) == self.after(), "migration_plan_changed");
        match self {
            Self::Provider(plan) => crate::providers::remove_import(current, plan)?,
            Self::Mcp(plan) => crate::mcp::remove_import(current, plan)?,
        }
        ensure!(revision(current) == self.before(), "migration_plan_changed");
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsGroupPlan {
    pub steps: Vec<SettingsStep>,
}
impl SettingsGroupPlan {
    pub fn prepare(
        provider: &ProviderTarget,
        mcp: &McpTarget,
        items: &[(NormalizedItem, BatchResolution)],
    ) -> Result<Self> {
        Self::prepare_with_private(
            provider,
            mcp,
            items,
            &std::collections::BTreeSet::new(),
            &[],
        )
    }

    pub(crate) fn prepare_with_private(
        provider: &ProviderTarget,
        mcp: &McpTarget,
        items: &[(NormalizedItem, BatchResolution)],
        private_ids: &std::collections::BTreeSet<&str>,
        amendments: &[McpPlan],
    ) -> Result<Self> {
        ensure!(
            provider.settings_target_id() == mcp.settings_target_id(),
            "migration_wrong_target"
        );
        ensure!(
            !items.is_empty() || !amendments.is_empty(),
            "migration_batch_budget_exceeded"
        );
        ensure!(
            items.len().saturating_add(amendments.len()) <= 1024,
            "migration_batch_budget_exceeded"
        );
        let mut current = provider.read_settings()?;
        let mut steps = Vec::new();
        for (item, resolution) in items {
            let step = match resolution {
                BatchResolution::Provider(value) => {
                    SettingsStep::Provider(Box::new(provider.prepare_on(item, value, &current)?))
                }
                BatchResolution::Mcp(value) => {
                    let mut preflight = value.clone();
                    if private_ids.contains(value.item_id.as_str()) {
                        preflight.enable_after_import = false;
                    }
                    let mut plan = mcp.prepare_on(item, &preflight, &current)?;
                    plan.enable_after_import = value.enable_after_import;
                    SettingsStep::Mcp(Box::new(plan))
                }
                _ => anyhow::bail!("migration_invalid_batch_resolution"),
            };
            let mut step = step;
            step.rebase(&mut current)?;
            steps.push(step);
        }
        for amendment in amendments {
            let mut step = SettingsStep::Mcp(Box::new(amendment.clone()));
            step.rebase(&mut current)?;
            steps.push(step);
        }
        Ok(Self { steps })
    }
    fn check(&self, provider: &ProviderTarget, mcp: &McpTarget) -> Result<()> {
        ensure!(!self.steps.is_empty(), "migration_invalid_journal");
        ensure!(
            provider.settings_target_id() == mcp.settings_target_id(),
            "migration_wrong_target"
        );
        for step in &self.steps {
            match step {
                SettingsStep::Provider(plan) => provider.check_binding(plan)?,
                SettingsStep::Mcp(plan) => mcp.check_binding(plan)?,
            }
        }
        Ok(())
    }
    pub fn publish(
        &self,
        provider: &ProviderTarget,
        mcp: &McpTarget,
        cancelled: bool,
        source_blocked: bool,
        reconcile_only: bool,
    ) -> Result<ProviderPublication> {
        self.check(provider, mcp)?;
        let first = &self.steps[0];
        let last = self.steps.last().unwrap();
        let mut owned = false;
        let catalog = self.steps.iter().find_map(|step| match step {
            SettingsStep::Provider(plan) => plan.project_catalog.as_ref(),
            _ => None,
        });
        let mcp_catalog = self.steps.iter().find_map(|step| match step {
            SettingsStep::Mcp(plan) => plan
                .project_inheritance
                .as_ref()
                .map(|value| value.selection()),
            _ => None,
        });
        provider
            .update_settings_with_catalogs(catalog, mcp_catalog, |current| {
                if revision(current) == last.after() {
                    return Ok(());
                }
                ensure!(
                    !reconcile_only,
                    "migration_unconfirmed_publication_requires_replanning"
                );
                ensure!(!cancelled, "migration_cancelled_unsettled_publication");
                ensure!(!source_blocked, "migration_source_changed");
                ensure!(
                    revision(current) == first.before(),
                    "migration_target_changed"
                );
                for step in &self.steps {
                    match step {
                        SettingsStep::Provider(plan) => {
                            provider.check_publication_requirements(plan)?
                        }
                        SettingsStep::Mcp(plan) if plan.enabled() => {
                            kcoder_mcp_policy::validate_references(plan.config()).map_err(|_| {
                                anyhow::anyhow!("migration_mcp_credentials_required")
                            })?
                        }
                        _ => {}
                    }
                    step.insert(current)?;
                }
                owned = true;
                Ok(())
            })
            .map_err(safe_error)?;
        let target_id = match first {
            SettingsStep::Provider(plan) => plan.target_id.clone(),
            SettingsStep::Mcp(plan) => plan.target_id.clone(),
        };
        Ok(ProviderPublication {
            target_id,
            target_revision: last.after().into(),
            ownership_confirmed: owned,
        })
    }
    pub fn rollback(&self, provider: &ProviderTarget, mcp: &McpTarget) -> Result<()> {
        self.check(provider, mcp)?;
        if revision(&provider.read_settings()?) == self.steps[0].before() {
            return Ok(());
        }
        let names = self
            .steps
            .iter()
            .filter_map(|step| match step {
                SettingsStep::Provider(plan) => Some(plan.target_name()),
                _ => None,
            })
            .collect::<Vec<_>>();
        provider
            .template_dependencies()
            .with_unreferenced_providers(&names, || {
                provider
                    .update_settings(|current| {
                        for step in &self.steps {
                            if let SettingsStep::Provider(plan) = step {
                                provider.require_no_credential_dependency(plan)?;
                            }
                        }
                        if revision(current) == self.steps[0].before() {
                            return Ok(());
                        }
                        ensure!(
                            revision(current) == self.steps.last().unwrap().after(),
                            "migration_target_changed"
                        );
                        for step in self.steps.iter().rev() {
                            step.remove(current)?;
                        }
                        Ok(())
                    })
                    .map_err(safe_error)
            })
    }
}
fn safe_error(error: anyhow::Error) -> anyhow::Error {
    let code = error.to_string();
    if code == "settings_busy" {
        return anyhow::anyhow!("migration_settings_busy");
    }
    if code.starts_with("migration_")
        && code.len() < 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        anyhow::anyhow!(code)
    } else {
        anyhow::anyhow!("migration_settings_publication_unconfirmed")
    }
}
