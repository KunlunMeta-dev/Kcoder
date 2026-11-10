//! Freeze explicit static Markdown imports within the selected source directory.
use super::{SourceAsset, validate_name};
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_skills::SkillPackageFile;
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    io::Read,
    ops::Range,
    path::Path,
};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILES: usize = 64;
const MAX_DEPTH: usize = 4;

struct Import {
    range: Range<usize>,
    key: String,
}

pub(super) fn collect(
    directory: &PrivateDirectory,
    key: &str,
    files: &mut Vec<SkillPackageFile>,
) -> Result<()> {
    visit(
        directory,
        key,
        files,
        &mut BTreeSet::new(),
        0,
        &mut 0,
        &mut BTreeMap::new(),
    )
}

fn visit(
    directory: &PrivateDirectory,
    key: &str,
    files: &mut Vec<SkillPackageFile>,
    ancestors: &mut BTreeSet<String>,
    depth: usize,
    visits: &mut usize,
    verified: &mut BTreeMap<String, usize>,
) -> Result<()> {
    *visits += 1;
    ensure!(*visits <= 4096, "migration_asset_budget_exceeded");
    ensure!(ancestors.insert(key.into()), "migration_asset_import_cycle");
    // Repeated references must not repeatedly parse a large shared dependency. A deeper
    // prior visit has already enforced a stricter remaining recursion allowance.
    if verified
        .get(key)
        .is_some_and(|previous_depth| depth <= *previous_depth)
    {
        ancestors.remove(key);
        return Ok(());
    }
    let text = source_text(files, key)?;
    // Unknown policy metadata is a compatibility issue, not authority to inspect
    // additional files. Preserve the original candidate for the existing review UI.
    if !matches!(crate::asset_adapter::frontmatter(text), Ok((metadata, _)) if metadata.is_empty())
    {
        ancestors.remove(key);
        return Ok(());
    }
    let imports = parse_imports(key, text)?;
    ensure!(
        imports.is_empty() || depth < MAX_DEPTH,
        "migration_asset_budget_exceeded"
    );
    for import in imports {
        if !files
            .iter()
            .any(|file| file.relative_path == Path::new(&import.key))
        {
            ensure!(files.len() < MAX_FILES, "migration_asset_budget_exceeded");
            let content = read_import(directory, &import.key)?;
            ensure!(
                files.iter().map(|file| file.content.len()).sum::<usize>() + content.len()
                    <= MAX_BYTES,
                "migration_asset_budget_exceeded"
            );
            files.push(SkillPackageFile {
                relative_path: import.key.clone().into(),
                content,
                executable: false,
            });
        }
        visit(
            directory,
            &import.key,
            files,
            ancestors,
            depth + 1,
            visits,
            verified,
        )?;
    }
    ancestors.remove(key);
    verified.insert(key.into(), depth);
    Ok(())
}

fn read_import(directory: &PrivateDirectory, key: &str) -> Result<Vec<u8>> {
    let components = key.split('/').collect::<Vec<_>>();
    let mut owned = None;
    for part in &components[..components.len() - 1] {
        let child = owned
            .as_ref()
            .unwrap_or(directory)
            .open_child(OsStr::new(part), false)?;
        child.verify_trusted_config_directory()?;
        owned = Some(child);
    }
    let directory = owned.as_ref().unwrap_or(directory);
    let file =
        directory.open_single_link_regular_file(OsStr::new(components[components.len() - 1]))?;
    let before = file.metadata()?;
    ensure!(
        before.len() <= MAX_BYTES as u64,
        "migration_asset_budget_exceeded"
    );
    let mut content = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut content)?;
    let current =
        directory.open_single_link_regular_file(OsStr::new(components[components.len() - 1]))?;
    let after = current.metadata()?;
    ensure!(
        content.len() <= MAX_BYTES
            && before.len() == content.len() as u64
            && before.len() == after.len()
            && before.modified().ok() == after.modified().ok(),
        "migration_source_changed"
    );
    ensure!(
        std::str::from_utf8(&content).is_ok(),
        "migration_asset_encoding"
    );
    Ok(content)
}

fn source_text<'a>(files: &'a [SkillPackageFile], key: &str) -> Result<&'a str> {
    let file = files
        .iter()
        .find(|file| file.relative_path == Path::new(key))
        .ok_or_else(|| anyhow::anyhow!("migration_asset_import_missing"))?;
    let text = std::str::from_utf8(&file.content)
        .map_err(|_| anyhow::anyhow!("migration_asset_encoding"))?;
    ensure!(!text.contains('\0'), "migration_asset_encoding");
    Ok(text)
}

