//! Destination consent is independent of source project discovery.
use super::*;
use crate::cli_args::MigrationSettingsScope;
use serde_json::json;

pub(super) fn choose(
    guide: &Guide<'_>,
    args: &MigrationGuideArgs,
) -> Result<MigrationSettingsScope> {
    let selected = match args.target_scope {
        Some(scope) => scope,
        None => loop {
            match guide.io.ask("target_settings_scope", "明确选择设置写入范围：user 用户配置；current_workspace 当前受信任工作区设置。来源 --project 不决定目标；资产保留其独立映射。保留已生效连接及默认模型；必要时计划会显式保留公开内置连接。首次声明项目MCP时将单独确认保留的继承名单；项目凭据和模板仍按原生护栏明确拒绝，不能回落用户层。", json!([
                {"value":"user","label":"用户配置（保留原默认模型）"},
                {"value":"current_workspace","label":"当前受信任工作区的设置"}
            ]), Some("user"))?.as_str() {
                "user" => break MigrationSettingsScope::User,
                "current_workspace" | "current-workspace" => break MigrationSettingsScope::CurrentWorkspace,
                _ => guide.io.notice("migration_guide_invalid_selection", "请选择 user 或 current_workspace；未创建迁移记录。")?,
            }
        },
    };
    if matches!(selected, MigrationSettingsScope::CurrentWorkspace) {
        let context = guide.fresh()?;
        ensure!(
            kcoder_config::FolderTrustStore::load(&context.profile).check(&context.cwd)
                == kcoder_config::FolderTrust::Trusted,
            "migration_project_target_untrusted"
        );
    }
    Ok(selected)
}

pub(super) fn save(
    guide: &Guide<'_>,
    inputs: Vec<kcoder_migration::batch::BatchSource>,
    scope: MigrationSettingsScope,
) -> Result<MigrationJob> {
    let context = guide.fresh()?;
    let store = MigrationStore::open_or_create(&context.profile)?;
    match (scope, guide.initial_resources.clone()) {
        (MigrationSettingsScope::User, Some(limits)) => {
            store.create_batch_scan_with_resource_limits(inputs, limits)
        }
        (MigrationSettingsScope::User, None) => store.create_batch_scan(inputs),
        (MigrationSettingsScope::CurrentWorkspace, Some(limits)) => {
            store.create_batch_scan_in_project_with_resource_limits(inputs, &context.cwd, limits)
        }
        (MigrationSettingsScope::CurrentWorkspace, None) => {
            store.create_batch_scan_in_project(inputs, &context.cwd)
        }
    }
}
