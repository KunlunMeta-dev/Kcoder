//! Consent refers only to reviewed source slots; this client never accepts secret values.
use super::*;
use kcoder_app_protocol::{
    MigrationApiKeySource, MigrationBatchCredentialChoice, MigrationBatchMcpCredentialChoice,
};
use kcoder_types::migration::{MigrationMcpPrivateField, MigrationSourceKind};

#[derive(Default)]
pub(super) struct Consents {
    pub providers: BTreeMap<String, MigrationBatchCredentialChoice>,
    pub mcps: BTreeMap<String, MigrationBatchMcpCredentialChoice>,
}
impl Consents {
    pub fn remove(&mut self, id: &str) {
        self.providers.remove(id);
        self.mcps.remove(id);
    }
    pub fn provider(
        &mut self,
        guide: &Guide<'_>,
        job: &MigrationJob,
        item: &NormalizedItem,
    ) -> Result<()> {
        self.providers.remove(&item.preview.id);
        if !guide.io.yes("credential_consent","是否明确授权迁移该连接来源已声明的 API key？将进入目标配置的凭证库；不读取登录缓存，不输入密钥正文。")? {return Ok(());}
        let source_kind = job
            .batch
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?
            .source_for(&item.preview.id)?
            .kind();
        let source = if source_kind == MigrationSourceKind::Codex {
            ensure!(
                item.provider
                    .as_ref()
                    .is_some_and(|p| p.credential_environment.is_some()),
                "migration_credential_source_not_declared"
            );
            MigrationApiKeySource::Environment
        } else {
            match guide.io.text("credential_source","选择密钥来源：configuration（Claude 已声明配置）或 environment（已声明环境变量）",Some("configuration"))?.as_str() {
                "configuration"=>MigrationApiKeySource::Configuration,"environment"=>MigrationApiKeySource::Environment,_=>anyhow::bail!("migration_guide_invalid_credential_source"),
            }
        };
        // Native selector validation rejects undeclared environment names and unavailable sources.
        crate::migration_input::selector(job, &item.preview.id, source)?;
        self.providers.insert(
            item.preview.id.clone(),
            MigrationBatchCredentialChoice {
                item_id: item.preview.id.clone(),
                source,
                consent_api_key: true,
            },
        );
        Ok(())
    }
    pub fn mcp(&mut self, guide: &Guide<'_>, item: &NormalizedItem) -> Result<()> {
        self.mcps.remove(&item.preview.id);
        let mcp = item
            .mcp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        let fields = mcp
            .config
            .policy
            .required_env
            .iter()
            .cloned()
            .map(MigrationMcpPrivateField::Environment)
            .chain(
                mcp.config
                    .policy
                    .required_headers
                    .iter()
                    .cloned()
                    .map(MigrationMcpPrivateField::Header),
            )
            .collect::<Vec<_>>();
        if fields.is_empty() {
            return Ok(());
        }
        let mut selected = Vec::new();
        for field in fields {
            guide.io.state("private_field", &field)?;
            if guide.io.yes("mcp_private_consent","是否明确授权迁移该来源已声明私有字段？仅显示字段名，不显示/输入值；未选字段不会转存。")? {selected.push(field);}
        }
        if !selected.is_empty() {
            self.mcps.insert(
                item.preview.id.clone(),
                MigrationBatchMcpCredentialChoice {
                    item_id: item.preview.id.clone(),
                    fields: selected,
                    consent_private_values: true,
                },
            );
        }
        Ok(())
    }
}
