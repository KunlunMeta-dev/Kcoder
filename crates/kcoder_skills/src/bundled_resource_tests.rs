//! Release guards for the skills embedded by `build.rs`: re-synced packages keep their
//! upstream provenance record and every package ships the resources its `SKILL.md` names.
use super::*;
use std::collections::BTreeMap;

/// Skills re-based on anthropics/skills that must keep their provenance record.
const UPSTREAM_TRACKED_SKILLS: &[&str] = &["docx", "pdf", "pptx", "xlsx"];

/// Official larksuite/cli skills, synced from the tag of the bundled `lark-cli` binary.
const LARK_SKILLS: &[&str] = &[
    "lark-approval",
    "lark-apps",
    "lark-attendance",
    "lark-base",
    "lark-calendar",
    "lark-contact",
    "lark-doc",
    "lark-drive",
    "lark-event",
    "lark-im",
    "lark-mail",
    "lark-markdown",
    "lark-meeting",
    "lark-note",
    "lark-okr",
    "lark-openapi-explorer",
    "lark-shared",
    "lark-sheets",
    "lark-skill-maker",
    "lark-slides",
    "lark-task",
    "lark-whiteboard",
    "lark-wiki",
    "lark-workflow-meeting-summary",
    "lark-workflow-standup-report",
];
const LARK_CLI_PREPARATION: &str = include_str!("../../../scripts/release/prepare-lark-cli.mjs");

/// Local resource paths that a `SKILL.md` names: `scripts/...` tokens and relative links.
fn referenced_resources(markdown: &str) -> Vec<String> {
    let is_path_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-');
    let mut references = Vec::new();
    for (start, _) in markdown.match_indices("scripts/") {
        if markdown[..start]
            .chars()
            .next_back()
            .is_some_and(is_path_char)
        {
            continue;
        }
        let token: String = markdown[start..]
            .chars()
            .take_while(|c| is_path_char(*c))
            .collect();
        references.push(token.trim_end_matches(['.', '/']).to_string());
    }
    for (start, _) in markdown.match_indices("](") {
        let target = &markdown[start + 2..];
        let Some(end) = target.find(')') else {
            continue;
        };
        let target = target[..end].split('#').next().unwrap_or_default();
        if target.is_empty() || target.contains(':') || !target.chars().all(is_path_char) {
            continue;
        }
        references.push(target.trim_end_matches('/').to_string());
    }
    references
}

#[test]
fn upstream_tracked_skills_record_their_provenance() {
    let packages = crate::bundled_assets::packages();
    for name in UPSTREAM_TRACKED_SKILLS {
        let package = packages
            .iter()
            .find(|package| package.name == *name)
            .unwrap();
        let upstream = package
            .files
            .iter()
            .find(|file| file.relative_path == Path::new("UPSTREAM.md"))
            .unwrap_or_else(|| panic!("{name} must record its upstream provenance"));
        let upstream = String::from_utf8_lossy(&upstream.content);
        assert!(upstream.contains("https://github.com/anthropics/skills"));
        assert!(upstream.contains("Upstream commit: `"));
    }
}

#[test]
fn lark_skills_match_the_bundled_cli_release_and_keep_the_mit_license() {
    let packages = crate::bundled_assets::packages();
    let bundled = packages
        .iter()
        .map(|package| package.name.as_str())
        .filter(|name| name.starts_with("lark-"))
        .collect::<Vec<_>>();
    assert_eq!(
        bundled, LARK_SKILLS,
        "every upstream lark-* skill is bundled"
    );
    let commit = LARK_CLI_PREPARATION
        .split("LARK_CLI_COMMIT = '")
        .nth(1)
        .and_then(|rest| rest.split('\'').next())
        .expect("prepare-lark-cli.mjs pins the upstream commit");
    assert_eq!(commit.len(), 40);
    assert!(LARK_CLI_PREPARATION.contains("LARK_CLI_VERSION = '1.0.100'"));
    for name in LARK_SKILLS {
        let package = packages
            .iter()
            .find(|package| package.name == *name)
            .unwrap();
        let file = |path: &str| {
            package
                .files
                .iter()
                .find(|file| file.relative_path == Path::new(path))
                .map(|file| String::from_utf8_lossy(&file.content).into_owned())
                .unwrap_or_else(|| panic!("{name} must ship {path}"))
        };
        let upstream = file("UPSTREAM.md");
        assert!(upstream.contains("https://github.com/larksuite/cli"));
        assert!(upstream.contains("Upstream tag: `v1.0.100`"));
        assert!(
            upstream.contains(&format!("Upstream commit: `{commit}`")),
            "{name} must come from the commit of the bundled lark-cli"
        );
        assert!(file("LICENSE").starts_with("MIT License"));
    }
}