/// Only standalone directives are admitted; other live import syntax remains explicit review.
fn parse_imports(key: &str, text: &str) -> Result<Vec<Import>> {
    let mut imports = Vec::new();
    let mut code = false;
    let prefix = usize::from(text.starts_with('\u{feff}')) * '\u{feff}'.len_utf8();
    for (event, mut range) in Parser::new(&text[prefix..]).into_offset_iter() {
        range.start += prefix;
        range.end += prefix;
        match event {
            Event::Start(Tag::CodeBlock(_)) => code = true,
            Event::End(TagEnd::CodeBlock) => code = false,
            Event::Text(value) if !code => {
                if !value.split_whitespace().any(|word| word.starts_with('@')) {
                    continue;
                }
                let start = text[..range.start].rfind('\n').map_or(0, |index| index + 1);
                let end = text[range.end..]
                    .find('\n')
                    .map_or(text.len(), |index| range.end + index);
                let line = text[start..end].trim_start_matches('\u{feff}').trim();
                let path = line
                    .strip_prefix('@')
                    .ok_or_else(|| anyhow::anyhow!("migration_asset_semantics_require_review"))?;
                ensure!(
                    !path.is_empty()
                        && !path.chars().any(char::is_whitespace)
                        && !path.contains(['`', '\\', '@', '"', '\'']),
                    "migration_asset_semantics_require_review"
                );
                let key = resolve(key, path)?;
                ensure!(
                    imports
                        .last()
                        .is_none_or(|import: &Import| import.range.start != start),
                    "migration_asset_semantics_require_review"
                );
                imports.push(Import {
                    range: start..end,
                    key,
                });
            }
            _ => {}
        }
    }
    Ok(imports)
}

fn resolve(current: &str, relative: &str) -> Result<String> {
    ensure!(
        !relative.starts_with(['/', '~']) && !relative.contains(':') && relative.ends_with(".md"),
        "migration_asset_semantics_require_review"
    );
    let mut parts = current.split('/').map(str::to_owned).collect::<Vec<_>>();
    parts.pop();
    for part in relative.split('/') {
        match part {
            "." => {}
            ".." => {
                ensure!(parts.pop().is_some(), "migration_unsafe_source_path");
            }
            "" => anyhow::bail!("migration_unsafe_source_path"),
            part => parts.push(part.into()),
        }
    }
    let key = parts.join("/");
    validate_name(&key)?;
    ensure!(
        parts.iter().all(|part| !part.starts_with('.')
            && !["auth.md", "credentials.md", "node_modules", "__pycache__"]
                .contains(&part.as_str())),
        "migration_private_or_generated_package_entry"
    );
    Ok(key)
}

pub(super) fn expand(source: &SourceAsset) -> Result<String> {
    let mut output = String::new();
    expand_file(source, &source.key, &mut BTreeSet::new(), 0, &mut output)?;
    Ok(output)
}

fn expand_file(
    source: &SourceAsset,
    key: &str,
    ancestors: &mut BTreeSet<String>,
    depth: usize,
    output: &mut String,
) -> Result<()> {
    ensure!(ancestors.insert(key.into()), "migration_asset_import_cycle");
    let text = source_text(&source.files, key)?;
    let (metadata, _) = crate::asset_adapter::frontmatter(text)?;
    ensure!(
        metadata.is_empty(),
        "migration_asset_semantics_require_review"
    );
    let imports = parse_imports(key, text)?;
    ensure!(
        imports.is_empty() || depth < MAX_DEPTH,
        "migration_asset_budget_exceeded"
    );
    let mut start = 0;
    for import in imports {
        append(output, &text[start..import.range.start])?;
        append(
            output,
            &format!("\n<!-- Imported Markdown source: {} -->\n", import.key),
        )?;
        expand_file(source, &import.key, ancestors, depth + 1, output)?;
        append(output, "\n<!-- End imported Markdown source -->\n")?;
        start = import.range.end;
    }
    append(output, &text[start..])?;
    ancestors.remove(key);
    Ok(())
}

fn append(output: &mut String, text: &str) -> Result<()> {
    ensure!(
        output.len().saturating_add(text.len()) <= MAX_BYTES,
        "migration_asset_budget_exceeded"
    );
    output.push_str(text);
    Ok(())
}
