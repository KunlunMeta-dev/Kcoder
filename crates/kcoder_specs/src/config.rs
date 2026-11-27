//! Project-level spec configuration (OpenSpec `config.yaml` port).
//!
//! KCoder stores the configuration at `.kcoder/specs/config.yaml`. It carries:
//! - `schema`: the workflow schema (e.g. `spec-driven`)
//! - `context`: free-form project context injected into skill instructions
//! - `rules`: per-artifact validation rules (specs, tasks, design, ...)

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::parse::Spec;

/// Name of the config file inside `.kcoder/specs/`.
pub const CONFIG_FILE: &str = "config.yaml";

/// Supported workflow schemas and their aliases.
const SUPPORTED_SCHEMAS: &[&str] = &[
    "spec-driven",
    "kcoder-spec-driven",
    "spec-driven-superpowers",
    "kcoder-spec-driven-superpowers",
];

/// Parsed project configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectConfig {
    #[serde(default)]
    pub schema: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<BTreeMap<String, Vec<String>>>,
    /// Verification command run before archiving a change. Defaults to `cargo test`
    /// if omitted and a `Cargo.toml` exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precheck: Option<String>,
}

/// Read `.kcoder/specs/config.yaml` if it exists.
pub fn read_project_config(specs_dir: &Path) -> Result<Option<ProjectConfig>> {
    let path = specs_dir.join(CONFIG_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    let config: ProjectConfig = serde_yaml::from_str(&content)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    Ok(Some(config))
}

/// Validate the `schema` field and return diagnostics.
pub fn validate_schema(config: &ProjectConfig) -> Vec<String> {
    let mut errors = Vec::new();
    if config.schema.is_empty() {
        errors.push(format!(
            "{}: missing 'schema' field (default: spec-driven)",
            CONFIG_FILE
        ));
        return errors;
    }
    let normalized = config.schema.to_ascii_lowercase();
    if !SUPPORTED_SCHEMAS.iter().any(|s| s == &normalized) {
        errors.push(format!(
            "{}: unsupported schema '{}' (supported: {})",
            CONFIG_FILE,
            config.schema,
            SUPPORTED_SCHEMAS.join(", ")
        ));
    }
    errors
}

/// Return true when a schema opts into the stronger review/plan artifact graph.
pub fn is_superpowers_schema(schema: &str) -> bool {
    matches!(
        schema.to_ascii_lowercase().as_str(),
        "spec-driven-superpowers" | "kcoder-spec-driven-superpowers"
    )
}

/// Return the current configuration, or the bundled default if it has not
/// been written yet.
pub fn read_or_default(specs_dir: &Path) -> Result<ProjectConfig> {
    match read_project_config(specs_dir)? {
        Some(c) => Ok(c),
        None => {
            serde_yaml::from_str(DEFAULT_CONFIG).with_context(|| "failed to parse default config")
        }
    }
}

/// Get a configuration value as a human-readable string.
///
/// Supported keys: `schema`, `context`, `precheck`, `rules.<artifact>`,
/// or `None` for the whole file.
pub fn config_get(specs_dir: &Path, key: Option<&str>) -> Result<String> {
    let config = read_or_default(specs_dir)?;
    match key {
        None => serde_yaml::to_string(&config).with_context(|| "failed to serialize config"),
        Some("schema") => Ok(config.schema),
        Some("context") => Ok(config.context.unwrap_or_default()),
        Some("precheck") => Ok(config.precheck.unwrap_or_default()),
        Some(k) => {
            let artifact = k
                .strip_prefix("rules.")
                .ok_or_else(|| anyhow::anyhow!("unknown config key: {}", k))?;
            let rules = config
                .rules
                .as_ref()
                .and_then(|r| r.get(artifact))
                .cloned()
                .unwrap_or_default();
            serde_yaml::to_string(&rules).with_context(|| "failed to serialize rules")
        }
    }
}

/// Set a configuration value and persist the file.
///
/// Supported keys: `schema`, `context`, `precheck`, `rules.<artifact>`.
/// For `rules.<artifact>`, `value` is parsed as a YAML list of strings.
pub fn config_set(specs_dir: &Path, key: &str, value: &str) -> Result<()> {
    let mut config = read_or_default(specs_dir)?;
    match key {
        "schema" => {
            let normalized = value.to_ascii_lowercase();
            if !SUPPORTED_SCHEMAS.iter().any(|s| s == &normalized) {
                anyhow::bail!(
                    "unsupported schema '{}' (supported: {})",
                    value,
                    SUPPORTED_SCHEMAS.join(", ")
                );
            }
            config.schema = value.to_string();
        }
        "context" => config.context = Some(value.to_string()),
        "precheck" => config.precheck = Some(value.to_string()),
        k => {
            let artifact = k
                .strip_prefix("rules.")
                .ok_or_else(|| anyhow::anyhow!("unknown config key: {}", k))?;
            let rules: Vec<String> = if value.trim().is_empty() {
                Vec::new()
            } else {
                serde_yaml::from_str(value)
                    .with_context(|| format!("'{}' must be a YAML list of strings", key))?
            };
            config
                .rules
                .get_or_insert_with(BTreeMap::new)
                .insert(artifact.to_string(), rules);
        }
    }

    let path = specs_dir.join(CONFIG_FILE);
    let content =
        serde_yaml::to_string(&config).with_context(|| "failed to serialize updated config")?;
    fs::write(&path, content).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

/// Apply configured per-artifact rules to a change and its specs.
///
/// `specs` should contain authoritative specs plus the change's deltas merged in
/// so that both existing and new requirements are checked.
pub fn apply_rules(
    config: &ProjectConfig,
    specs: &[Spec],
    change_dir: &Path,
    errors: &mut Vec<String>,
) -> Result<()> {
    let rules = match &config.rules {
        Some(r) => r,
        None => return Ok(()),
    };

    if rules.contains_key("specs") {
        apply_specs_rules(specs, errors);
    }
    if rules.contains_key("design") {
        apply_design_rules(specs, change_dir, errors)?;
    }
    if rules.contains_key("tasks") {
        apply_tasks_rules(specs, change_dir, errors)?;
    }
    if rules.contains_key("review") {
        apply_review_rules(change_dir, errors)?;
    }
    if rules.contains_key("plan") {
        apply_plan_rules(change_dir, errors)?;
    }

    Ok(())
}

fn apply_specs_rules(specs: &[Spec], errors: &mut Vec<String>) {
    for spec in specs {
        for req in &spec.requirements {
            if !is_path_related(&req.description) {
                continue;
            }
            let desc_lower = req.description.to_ascii_lowercase();
            if !desc_lower.contains("cross-platform")
                && !desc_lower.contains("platform-specific")
                && !desc_lower.contains("windows")
                && !desc_lower.contains("macos")
                && !desc_lower.contains("linux")
            {
                errors.push(format!(
                    "specs/{}: requirement '{}' involves paths but does not specify cross-platform behavior",
                    spec.domain, req.name
                ));
            }
            let has_windows_scenario = req.scenarios.iter().any(|s| {
                let text = format!("{} {}", s.title, s.body).to_ascii_lowercase();
                text.contains("windows")
            });
            if !has_windows_scenario {
                errors.push(format!(
                    "specs/{}: requirement '{}' is path-related but has no Windows path-handling scenario",
                    spec.domain, req.name
                ));
            }
        }
    }
}

fn apply_design_rules(specs: &[Spec], change_dir: &Path, errors: &mut Vec<String>) -> Result<()> {
    if !has_path_related_requirement(specs) {
        return Ok(());
    }
    let design_path = change_dir.join("design.md");
    if !design_path.exists() {
        errors.push(
            "design.md: missing; path-related requirements require documented platform behavior"
                .to_string(),
        );
        return Ok(());
    }
    let design = fs::read_to_string(&design_path)
        .with_context(|| format!("failed to read {}", design_path.display()))?
        .to_ascii_lowercase();
    if !design.contains("platform-specific")
        && !design.contains("cross-platform")
        && !design.contains("windows")
    {
        errors.push(
            "design.md: must document platform-specific behavior or limitations because path-related requirements exist"
                .to_string(),
        );
    }
    Ok(())
}

fn apply_tasks_rules(specs: &[Spec], change_dir: &Path, errors: &mut Vec<String>) -> Result<()> {
    if !has_path_related_requirement(specs) {
        return Ok(());
    }
    let tasks_path = change_dir.join("tasks.md");
    if !tasks_path.exists() {
        errors.push(
            "tasks.md: missing; path-related requirements require cross-platform testing tasks"
                .to_string(),
        );
        return Ok(());
    }
    let tasks = fs::read_to_string(&tasks_path)
        .with_context(|| format!("failed to read {}", tasks_path.display()))?
        .to_ascii_lowercase();
    if !tasks.contains("windows") && !tasks.contains("cross-platform") && !tasks.contains("ci") {
        errors.push(
            "tasks.md: add Windows CI verification or cross-platform testing tasks for path-related changes"
                .to_string(),
        );
    }
    Ok(())
}

fn apply_review_rules(change_dir: &Path, errors: &mut Vec<String>) -> Result<()> {
    let review_path = change_dir.join("review.md");
    if !review_path.exists() {
        errors.push("review.md: missing; review rules require a readiness artifact".to_string());
        return Ok(());
    }
    let review = fs::read_to_string(&review_path)
        .with_context(|| format!("failed to read {}", review_path.display()))?;
    for section in [
        "Readiness Decision",
        "Blocked By",
        "Validation Focus",
        "Key Risks",
    ] {
        if !review.contains(&format!("## {section}")) {
            errors.push(format!("review.md: missing required section `{section}`"));
        }
    }
    Ok(())
}

fn apply_plan_rules(change_dir: &Path, errors: &mut Vec<String>) -> Result<()> {
    let plan_path = change_dir.join("plan.md");
    if !plan_path.exists() {
        errors.push("plan.md: missing; plan rules require an execution plan".to_string());
        return Ok(());
    }
    let plan = fs::read_to_string(&plan_path)
        .with_context(|| format!("failed to read {}", plan_path.display()))?;
    for section in [
        "Scope",
        "Covers",
        "Ordered Steps",
        "Validation Per Step",
        "Completion Checkpoint",
    ] {
        if !plan.contains(&format!("## {section}")) {
            errors.push(format!("plan.md: missing required section `{section}`"));
        }
    }
    Ok(())
}

fn has_path_related_requirement(specs: &[Spec]) -> bool {
    specs.iter().any(|s| {
        s.requirements
            .iter()
            .any(|r| is_path_related(&r.description))
    })
}

fn is_path_related(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "path",
        "file path",
        "filepath",
        "directory",
        "folder",
        "file separator",
        "path separator",
        "/",
        "\\",
    ]
    .iter()
    .any(|kw| lower.contains(kw))
}

/// Default configuration written by `init`.
pub const DEFAULT_CONFIG: &str = r#"schema: spec-driven

context: |
  Tech stack: Rust, Cargo, ESM/TypeScript frontend where applicable
  Runtime: Bun for TypeScript tooling; Rust std for core behavior

  Product language:
  - Write specs in user-facing product behavior language
  - Requirements should describe the experience, observable behavior, and product contract
  - Avoid implementation-negative SHALL statements when a positive user outcome can express the same rule
  - Put internal mechanisms in design.md or tasks.md unless the mechanism is itself part of the user-facing contract

  Cross-platform requirements:
  - This tool runs on macOS, Linux, AND Windows
  - Always use std::path::Path / PathBuf or language path helpers — never hardcode slashes
  - Never assume forward-slash path separators
  - Tests must use path helpers for expected path values, not hardcoded strings
  - Consider case sensitivity differences in file systems

# Verification command run before SpecArchive. Override this for non-Rust projects
# (e.g. "bun run precheck" or "make check").
precheck: cargo test

rules:
  specs:
    - Include scenarios for Windows path handling when dealing with file paths
    - Requirements involving paths must specify cross-platform behavior
    - Prefer user-facing product behavior and observable outcomes over internal implementation mechanics
    - Include HOW details only when the mechanism is part of the product contract
    - If we generate artifacts, specify deletion/modification by explicit list lookup, not pattern matching
  tasks:
    - Add Windows CI verification as a task when changes involve file paths
    - Include cross-platform testing considerations
  design:
    - Document any platform-specific behavior or limitations
    - Prefer Rust std::path helpers over string manipulation for paths
    - Use existing constants and lists - don't invent detection mechanisms
    - Prefer explicit lookups over pattern matching or regex
    - If we generate it, we track it by name in a constant
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn default_config_parses() {
        let config: ProjectConfig = serde_yaml::from_str(DEFAULT_CONFIG).unwrap();
        assert_eq!(config.schema, "spec-driven");
        assert!(config.context.is_some());
        assert_eq!(config.precheck.as_deref(), Some("cargo test"));
        assert!(config.rules.as_ref().unwrap().contains_key("specs"));
    }

    #[test]
    fn superpowers_schema_is_supported() {
        let config: ProjectConfig =
            serde_yaml::from_str("schema: spec-driven-superpowers\n").unwrap();
        assert!(validate_schema(&config).is_empty());
        assert!(is_superpowers_schema(&config.schema));
    }

    #[test]
    fn apply_specs_rules_catches_missing_windows_scenario() {
        let spec = Spec {
            domain: "fs".into(),
            purpose: "File ops".into(),
            requirements: vec![crate::parse::Requirement {
                name: "read".into(),
                description: "The system MUST read the file path.".into(),
                scenarios: vec![crate::parse::Scenario {
                    title: "happy".into(),
                    body: "WHEN x THEN y".into(),
                    raw: "".into(),
                }],
                raw: "".into(),
            }],
            sections: vec![],
        };
        let mut errors = Vec::new();
        apply_specs_rules(&[spec], &mut errors);
        assert!(errors.iter().any(|e| e.contains("cross-platform")));
        assert!(errors.iter().any(|e| e.contains("Windows")));
    }

    #[test]
    fn apply_design_rules_requires_platform_docs() {
        let tmp = tempfile::tempdir().unwrap();
        let spec = Spec {
            domain: "fs".into(),
            purpose: "File ops".into(),
            requirements: vec![crate::parse::Requirement {
                name: "read".into(),
                description: "The system MUST read the file path.".into(),
                scenarios: vec![],
                raw: "".into(),
            }],
            sections: vec![],
        };
        let mut errors = Vec::new();
        apply_design_rules(std::slice::from_ref(&spec), tmp.path(), &mut errors).unwrap();
        assert!(errors.iter().any(|e| e.contains("design.md")));

        let mut f = fs::File::create(tmp.path().join("design.md")).unwrap();
        writeln!(f, "# Design\n\nWindows paths are handled via PathBuf.").unwrap();
        let mut errors = Vec::new();
        apply_design_rules(&[spec], tmp.path(), &mut errors).unwrap();
        assert!(errors.is_empty());
    }

    #[test]
    fn review_and_plan_rules_check_required_sections() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("review.md"), "## Readiness Decision\n").unwrap();
        fs::write(tmp.path().join("plan.md"), "## Scope\n").unwrap();
        let config = ProjectConfig {
            schema: "spec-driven-superpowers".into(),
            rules: Some(BTreeMap::from([
                ("review".into(), vec!["check readiness".into()]),
                ("plan".into(), vec!["check covers".into()]),
            ])),
            ..ProjectConfig::default()
        };
        let mut errors = Vec::new();

        apply_rules(&config, &[], tmp.path(), &mut errors).unwrap();

        assert!(errors.iter().any(|e| e.contains("Blocked By")));
        assert!(errors.iter().any(|e| e.contains("Covers")));
    }

    #[test]
    fn config_get_set_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let specs_dir = tmp.path().join("specs");
        fs::create_dir_all(&specs_dir).unwrap();

        config_set(&specs_dir, "schema", "kcoder-spec-driven").unwrap();
        assert_eq!(
            config_get(&specs_dir, Some("schema")).unwrap(),
            "kcoder-spec-driven"
        );

        config_set(&specs_dir, "precheck", "bun run precheck").unwrap();
        assert_eq!(
            config_get(&specs_dir, Some("precheck")).unwrap(),
            "bun run precheck"
        );

        config_set(&specs_dir, "rules.specs", "- Foo\n- Bar").unwrap();
        let rules = config_get(&specs_dir, Some("rules.specs")).unwrap();
        assert!(rules.contains("Foo"));
        assert!(rules.contains("Bar"));
    }
}
