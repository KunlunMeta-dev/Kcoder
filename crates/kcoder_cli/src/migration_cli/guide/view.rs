//! Terminal pages omit MCP private maps and credential references even when native DTOs include them.
use super::*;
use serde_json::{Value, json};

pub(super) fn summary(job: &MigrationJob) -> Value {
    let result = crate::migration_view::read_result(job);
    let scope = job
        .project_target()
        .map(|project| json!({"kind":"current_workspace","workspace":project.root()}))
        .unwrap_or_else(|| json!({"kind":"user"}));
    json!({"job":result.job,"batch":result.batch,"source":result.source,"issues":result.issues,"targetSettingsScope":scope})
}
pub(super) fn plans(
    store: &MigrationStore,
    job: &MigrationJob,
    page: usize,
    profile: &Path,
) -> Result<Value> {
    let start = page
        .checked_mul(10)
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_cursor"))?;
    ensure!(
        start <= job.inventory.items.len(),
        "migration_invalid_cursor"
    );
    let all_credentials = crate::migration_view::read_result(job).credential_plans;
    let mut items = Vec::new();
    for item in job.inventory.items.iter().skip(start).take(10) {
        if crate::migration_view::item_summary(job, &item.preview.id).is_none() {
            continue;
        }
        let details = crate::migration_view::batch_item_plan(store, job, &item.preview.id, true)?;
        let plugin = match job
            .batch
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?
            .source_for(&item.preview.id)?
        {
            kcoder_migration::batch::BatchSource::Plugin(source) => {
                let store =
                    kcoder_migration::plugin_migration::PluginMigrationStore::open_existing(
                        profile,
                    )?
                    .ok_or_else(|| anyhow::anyhow!("plugin_migration_store_missing"))?;
                Some(super::super::plugin::public(&store.read(
                    source.operation_id(),
                    &kcoder_plugins::PluginCancellationToken::default(),
                )?))
            }
            _ => None,
        };
        let mcp=details.mcp.as_ref().map(|config|json!({
            "name":config.name,"transport":config.transport,"command":config.command,"url":config.url,
            "argumentCount":config.args.len(),"cwd":config.policy.cwd,
            "requiredEnvironmentNames":config.policy.required_env,"requiredHeaderNames":config.policy.required_headers,
        }));
        let credentials=all_credentials.iter().filter(|p|p.item_id==item.preview.id).map(|p|json!({"source":p.source,"sourceField":p.source_field,"storage":p.storage,"phase":p.phase,"errorCode":p.error_code})).collect::<Vec<_>>();
        items.push(json!({"item":details.item,"provider":details.provider,"mcp":mcp,"template":details.template,"credentials":credentials,"plugin":plugin}));
    }
    Ok(
        json!({"jobId":job.job_id,"sequence":job.sequence,"pageIndex":page,"hasNextPage":start+10<job.inventory.items.len(),"items":items}),
    )
}