#[test]
fn bundled_skills_parse_and_lark_activation_stays_bounded() {
    let config = tempfile::tempdir().unwrap();
    let project = tempfile::TempDir::new().unwrap();
    let root = crate::builtin::ensure_builtin_skills(config.path()).unwrap();
    let user_skills = config.path().join("skills");
    let registry = crate::SkillRegistry::load_with_layers(
        project.path(),
        std::iter::empty::<PathBuf>(),
        Some(&user_skills),
        true,
    )
    .unwrap();
    for package in crate::bundled_assets::packages() {
        let skill = registry
            .get_active(&package.name)
            .unwrap_or_else(|| panic!("bundled skill {} must load", package.name));
        assert_eq!(skill.source, root.join(&package.name).join("SKILL.md"));
    }
    for name in LARK_SKILLS {
        let skill = registry.get_active(name).unwrap();
        assert!(
            skill.references.is_empty(),
            "{name} reads references on demand"
        );
        let prompt = skill.invocation_text(&[]);
        assert!(
            prompt.len() < 64 * 1024,
            "{name} activation prompt is {} bytes",
            prompt.len()
        );
        assert!(prompt.contains("Skill base directory"));
    }
    // Sibling links such as `../lark-shared/SKILL.md` resolve on disk.
    assert!(root.join("lark-doc/../lark-shared/SKILL.md").is_file());
}

#[test]
fn bundled_skill_entries_only_reference_shipped_resources() {
    let packages = crate::bundled_assets::packages();
    let shipped = packages
        .iter()
        .map(|package| {
            let paths = package
                .files
                .iter()
                .map(|file| file.relative_path.to_str().unwrap().to_string())
                .collect::<Vec<_>>();
            (package.name.as_str(), paths)
        })
        .collect::<BTreeMap<_, _>>();
    let mut missing = Vec::new();
    for package in &packages {
        let entry = package
            .files
            .iter()
            .find(|file| file.relative_path == Path::new("SKILL.md"))
            .unwrap();
        for reference in referenced_resources(&String::from_utf8_lossy(&entry.content)) {
            // `../<skill>/<path>` names a sibling bundled skill.
            let (owner, path) = match reference.strip_prefix("../") {
                Some(sibling) => sibling.split_once('/').unwrap_or((sibling, "")),
                None => (package.name.as_str(), reference.as_str()),
            };
            let prefix = format!("{path}/");
            let found = shipped.get(owner).is_some_and(|paths| {
                path.is_empty()
                    || paths
                        .iter()
                        .any(|shipped| shipped == path || shipped.starts_with(&prefix))
            });
            if !found {
                missing.push(format!("{}: {reference}", package.name));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "SKILL.md references resources that are not bundled:\n{}",
        missing.join("\n")
    );
}

#[test]
fn resource_reference_scan_finds_scripts_and_relative_links() {
    let references = referenced_resources(
        "Run `python scripts/office/validate.py out.docx`. See [forms](FORMS.md#fill), \
         [web](https://example.com/a.md), [anchor](#local) and <dir>/scripts/x.js.",
    );
    assert_eq!(references, ["scripts/office/validate.py", "FORMS.md"]);
}
