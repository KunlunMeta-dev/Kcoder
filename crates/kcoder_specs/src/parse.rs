//! Structured parser for OpenSpec-style markdown specs and deltas.
//!
//! Authoritative specs live under `.kcoder/specs/specs/<domain>/spec.md` and
//! contain a `# Spec: <domain>` title, a `## Purpose` section, and a
//! `## Requirements` section with `### Requirement:` blocks. Each requirement
//! may contain `#### Scenario:` blocks.
//!
//! Delta specs live under `.kcoder/specs/changes/<name>/specs/` and contain
//! top-level `## ADDED Requirements`, `## MODIFIED Requirements`,
//! `## REMOVED Requirements`, and `## RENAMED Requirements` sections.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A single scenario inside a requirement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scenario {
    pub title: String,
    pub body: String,
    pub raw: String,
}

/// A requirement block inside a capability spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    pub name: String,
    pub description: String,
    pub scenarios: Vec<Scenario>,
    pub raw: String,
}

/// An authoritative capability spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spec {
    pub domain: String,
    pub purpose: String,
    pub requirements: Vec<Requirement>,
    /// All top-level `##` sections in original order, including Purpose and
    /// Requirements. Used to preserve free-form sections when re-serializing.
    pub sections: Vec<(String, String)>,
}

/// A rename pair in a delta spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rename {
    pub from: String,
    pub to: String,
}

/// Parsed content of a delta spec file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeltaSpec {
    /// Optional documentation for a new domain or an older empty purpose.
    #[serde(default)]
    pub purpose: Option<String>,
    pub added: Vec<Requirement>,
    pub modified: Vec<Requirement>,
    pub removed: Vec<String>,
    pub renamed: Vec<Rename>,
}

