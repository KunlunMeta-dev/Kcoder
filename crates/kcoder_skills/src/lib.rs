use anyhow::{Context, Result};
use globset::{Glob, GlobSet};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tracing::warn;

pub mod builtin;
mod bundled_assets;
pub mod import;
mod registry;
pub mod store;

pub use builtin::ensure_builtin_skills;
pub use registry::SkillRegistry;
#[cfg(test)]
use registry::{project_skill_dirs, user_skills_dir_with_override};
pub use store::{
    ExpectedSkillRevision, NamedSkillRevision, PendingSkillTransaction, SkillCommitReceipt,
    SkillCommitRequest, SkillMetadataDelta, SkillMetadataPatch, SkillMetadataPrecondition,
    SkillMetadataPredicate, SkillMetadataStore, SkillMutation, SkillMutationActor,
    SkillMutationOutcome, SkillMutationRuntimeStatus, SkillOperationKind, SkillPackage,
    SkillPackageFile, SkillRevision, SkillStore, SkillStoreCommitStatus, SkillStoreDiagnostic,
    SkillStoreError, SkillStoreFaultInjector, SkillStoreInspection, SkillStoreSnapshot,
    canonical_package_revision, skill_revision,
};

/// A loaded skill with parsed frontmatter metadata.
#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub content: String,
    pub references: Vec<String>,
    pub source: PathBuf,
    /// When to use this skill (free-form guidance for the model).
    pub when_to_use: Option<String>,
    /// Tool names this skill is allowed to invoke.
    pub allowed_tools: Vec<String>,
    /// Positional argument names expected by the skill.
    pub arguments: Vec<String>,
    /// Glob patterns for files that should auto-activate this skill.
    pub paths: Option<GlobSet>,
    /// Whether the user can invoke this via /skill.
    pub user_invocable: bool,
    /// Optional semantic version of the skill content.
    pub version: Option<String>,
    /// Optional skill author or owning team.
    pub author: Option<String>,
    /// Optional SPDX-style license identifier or license name.
    pub license: Option<String>,
    /// Operating platforms this skill applies to, e.g. linux, macos, windows.
    pub platforms: Vec<String>,
    /// Individual tool names this skill requires to be useful.
    pub requires_tools: Vec<String>,
    /// Tool names this skill can act as a fallback for.
    pub fallback_for_tools: Vec<String>,
    /// Toolset names this skill requires to be useful.
    pub requires_toolsets: Vec<String>,
    /// Toolset names this skill can act as a fallback for.
    pub fallback_for_toolsets: Vec<String>,
    /// Environment variables the skill may require from the user.
    pub required_env_vars: Vec<RequiredEnvVar>,
    /// Optional category from metadata.kcoder.category.
    pub category: Option<String>,
    /// Optional searchable tags from metadata.kcoder.tags.
    pub tags: Vec<String>,
}

/// Environment variable declaration embedded in skill frontmatter.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RequiredEnvVar {
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub default: Option<String>,
}

impl Skill {
    pub fn prompt_text(&self) -> String {
        let mut parts = vec![format!("# Skill: {}\n\n{}", self.name, self.content)];
        if !self.references.is_empty() {
            parts.push("\n## References\n".to_string());
            for (i, r) in self.references.iter().enumerate() {
                parts.push(format!("### Reference {}\n{}", i + 1, r));
            }
        }
        parts.join("\n")
    }

    /// Substitute argument placeholders in the skill content.
    ///
    /// Supports `$1`, `$2`, ... for positional args and `$ARGUMENTS` for the
    /// joined list. Unknown placeholders are left untouched.
    pub fn with_arguments(&self, args: &[String]) -> String {
        let mut text = self.prompt_text();
        if !args.is_empty() {
            text = text.replace("$ARGUMENTS", &args.join(" "));
        }
        for (i, arg) in args.iter().enumerate() {
            text = text.replace(&format!("${}", i + 1), arg);
        }
        text
    }

    /// Build the synthetic user message used when this skill is invoked.
    /// The marker is internal metadata for deduplication; the body remains the
    /// exact argument-expanded skill prompt seen by the model.
    pub fn invocation_text(&self, args: &[String]) -> String {
        let runtime_note = current_cli_entrypoint()
            .map(|entry| {
                format!(
                    "<skill_runtime_context>本次会话的 KCoder CLI 入口是 `{entry}`。技能正文中的 `kcoder` 只是通用占位符；执行 CLI 命令时必须替换为 `{entry}`，不要混用其他 profile 的入口。</skill_runtime_context>\n\n"
                )
            })
            .unwrap_or_default();
        let body = self.with_arguments(args);
        format!(
            "<skill_content name=\"{}\">\n{runtime_note}{body}\n</skill_content>",
            self.name
        )
    }

