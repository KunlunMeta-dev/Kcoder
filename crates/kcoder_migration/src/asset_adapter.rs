//! Convert only explicit compatible semantics; never execute embedded command templates.
use crate::asset_sources::SourceAsset;
use anyhow::{Result, ensure};
use kcoder_config::imported_context::ImportedContextScope;
use kcoder_skills::{SkillActivation, SkillPackage, SkillPackageFile};
use kcoder_types::migration::MigrationCategory as Category;
use serde_yaml::{Mapping, Value};
use std::path::Path;

pub(crate) fn skill_package(
    source: &SourceAsset,
    category: Category,
    name: &str,
    token: &str,
    enabled: bool,
    scope: &ImportedContextScope,
) -> Result<SkillPackage> {
    kcoder_skills::store::validate_skill_name(name)
        .map_err(|_| anyhow::anyhow!("migration_invalid_asset_name"))?;
    let entry = if category == Category::Skill {
        "SKILL.md"
    } else {
        &source.key
    };
    let original = source
        .files
        .iter()
        .find(|file| file.relative_path == Path::new(entry))
        .ok_or_else(|| anyhow::anyhow!("migration_skill_entry_missing"))?;
    let text = std::str::from_utf8(&original.content)
        .map_err(|_| anyhow::anyhow!("migration_asset_encoding"))?;
    let (mut metadata, body) = frontmatter(text)?;
    // These fields have direct native equivalents. Execution policy fields require a separate adapter.
    let supported = [
        "name",
        "description",
        "version",
        "author",
        "license",
        "argument-hint",
    ];
    ensure!(
        metadata
            .keys()
            .all(|key| key.as_str().is_some_and(|key| supported.contains(&key))),
        "migration_asset_semantics_require_review"
    );
    ensure!(
        metadata.values().all(Value::is_string),
        "migration_asset_semantics_require_review"
    );
    ensure!(
        !body.contains("!`")
            && !body.contains("${CLAUDE_")
            && !body.contains("$CLAUDE_")
            && !body.contains("$0")
            && !body.contains("$ARGUMENTS["),
        "migration_asset_semantics_require_review"
    );
    metadata.insert(Value::from("name"), Value::from(name));
    metadata
        .entry(Value::from("description"))
        .or_insert_with(|| Value::from(source.name.clone()));
    let activation = SkillActivation {
        token: token.into(),
        default_enabled: enabled,
        workspace: match scope {
            ImportedContextScope::Global => None,
            ImportedContextScope::Project { root } => Some(root.clone()),
        },
    };
    metadata.insert(Value::from("activation"), serde_yaml::to_value(activation)?);
    let header = serde_yaml::to_string(&metadata)?;
    let replacement = format!("---\n{header}---\n{body}").into_bytes();
    ensure!(
        replacement.len() <= 1024 * 1024,
        "migration_asset_budget_exceeded"
    );
    let mut files = source
        .files
        .iter()
        .filter(|file| file.relative_path != Path::new(entry))
        .cloned()
        .collect::<Vec<_>>();
    files.push(SkillPackageFile {
        relative_path: "SKILL.md".into(),
        content: replacement,
        executable: false,
    });
    let package = SkillPackage {
        name: name.into(),
        files,
    };
    ensure!(
        package
            .files
            .iter()
            .map(|file| file.content.len())
            .sum::<usize>()
            <= 5 * 1024 * 1024,
        "migration_asset_budget_exceeded"
    );
    kcoder_skills::canonical_package_revision(&package)
        .map_err(|_| anyhow::anyhow!("migration_invalid_skill_package"))?;
    Ok(package)
}

pub(crate) fn context_text(source: &SourceAsset) -> Result<String> {
    let text = crate::asset_sources::expanded_context(source)?;
    // Conditional frontmatter cannot be flattened into unconditional user context.
    let (metadata, _) = frontmatter(&text)?;
    ensure!(
        metadata.is_empty(),
        "migration_asset_semantics_require_review"
    );
    ensure!(!text.contains('\0'), "migration_asset_encoding");
    Ok(text)
}

/// Memory frontmatter and references are retained as untrusted data, never flattened into directives.
pub(crate) fn memory_text(source: &SourceAsset) -> Result<String> {
    ensure!(
        source.files.len() == 1,
        "migration_memory_layout_unsupported"
    );
    let file = source
        .files
        .iter()
        .find(|file| file.relative_path == Path::new(&source.key))
        .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
    let text = std::str::from_utf8(&file.content)
        .map_err(|_| anyhow::anyhow!("migration_asset_encoding"))?;
    ensure!(
        text.len() <= 4 * 1024 * 1024 && !text.contains('\0'),
        "migration_asset_budget_exceeded"
    );
    Ok(text.into())
}

pub(crate) fn frontmatter(text: &str) -> Result<(Mapping, &str)> {
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return Ok((Mapping::new(), text));
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            let value: Value = serde_yaml::from_str(&rest[..offset])
                .map_err(|_| anyhow::anyhow!("migration_asset_frontmatter_invalid"))?;
            return match value {
                Value::Mapping(map) => Ok((map, &rest[offset + line.len()..])),
                Value::Null => Ok((Mapping::new(), &rest[offset + line.len()..])),
                _ => anyhow::bail!("migration_asset_frontmatter_invalid"),
            };
        }
        offset += line.len();
    }
    anyhow::bail!("migration_asset_frontmatter_invalid")
}
