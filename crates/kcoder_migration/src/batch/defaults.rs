//! Stable names derive from source identity and labels, never credential-bearing file hashes.
use super::*;
use crate::{NormalizedItem, providers::ModelLimits, store::MigrationJob};
use sha2::{Digest, Sha256};

pub fn proposed_name(job: &MigrationJob, item: &NormalizedItem) -> Result<String> {
    let source = job
        .batch
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?
        .source_for(&item.preview.id)?;
    if let BatchSource::Plugin(source) = source {
        return source.proposed_name();
    }
    let identity = source.logical_identity();
    let slug = item
        .preview
        .source_name
        .chars()
        .filter_map(|ch| {
            if ch.is_ascii_alphanumeric() {
                Some(ch.to_ascii_lowercase())
            } else if item.template.is_some() && matches!(ch, '_' | '.') {
                Some('-')
            } else if matches!(ch, '-' | '_' | '.') {
                Some(ch)
            } else {
                None
            }
        })
        .take(24)
        .collect::<String>();
    let slug = if item.template.is_some() {
        let mut slug = slug;
        while slug.contains("--") {
            slug = slug.replace("--", "-");
        }
        slug.trim_matches('-').to_owned()
    } else {
        slug
    };
    let suffix = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{identity}\0{:?}\0{}",
                item.preview.category, item.preview.source_name
            )
            .as_bytes()
        )
    );
    Ok(format!(
        "imported-{}-{}-{}",
        if source.kind() == MigrationSourceKind::ClaudeCode {
            "claude"
        } else {
            "codex"
        },
        if slug.is_empty() { "asset" } else { &slug },
        &suffix[..8]
    ))
}
pub fn default_resolution(job: &MigrationJob, item: &NormalizedItem) -> Option<BatchResolution> {
    if item
        .preview
        .issues
        .iter()
        .any(|issue| issue.blocks_import())
    {
        return None;
    }
    if item.preview.category == kcoder_types::migration::MigrationCategory::History {
        return Some(BatchResolution::History(history::HistoryBatchResolution {
            item_id: item.preview.id.clone(),
        }));
    }
    let target_name = proposed_name(job, item).ok()?;
    if item.preview.category == kcoder_types::migration::MigrationCategory::Plugin {
        return Some(BatchResolution::Plugin(plugins::PluginBatchResolution {
            item_id: item.preview.id.clone(),
            target_name,
        }));
    }
    if let Some(provider) = &item.provider {
        return Some(BatchResolution::Provider(ProviderResolution {
            item_id: item.preview.id.clone(),
            target_name,
            endpoint: provider.endpoint.clone().filter(|value| !value.is_empty()),
            model: provider.model.clone().filter(|value| !value.is_empty()),
            limits: Some(ModelLimits {
                context_window_tokens: provider.context_window_tokens?,
                output_headroom_tokens: provider.output_headroom_tokens?,
                max_output_tokens: provider.max_output_tokens?,
            }),
        }));
    }
    if item.mcp.is_some() {
        return Some(BatchResolution::Mcp(McpResolution {
            item_id: item.preview.id.clone(),
            target_name,
            cwd: None,
            enable_after_import: false,
        }));
    }
    if item.asset.is_some()
        && item.preview.category != kcoder_types::migration::MigrationCategory::Memory
    {
        return Some(BatchResolution::Asset(AssetResolution {
            agent_adaptation: None,
            item_id: item.preview.id.clone(),
            target_name,
            enable_after_import: false,
            memory_scope: None,
        }));
    }
    None
}