    /// Check whether any of the provided file paths match this skill's
    /// conditional activation patterns.
    pub fn matches_paths(&self, paths: &[String]) -> bool {
        if let Some(ref globset) = self.paths {
            paths.iter().any(|p| globset.is_match(p))
        } else {
            false
        }
    }
}

fn current_cli_entrypoint() -> Option<String> {
    let entry = std::env::current_exe()
        .ok()?
        .file_stem()?
        .to_string_lossy()
        .into_owned();
    matches!(entry.as_str(), "kcoder" | "kcoder-dev").then_some(entry)
}

/// Raw frontmatter as parsed from YAML.
#[derive(Debug, Default, Deserialize)]
struct SkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
    version: Option<String>,
    author: Option<String>,
    license: Option<String>,
    platforms: Option<Vec<String>>,
    #[serde(rename = "requires_tools")]
    requires_tools: Option<Vec<String>>,
    #[serde(rename = "fallback_for_tools")]
    fallback_for_tools: Option<Vec<String>>,
    #[serde(rename = "requires_toolsets")]
    requires_toolsets: Option<Vec<String>>,
    #[serde(rename = "fallback_for_toolsets")]
    fallback_for_toolsets: Option<Vec<String>>,
    #[serde(rename = "required_env_vars")]
    required_env_vars: Option<Vec<RequiredEnvVar>>,
    #[serde(rename = "when_to_use")]
    when_to_use: Option<String>,
    #[serde(rename = "allowed_tools")]
    allowed_tools: Option<Vec<String>>,
    arguments: Option<Vec<String>>,
    paths: Option<Vec<String>>,
    #[serde(rename = "user_invocable")]
    user_invocable: Option<bool>,
    metadata: Option<SkillMetadata>,
}

#[derive(Debug, Default, Deserialize)]
struct SkillMetadata {
    kcoder: Option<KCoderSkillMetadata>,
}

#[derive(Debug, Default, Deserialize)]
struct KCoderSkillMetadata {
    category: Option<String>,
    tags: Option<Vec<String>>,
    platforms: Option<Vec<String>>,
    #[serde(rename = "requires_tools")]
    requires_tools: Option<Vec<String>>,
    #[serde(rename = "fallback_for_tools")]
    fallback_for_tools: Option<Vec<String>>,
    #[serde(rename = "requires_toolsets")]
    requires_toolsets: Option<Vec<String>>,
    #[serde(rename = "fallback_for_toolsets")]
    fallback_for_toolsets: Option<Vec<String>>,
    #[serde(rename = "required_env_vars")]
    required_env_vars: Option<Vec<RequiredEnvVar>>,
}

/// Read one skill package entry without loading user or project skill layers.
pub fn parse_skill_file(path: &Path) -> Result<Skill> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read skill file {:?}", path))?;

    let (frontmatter, body) = split_frontmatter(&content);
    let fm: SkillFrontmatter = if frontmatter.trim().is_empty() {
        SkillFrontmatter::default()
    } else {
        serde_yaml::from_str(&frontmatter)
            .with_context(|| format!("failed to parse YAML frontmatter in {:?}", path))?
    };

    let name = fm.name.unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    });

    let metadata = fm
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.kcoder.as_ref());
    let globset = fm.paths.as_ref().and_then(|patterns| {
        let mut builder = GlobSet::builder();
        for pat in patterns {
            match Glob::new(pat) {
                Ok(g) => {
                    builder.add(g);
                }
                Err(e) => warn!(
                    pattern_chars = pat.chars().count(),
                    skill = %name,
                    error = %e,
                    "invalid glob pattern in skill"
                ),
            };
        }
        builder.build().ok()
    });

    let references = load_references(path.parent().unwrap_or(Path::new("")));

    Ok(Skill {
        name,
        description: fm.description.unwrap_or_default(),
        content: body.trim().to_string(),
        references,
        source: path.to_path_buf(),
        when_to_use: fm.when_to_use,
        allowed_tools: fm.allowed_tools.unwrap_or_default(),
        arguments: fm.arguments.unwrap_or_default(),
        paths: globset,
        user_invocable: fm.user_invocable.unwrap_or(true),
        version: fm.version,
        author: fm.author,
        license: fm.license,
        platforms: merge_vecs(
            fm.platforms.unwrap_or_default(),
            metadata
                .and_then(|metadata| metadata.platforms.clone())
                .unwrap_or_default(),
        ),
        requires_tools: merge_vecs(
            fm.requires_tools.unwrap_or_default(),
            metadata
                .and_then(|metadata| metadata.requires_tools.clone())
                .unwrap_or_default(),
        ),
        fallback_for_tools: merge_vecs(
            fm.fallback_for_tools.unwrap_or_default(),
            metadata
                .and_then(|metadata| metadata.fallback_for_tools.clone())
                .unwrap_or_default(),
        ),
        requires_toolsets: merge_vecs(
            fm.requires_toolsets.unwrap_or_default(),
            metadata
                .and_then(|metadata| metadata.requires_toolsets.clone())
                .unwrap_or_default(),
        ),
        fallback_for_toolsets: merge_vecs(
            fm.fallback_for_toolsets.unwrap_or_default(),
            metadata
                .and_then(|metadata| metadata.fallback_for_toolsets.clone())
                .unwrap_or_default(),
        ),
        required_env_vars: merge_env_vars(
            fm.required_env_vars.unwrap_or_default(),
            metadata
                .and_then(|metadata| metadata.required_env_vars.clone())
                .unwrap_or_default(),
        ),
        category: metadata.and_then(|metadata| metadata.category.clone()),
        tags: metadata
            .and_then(|metadata| metadata.tags.clone())
            .unwrap_or_default(),
    })
}