/// Normalize line endings to `\n` so fingerprints and parsers are stable.
pub fn normalize(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

/// Parse an authoritative spec file. The caller can supply a fallback domain
/// when the file does not contain a `# Spec: <domain>` title.
pub fn parse_spec(content: &str, fallback_domain: &str) -> Result<Spec> {
    let normalized = normalize(content);
    let lines: Vec<&str> = normalized.lines().collect();

    let mut domain = fallback_domain.to_string();
    for line in &lines {
        if let Some(d) = line.strip_prefix("# Spec:") {
            domain = d.trim().to_string();
            break;
        }
    }

    let sections = split_top_level_sections(&lines);
    let purpose = section_body(&sections, "Purpose").trim().to_string();
    let requirements_body = section_body(&sections, "Requirements");
    let requirements = parse_requirement_blocks(requirements_body)?;

    Ok(Spec {
        domain,
        purpose,
        requirements,
        sections,
    })
}

/// Parse a delta spec file into structured operations.
pub fn parse_delta(content: &str) -> Result<DeltaSpec> {
    let normalized = normalize(content);
    let lines: Vec<&str> = normalized.lines().collect();
    let sections = split_top_level_sections(&lines);

    let added_body = section_body(&sections, "ADDED Requirements");
    let modified_body = section_body(&sections, "MODIFIED Requirements");
    let removed_body = section_body(&sections, "REMOVED Requirements");
    let renamed_body = section_body(&sections, "RENAMED Requirements");

    Ok(DeltaSpec {
        purpose: {
            let purpose = section_body(&sections, "Purpose").trim();
            (!purpose.is_empty()).then(|| purpose.to_string())
        },
        added: parse_requirement_blocks(added_body)?,
        modified: parse_requirement_blocks(modified_body)?,
        removed: parse_removed_names(removed_body),
        renamed: parse_renamed_pairs(renamed_body),
    })
}

/// Load every authoritative spec under `.kcoder/specs/specs/`.
pub fn load_authoritative_specs(specs_dir: &Path) -> Result<Vec<Spec>> {
    let mut specs = Vec::new();
    let domain_root = specs_dir.join("specs");
    if !domain_root.exists() {
        return Ok(specs);
    }
    for entry in walk_spec_files(&domain_root)? {
        let domain = infer_domain(&entry);
        let content = std::fs::read_to_string(&entry)
            .with_context(|| format!("failed to read {}", entry.display()))?;
        specs.push(parse_spec(&content, &domain)?);
    }
    Ok(specs)
}

/// Load all delta spec files for a change and pair them with their inferred domain.
pub fn load_change_deltas(change_dir: &Path) -> Result<Vec<(String, DeltaSpec)>> {
    Ok(load_change_deltas_with_paths(change_dir)?
        .into_iter()
        .map(|(domain, delta, _path)| (domain, delta))
        .collect())
}

/// Like `load_change_deltas` but also returns the source file path for each delta.
pub fn load_change_deltas_with_paths(
    change_dir: &Path,
) -> Result<Vec<(String, DeltaSpec, PathBuf)>> {
    let mut deltas = Vec::new();
    let specs_dir = change_dir.join("specs");
    if !specs_dir.exists() {
        return Ok(deltas);
    }
    for entry in walk_spec_files(&specs_dir)? {
        let domain = infer_domain(&entry);
        let content = std::fs::read_to_string(&entry)
            .with_context(|| format!("failed to read {}", entry.display()))?;
        deltas.push((domain, parse_delta(&content)?, entry));
    }
    Ok(deltas)
}

fn split_top_level_sections(lines: &[&str]) -> Vec<(String, String)> {
    let mut sections = Vec::new();
    let mut current_title: Option<String> = None;
    let mut current_body: Vec<&str> = Vec::new();

    for line in lines {
        if let Some(title) = line.strip_prefix("## ") {
            if let Some(t) = current_title {
                sections.push((t, current_body.join("\n").trim_end().to_string()));
            }
            current_title = Some(title.trim().to_string());
            current_body.clear();
        } else if current_title.is_some() {
            current_body.push(line);
        }
    }
    if let Some(t) = current_title {
        sections.push((t, current_body.join("\n").trim_end().to_string()));
    }
    sections
}

fn section_body<'a>(sections: &'a [(String, String)], name: &str) -> &'a str {
    sections
        .iter()
        .find(|(title, _)| title.eq_ignore_ascii_case(name))
        .map(|(_, body)| body.as_str())
        .unwrap_or("")
}

fn parse_requirement_blocks(body: &str) -> Result<Vec<Requirement>> {
    let lines: Vec<&str> = body.lines().collect();
    let mut requirements = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let header = lines[i];
        let Some(name) = parse_requirement_header(header) else {
            i += 1;
            continue;
        };
        if name.is_empty() {
            anyhow::bail!("requirement name is empty");
        }

        let mut block_lines: Vec<&str> = vec![header];
        i += 1;
        while i < lines.len()
            && parse_requirement_header(lines[i]).is_none()
            && !lines[i].starts_with("## ")
        {
            block_lines.push(lines[i]);
            i += 1;
        }

        let raw = block_lines.join("\n").trim_end().to_string();
        let (description, scenarios) = split_requirement_body(&block_lines[1..]);
        requirements.push(Requirement {
            name,
            description,
            scenarios,
            raw,
        });
    }

    Ok(requirements)
}

fn parse_requirement_header(line: &str) -> Option<String> {
    line.strip_prefix("### Requirement:")
        .map(|rest| rest.trim().to_string())
}

fn split_requirement_body(lines: &[&str]) -> (String, Vec<Scenario>) {
    let mut description_lines = Vec::new();
    let mut scenarios = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        if let Some(title) = lines[i].strip_prefix("#### Scenario:") {
            let title = title.trim().to_string();
            let mut body_lines: Vec<&str> = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].starts_with("#### Scenario:") {
                body_lines.push(lines[i]);
                i += 1;
            }
            let raw = [format!("#### Scenario: {title}")]
                .into_iter()
                .chain(body_lines.iter().map(|&l| l.to_string()))
                .collect::<Vec<_>>()
                .join("\n")
                .trim_end()
                .to_string();
            scenarios.push(Scenario {
                title,
                body: body_lines.join("\n").trim_end().to_string(),
                raw,
            });
        } else {
            description_lines.push(lines[i]);
            i += 1;
        }
    }

    (
        description_lines.join("\n").trim_end().to_string(),
        scenarios,
    )
}

