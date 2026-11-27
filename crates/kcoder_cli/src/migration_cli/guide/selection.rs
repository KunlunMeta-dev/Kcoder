//! Public item choices remain separate from immutable source bindings and credential values.
use super::*;
use kcoder_app_protocol::{MigrationBatchChoice as Choice, MigrationBatchPlanParams};
use kcoder_migration::NormalizedItem;
use kcoder_types::migration::MigrationCategory;
use serde_json::json;
use std::collections::BTreeMap;
#[path = "selection/agents.rs"]
mod agents;
#[path = "selection/credentials.rs"]
mod credentials;
use credentials::Consents;

pub(super) struct Selection<'a> {
    pub params: MigrationBatchPlanParams,
    pub project_host: Option<super::projects::Session<'a>>,
}
pub(super) fn choose<'a>(
    guide: &'a Guide<'a>,
    job: &MigrationJob,
) -> Result<Option<Selection<'a>>> {
    ensure!(
        job.batch
            .as_ref()
            .is_some_and(|batch| batch.plan_id.is_none()),
        "migration_plan_already_exists"
    );
    let mut choices = BTreeMap::<String, Choice>::new();
    let mut consents = Consents::default();
    let mut project_host = None;
    let mut page = 0usize;
    loop {
        guide.io.active()?;
        let start = page * 10;
        let rows=job.inventory.items.iter().skip(start).take(10).enumerate().map(|(index,item)|{
            let plugin=job.batch.as_ref().is_some_and(|batch|matches!(batch.source_for(&item.preview.id),Ok(kcoder_migration::batch::BatchSource::Plugin(_))));
            let mapping_kind=if item.preview.category==MigrationCategory::Project{"project"}else if plugin{"plugin"}else if item.preview.category==MigrationCategory::History{"history"}else if item.template.is_some(){"template"}else if item.provider.is_some(){"provider"}else if item.mcp.is_some(){"mcp"}else if item.asset.is_some(){"asset"}else{"unsupported"};
            json!({"number":index+1,"mappingKind":mapping_kind,"item":item.preview,"selected":choices.contains_key(&item.preview.id)})
        }).collect::<Vec<_>>();
        let command=guide.io.ask("selection","Up to 10 items per page. toggle N selects/deselects; edit N maps; details N views; next/prev changes pages; preview generates a preview; quit returns.",json!({"page":page,"pages":job.inventory.items.len().div_ceil(10),"selected":choices.len(),"items":rows}),None)?;
        let mut words = command.split_whitespace();
        match words.next().unwrap_or("") {
            "quit" => return Ok(None),
            "next" if start + 10 < job.inventory.items.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            "preview" => {
                ensure!(!choices.is_empty(), "migration_guide_no_selection");
                let project_mcp_inheritance =
                    super::project_mcp::choose(guide, job, choices.values())?;
                let reuse_existing = guide.io.yes(
                    "reuse",
                    "Reuse previously confirmed results whose target content is unchanged? This does not add new secrets.",
                )?;
                return Ok(Some(Selection {
                    project_host,
                    params: MigrationBatchPlanParams {
                        job_id: job.job_id.clone(),
                        expected_sequence: job.sequence,
                        choices: choices.into_values().collect(),
                        include_default_items: false,
                        excluded_item_ids: Vec::new(),
                        reuse_existing,
                        credentials: consents.providers.into_values().collect(),
                        mcp_credentials: consents.mcps.into_values().collect(),
                        project_mcp_inheritance,
                    },
                }));
            }
            verb @ ("toggle" | "edit" | "details") => {
                let local = words
                    .next()
                    .and_then(|n| n.parse::<usize>().ok())
                    .filter(|n| (1..=10).contains(n));
                let Some(item) = local.and_then(|n| job.inventory.items.get(start + n - 1)) else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "Select an item number on the current page.",
                    )?;
                    continue;
                };
                if verb == "details" {
                    let mut result = crate::migration_view::items_result(job, None, Some(page))?;
                    crate::migration_view::include_template_candidates(job, &mut result);
                    guide.io.state("items", &result)?;
                    continue;
                }
                if verb == "toggle" && choices.remove(&item.preview.id).is_some() {
                    consents.remove(&item.preview.id);
                    continue;
                }
                match configure(
                    guide,
                    job,
                    item,
                    &mut choices,
                    &mut consents,
                    &mut project_host,
                ) {
                    Ok(choice) => {
                        choices.insert(item.preview.id.clone(), choice);
                    }
                    Err(error) => guide.io.notice(
                        &safe_error(&error),
                        "This item is not selected yet. Review its issues and explicitly correct them; sources and configuration are not replaced automatically.",
                    )?,
                }
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "Unrecognized selection; the target was not changed.",
            )?,
        }
    }
}
fn optional(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}
fn name(guide: &Guide<'_>, job: &MigrationJob, item: &NormalizedItem) -> Result<String> {
    let proposed = kcoder_migration::batch::proposed_name(job, item)?;
    let plugin = item.preview.category == MigrationCategory::Plugin;
    let value = guide.io.text(
        if plugin {"plugin_target_name"} else {"target_name"},
        if plugin {"Plugin installation identifier (actual runtime namespace, not the manifest display title; explicitly rename on conflict rather than overwriting existing results)"} else {"Target name (explicitly rename on conflict; existing results are not overwritten)"},
        Some(&proposed),
    )?;
    ensure!(
        !value.is_empty() && value.len() <= 256,
        "migration_guide_invalid_target_name"
    );
    Ok(value)
}
fn configure<'a>(
    guide: &'a Guide<'a>,
    job: &MigrationJob,
    item: &NormalizedItem,
    selected: &mut BTreeMap<String, Choice>,
    consents: &mut Consents,
    project_host: &mut Option<super::projects::Session<'a>>,
) -> Result<Choice> {
    guide.io.state("item", &item.preview)?;
    if item.preview.category == MigrationCategory::Project {
        if project_host.is_none() {
            *project_host = Some(super::projects::Session::open(guide)?);
        }
        return project_host
            .as_mut()
            .unwrap()
            .choice(&job.job_id, &item.preview.id);
    }
    if item.preview.category == MigrationCategory::History {
        return Ok(Choice::History {
            item_id: item.preview.id.clone(),
        });
    }
    if item.preview.category == MigrationCategory::Plugin {
        ensure!(
            job.batch.as_ref().is_some_and(|batch| matches!(
                batch.source_for(&item.preview.id),
                Ok(kcoder_migration::batch::BatchSource::Plugin(_))
            )) && !item
                .preview
                .issues
                .iter()
                .any(|issue| issue.blocks_import()),
            "plugin_migration_ready_source_required"
        );
        return Ok(Choice::Plugin {
            item_id: item.preview.id.clone(),
            target_name: name(guide, job, item)?,
        });
    }
    let target_name = name(guide, job, item)?;
    let item_id = item.preview.id.clone();
    if let Some(provider) = &item.provider {
        let endpoint = optional(guide.io.text(
            "endpoint",
            "Endpoint (use the actual source value or an explicit new address; do not enter credentials)",
            provider.endpoint.as_deref(),
        )?);
        let model = optional(guide.io.text(
            "model",
            "Model ID (do not guess the model or context window)",
            provider.model.as_deref(),
        )?);
        let context_window_tokens = guide.io.number(
            "context_window_tokens",
            "Context window tokens (positive integer)",
            provider.context_window_tokens,
        )?;
        let output_headroom_tokens = guide.io.number(
            "output_headroom_tokens",
            "Output headroom tokens (positive integer)",
            provider.output_headroom_tokens,
        )?;
        let max_output_tokens = guide.io.number(
            "max_output_tokens",
            "Maximum output tokens (positive integer)",
            provider.max_output_tokens,
        )?;
        consents.provider(guide, job, item)?;
        return Ok(Choice::Provider {
            item_id,
            target_name,
            endpoint,
            model,
            context_window_tokens,
            output_headroom_tokens,
            max_output_tokens,
        });
    }
    if let Some(mcp) = &item.mcp {
        let cwd = optional(guide.io.text(
            "mcp_cwd",
            "MCP working directory (may be blank; only saves the definition, without running source commands)",
            None,
        )?);
        consents.mcp(guide, item)?;
        let enable_after_import = guide.io.yes(
            "enable_mcp",
            "Explicitly enable this MCP definition? Disabled by default; enabling does not mean connected or validated.",
        )?;
        // The native planner owns trusted-directory, required-field and activation validation.
        let _ = mcp;
        return Ok(Choice::Mcp {
            item_id,
            target_name,
            cwd,
            enable_after_import,
        });
    }
    if item.template.is_some() {
        let provider_item_id = kcoder_migration::store::template_provider_item_id(job, &item_id)
            .ok_or_else(|| anyhow::anyhow!("migration_template_provider_missing"))?;
        if !selected.contains_key(&provider_item_id) {
            ensure!(
                guide.io.yes(
                    "template_dependency",
                    "The template depends on a source connection. Explicitly select and configure that connection too?"
                )?,
                "migration_template_dependency_not_selected"
            );
            let provider = job
                .inventory
                .items
                .iter()
                .find(|p| p.preview.id == provider_item_id && p.provider.is_some())
                .ok_or_else(|| anyhow::anyhow!("migration_template_provider_missing"))?;
            let choice = configure(guide, job, provider, selected, consents, project_host)?;
            selected.insert(provider_item_id.clone(), choice);
        }
        return Ok(Choice::Template {
            item_id,
            target_name,
            provider_item_id,
        });
    }
    ensure!(
        item.asset.is_some() && !item.preview.issues.iter().any(|i| i.blocks_import()),
        "migration_guide_item_unsupported"
    );
    if matches!(
        item.preview.category,
        MigrationCategory::Agent | MigrationCategory::Hook
    ) {
        let agent_adaptation = if item.preview.category == MigrationCategory::Agent {
            agents::choose(guide, job, &item_id)?
        } else {
            None
        };
        if agent_adaptation.is_none() {
            ensure!(guide.io.yes("definition_save_consent", "Save only a pending definition at its original scope. This does not install Agents, execute Hooks, grant tool permissions or add system instructions. Include it in the preview?")?,"migration_definition_not_selected");
        }
        return Ok(Choice::Asset {
            agent_adaptation,
            item_id,
            target_name,
            enable_after_import: false,
            memory_mapping: None,
        });
    }
    if item.preview.category == MigrationCategory::Memory {
        return Ok(Choice::Asset {
            agent_adaptation: None,
            item_id,
            target_name,
            enable_after_import: false,
            memory_mapping: Some(super::memory::mapping(guide)?),
        });
    }
    let enable_after_import = guide.io.yes(
        "enable_asset",
        if item.preview.category==MigrationCategory::Instructions {"Explicitly enable confirmed static constraints? Their text becomes project user context in later model requests under the original mapping; system identity, permissions and approvals are unchanged. Review originals and compiled text first if needed. Disabled by default."}else{"Explicitly enable this compatible asset? Disabled by default; its scripts and source programs are not run."},
    )?;
    Ok(Choice::Asset {
        agent_adaptation: None,
        item_id,
        target_name,
        enable_after_import,
        memory_mapping: None,
    })
}