fn merge_vecs(mut top_level: Vec<String>, nested: Vec<String>) -> Vec<String> {
    for item in nested {
        if !top_level.iter().any(|existing| existing == &item) {
            top_level.push(item);
        }
    }
    top_level
}

fn merge_env_vars(
    mut top_level: Vec<RequiredEnvVar>,
    nested: Vec<RequiredEnvVar>,
) -> Vec<RequiredEnvVar> {
    for item in nested {
        if !top_level.iter().any(|existing| existing.name == item.name) {
            top_level.push(item);
        }
    }
    top_level
}

fn split_frontmatter(content: &str) -> (String, String) {
    let trimmed = content
        .strip_prefix('\u{feff}')
        .unwrap_or(content)
        .trim_start();
    if !trimmed.starts_with("---") {
        return (String::new(), content.to_string());
    }
    let after_first = &trimmed[3..];
    if let Some(end) = after_first.find("\n---") {
        let fm = &after_first[..end];
        let body = &after_first[end + 4..];
        (fm.to_string(), body.to_string())
    } else {
        (String::new(), content.to_string())
    }
}

fn load_references(skill_dir: &Path) -> Vec<String> {
    let refs_dir = skill_dir.join("references");
    if !refs_dir.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&refs_dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("md")
            && let Ok(content) = std::fs::read_to_string(&path)
        {
            out.push(content);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn skill_registry_loads_project_skill() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skills_dir).unwrap();
        let mut file = std::fs::File::create(skills_dir.join("SKILL.md")).unwrap();
        writeln!(
            file,
            "---\nname: demo\ndescription: A demo skill\n---\n\n# Demo\n\nUse this."
        )
        .unwrap();

        let registry = SkillRegistry::load(tmp.path()).unwrap();
        assert!(
            registry.names().contains(&"demo".to_string()),
            "registry should contain the demo skill, got {:?}",
            registry.names()
        );
        let skill = registry.get("demo").unwrap();
        assert_eq!(skill.description, "A demo skill");
        assert!(skill.content.contains("Use this."));
    }

    #[test]
    fn skill_argument_substitution() {
        let skill = Skill {
            name: "demo".into(),
            description: "test".into(),
            content: "Run: $1 with $ARGUMENTS".into(),
            references: vec![],
            source: PathBuf::from("."),
            when_to_use: None,
            allowed_tools: vec![],
            arguments: vec!["cmd".into()],
            paths: None,
            user_invocable: true,
            version: None,
            author: None,
            license: None,
            platforms: vec![],
            requires_tools: vec![],
            fallback_for_tools: vec![],
            requires_toolsets: vec![],
            fallback_for_toolsets: vec![],
            required_env_vars: vec![],
            category: None,
            tags: vec![],
        };
        let text = skill.with_arguments(&["build".into(), "--release".into()]);
        assert!(text.contains("Run: build with build --release"));
    }

    #[test]
    fn conditional_skill_matches_paths() {
        let mut builder = GlobSet::builder();
        builder.add(Glob::new("**/*.rs").unwrap());
        let skill = Skill {
            name: "rust".into(),
            description: "rust skill".into(),
            content: "...".into(),
            references: vec![],
            source: PathBuf::from("."),
            when_to_use: None,
            allowed_tools: vec![],
            arguments: vec![],
            paths: builder.build().ok(),
            user_invocable: false,
            version: None,
            author: None,
            license: None,
            platforms: vec![],
            requires_tools: vec![],
            fallback_for_tools: vec![],
            requires_toolsets: vec![],
            fallback_for_toolsets: vec![],
            required_env_vars: vec![],
            category: None,
            tags: vec![],
        };
        assert!(skill.matches_paths(&["src/main.rs".into()]));
        assert!(!skill.matches_paths(&["README.md".into()]));
    }

    #[test]
    fn skill_registry_parses_extended_metadata() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().join(".kcoder").join("skills").join("deploy");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(
            skills_dir.join("SKILL.md"),
            r#"---
name: deploy
description: Deploy safely
version: "1.2.3"
author: Platform Team
license: MIT
platforms: [linux]
requires_tools: [bash]
required_env_vars:
  - name: API_TOKEN
    prompt: Token for deploy API
metadata:
  kcoder:
    category: devops
    tags: [deploy, release]
    platforms: [macos]
    fallback_for_tools: [web_search]
    requires_toolsets: [terminal]
    fallback_for_toolsets: [web]
    required_env_vars:
      - name: DEPLOY_REGION
        prompt: Default deployment region
        default: us-east-1
---

# Deploy

Use this."#,
        )
        .unwrap();

        let registry = SkillRegistry::load(tmp.path()).unwrap();
        let skill = registry.get("deploy").unwrap();
        assert_eq!(skill.version.as_deref(), Some("1.2.3"));
        assert_eq!(skill.author.as_deref(), Some("Platform Team"));
        assert_eq!(skill.license.as_deref(), Some("MIT"));
        assert_eq!(skill.category.as_deref(), Some("devops"));
        assert_eq!(skill.platforms, vec!["linux", "macos"]);
        assert_eq!(skill.requires_tools, vec!["bash"]);
        assert_eq!(skill.fallback_for_tools, vec!["web_search"]);
        assert_eq!(skill.requires_toolsets, vec!["terminal"]);
        assert_eq!(skill.fallback_for_toolsets, vec!["web"]);
        assert_eq!(skill.tags, vec!["deploy", "release"]);
        assert_eq!(skill.required_env_vars.len(), 2);
        assert_eq!(skill.required_env_vars[0].name, "API_TOKEN");
        assert_eq!(
            skill.required_env_vars[1].default.as_deref(),
            Some("us-east-1")
        );
    }

    #[test]
    fn active_for_paths_includes_user_invocable_skills() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().join(".kcoder").join("skills").join("specs");
        std::fs::create_dir_all(&skills_dir).unwrap();
        let mut file = std::fs::File::create(skills_dir.join("SKILL.md")).unwrap();
        writeln!(
            file,
            "---\nname: specs\ndescription: Spec workflow\npaths:\n  - \".kcoder/specs/**\"\n---\n\n# Specs"
        )
        .unwrap();

        let registry = SkillRegistry::load(tmp.path()).unwrap();
        let matches = registry.active_for_paths(&[".kcoder/specs/changes/demo/tasks.md".into()]);

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, "specs");
    }

    #[test]
    fn get_active_finds_conditional_skills() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp
            .path()
            .join(".kcoder")
            .join("skills")
            .join("using-specs");
        std::fs::create_dir_all(&skills_dir).unwrap();
        let mut file = std::fs::File::create(skills_dir.join("SKILL.md")).unwrap();
        writeln!(
            file,
            "---\nname: using-specs\ndescription: Spec protocol\nuser_invocable: false\npaths:\n  - \".kcoder/specs/**\"\n---\n\n# Using Specs\n\nFollow the spec protocol."
        )
        .unwrap();

        let registry = SkillRegistry::load(tmp.path()).unwrap();
        assert!(registry.get("using-specs").is_none());
        assert!(registry.get_active("using-specs").is_some());
        assert_eq!(
            registry
                .active_for_paths(&[".kcoder/specs/changes/demo/tasks.md".to_string()])
                .len(),
            1
        );
    }

    #[test]
    fn remove_named_excludes_conditional_skill_from_all_lookups() {
        let tmp = TempDir::new().unwrap();
        let skill_dir = tmp.path().join(".kcoder/skills/kcoder-settings");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: kcoder-settings\ndescription: Conditional settings\nuser_invocable: false\npaths:\n  - \"**/*\"\n---\n\n# Settings\n",
        )
        .unwrap();

        let mut registry = SkillRegistry::load_project_only(tmp.path()).unwrap();
        assert!(registry.get_active("kcoder-settings").is_some());
        assert!(registry.remove_named("kcoder-settings"));
        assert!(registry.get_active("kcoder-settings").is_none());
        assert!(!registry.remove_named("kcoder-settings"));
    }

    #[test]
    fn load_with_external_dirs_loads_between_project_and_user_layers() {
        let tmp = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        let user = TempDir::new().unwrap();
        let project_skill = tmp.path().join(".kcoder").join("skills").join("demo");
        let external_skill = external.path().join("demo");
        let user_skill = user.path().join("demo");
        std::fs::create_dir_all(&project_skill).unwrap();
        std::fs::create_dir_all(&external_skill).unwrap();
        std::fs::create_dir_all(&user_skill).unwrap();
        std::fs::write(
            project_skill.join("SKILL.md"),
            "---\nname: demo\ndescription: Project skill\n---\n\n# Project",
        )
        .unwrap();
        std::fs::write(
            external_skill.join("SKILL.md"),
            "---\nname: demo\ndescription: External skill\n---\n\n# External",
        )
        .unwrap();
        std::fs::write(
            user_skill.join("SKILL.md"),
            "---\nname: demo\ndescription: User skill\n---\n\n# User",
        )
        .unwrap();

        let registry =
            SkillRegistry::load_with_layers(tmp.path(), [external.path()], Some(user.path()), true)
                .unwrap();

        assert_eq!(
            registry.get("demo").unwrap().description,
            "User skill",
            "load order should be project, external dirs, then user skills"
        );
    }

    #[test]
    fn load_with_external_dirs_overrides_conditional_skills_by_name() {
        let tmp = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        let user = TempDir::new().unwrap();
        let project_skill = tmp.path().join(".kcoder").join("skills").join("specs");
        let external_skill = external.path().join("specs");
        let user_skill = user.path().join("specs");
        std::fs::create_dir_all(&project_skill).unwrap();
        std::fs::create_dir_all(&external_skill).unwrap();
        std::fs::create_dir_all(&user_skill).unwrap();
        std::fs::write(
            project_skill.join("SKILL.md"),
            "---\nname: specs\ndescription: Project conditional\nuser_invocable: false\npaths:\n  - \"src/**\"\n---\n\n# Project",
        )
        .unwrap();
        std::fs::write(
            external_skill.join("SKILL.md"),
            "---\nname: specs\ndescription: External conditional\nuser_invocable: false\npaths:\n  - \"src/**\"\n---\n\n# External",
        )
        .unwrap();
        std::fs::write(
            user_skill.join("SKILL.md"),
            "---\nname: specs\ndescription: User conditional\nuser_invocable: false\npaths:\n  - \"src/**\"\n---\n\n# User",
        )
        .unwrap();

        let registry =
            SkillRegistry::load_with_layers(tmp.path(), [external.path()], Some(user.path()), true)
                .unwrap();
        let matches = registry.active_for_paths(&["src/lib.rs".to_string()]);

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].description, "User conditional");
        assert_eq!(
            registry.get_active("specs").unwrap().description,
            "User conditional"
        );
    }

    #[test]
    fn user_skills_dir_honours_config_dir_env() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved =
            user_skills_dir_with_override(Some(tmp.path().as_os_str().to_owned())).unwrap();
        assert_eq!(resolved, tmp.path().join("skills"));
    }

    #[test]
    fn project_skill_discovery_stops_before_the_user_home_directory() {
        let home = tempfile::tempdir().unwrap();
        let workspace = home.path().join("AppData/Local/Temp/workspace");
        std::fs::create_dir_all(home.path().join(".kcoder/skills")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();

        assert!(project_skill_dirs(&workspace, Some(home.path())).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn registry_never_loads_symlinked_skill_directories() {
        use std::os::unix::fs::symlink;
        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let target = external.path().join("linked");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(
            target.join("SKILL.md"),
            "---\nname: linked\ndescription: Linked\n---\n\n# Linked",
        )
        .unwrap();
        let root = workspace.path().join(".kcoder/skills");
        std::fs::create_dir_all(&root).unwrap();
        symlink(&target, root.join("linked")).unwrap();
        let registry = SkillRegistry::load_project_only(workspace.path()).unwrap();
        assert!(registry.get("linked").is_none());
    }
}