fn parse_removed_names(body: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_prefix("- ") {
            // Support bullet list entries like `- Requirement Name` or
            // `- `### Requirement: Name``.
            let name = name.trim().trim_matches('`');
            if let Some(inner) = name.strip_prefix("### Requirement:") {
                names.push(inner.trim().to_string());
            } else {
                names.push(name.to_string());
            }
        } else if let Some(name) = parse_requirement_header(trimmed) {
            names.push(name);
        }
    }
    names
}

fn parse_renamed_pairs(body: &str) -> Vec<Rename> {
    let mut pairs = Vec::new();
    let mut current_from: Option<String> = None;
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(raw) = trimmed
            .strip_prefix("FROM:")
            .or_else(|| trimmed.strip_prefix("- FROM:"))
        {
            current_from = Some(parse_name_fragment(raw));
        } else if let Some(raw) = trimmed
            .strip_prefix("TO:")
            .or_else(|| trimmed.strip_prefix("- TO:"))
        {
            let to = parse_name_fragment(raw);
            if let Some(from) = current_from.take() {
                pairs.push(Rename { from, to });
            }
        }
    }
    pairs
}

fn parse_name_fragment(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('`');
    if let Some(inner) = trimmed.strip_prefix("### Requirement:") {
        inner.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn walk_spec_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current)
            .with_context(|| format!("failed to read dir {}", current.display()))?
        {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn infer_domain(path: &Path) -> String {
    if path.file_name().and_then(|n| n.to_str()) == Some("spec.md") {
        path.parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    } else {
        path.file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_spec_extracts_requirements_and_scenarios() {
        let content = r#"# Spec: core

## Purpose
Core behavior.

## Requirements

### Requirement: login
Users MUST authenticate.

#### Scenario: success
- **GIVEN** a registered user
- **WHEN** they enter valid credentials
- **THEN** they are logged in

#### Scenario: failure
- **GIVEN** invalid credentials
- **THEN** login is rejected

### Requirement: logout
Users MAY end their session.
"#;
        let spec = parse_spec(content, "fallback").unwrap();
        assert_eq!(spec.domain, "core");
        assert_eq!(spec.requirements.len(), 2);
        assert_eq!(spec.requirements[0].name, "login");
        assert_eq!(spec.requirements[0].scenarios.len(), 2);
        assert_eq!(spec.requirements[0].scenarios[0].title, "success");
        assert!(spec.requirements[0].scenarios[0].body.contains("GIVEN"));
        assert_eq!(spec.requirements[1].name, "logout");
    }

    #[test]
    fn parse_delta_extracts_operations() {
        let content = r#"## ADDED Requirements
### Requirement: search
Users MAY search.

## MODIFIED Requirements
### Requirement: login
Users MUST authenticate with MFA.

## REMOVED Requirements
- `### Requirement: legacy`

## RENAMED Requirements
- FROM: `### Requirement: old-name`
- TO: `### Requirement: new-name`
"#;
        let delta = parse_delta(content).unwrap();
        assert_eq!(delta.added.len(), 1);
        assert_eq!(delta.added[0].name, "search");
        assert_eq!(delta.modified.len(), 1);
        assert_eq!(delta.modified[0].name, "login");
        assert_eq!(delta.removed, vec!["legacy"]);
        assert_eq!(delta.renamed.len(), 1);
        assert_eq!(delta.renamed[0].from, "old-name");
        assert_eq!(delta.renamed[0].to, "new-name");
    }
}
