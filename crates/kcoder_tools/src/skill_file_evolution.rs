//! Direct skill-file evolution (plan sections 5.2 to 5.4).
//!
//! By default every skill evolves through its overlay. A skill evolves its
//! own files only when
//!
//! - it is `UserCreated` and the user enabled
//!   `evolution.targets.skill.allow_file_edits`, or
//! - it is `AgentCreated` and either that setting is on or the skill
//!   declares `evolution.target: skill` in its frontmatter.
//!
//! Bundled, Hub and external skills never do. Learned content is then
//! materialized into the skill package inside a managed block (the first
//! declared evolvable Markdown file, otherwise the end of `SKILL.md`), staged
//! in the skill store's candidate slot and published by the store's commit
//! journal on promotion. [`validate_skill_file_candidate`] is the boundary
//! check: the frontmatter and every declared `protected` section of
//! `SKILL.md` stay byte-identical, and files other than `SKILL.md` may change
//! only under a declared `evolvable` path.

use crate::skill_provenance::SkillOrigin;
use kcoder_config::EvolutionSettings;
use kcoder_skills::{
    SkillEvolutionDeclaration, SkillEvolutionTarget, SkillPackage, SkillPackageFile,
    split_skill_frontmatter,
};
use kcoder_types::evolution::{EvolutionWriteMode, OverlayContent, ProposalExample};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Opening line of the managed learned-notes block.
pub const LEARNED_BLOCK_BEGIN: &str = "<!-- kcoder:evolution:begin -->";
/// Closing line of the managed learned-notes block.
pub const LEARNED_BLOCK_END: &str = "<!-- kcoder:evolution:end -->";
const LESSONS_HEADING: &str = "### Learned lessons";
const CHECKLIST_HEADING: &str = "### Learned checklist";
const EXAMPLE_HEADING: &str = "### Learned example: ";

/// Whether this build can stage skill-file candidates. `evolution/status`
/// reports it as `skillFileEditsSupported`.
pub fn skill_file_edits_supported() -> bool {
    kcoder_skills::SKILL_CANDIDATE_SLOT_SUPPORTED
}

/// How learned content of a skill takes effect.
pub fn skill_write_mode(
    settings: &EvolutionSettings,
    origin: &SkillOrigin,
    declaration: Option<&SkillEvolutionDeclaration>,
) -> EvolutionWriteMode {
    if !skill_file_edits_supported() {
        return EvolutionWriteMode::Overlay;
    }
    let allowed = settings.targets.skill.allow_file_edits.unwrap_or(false);
    let declared = declaration.is_some_and(|declaration| {
        declaration.target == SkillEvolutionTarget::Skill && declaration.enabled != Some(false)
    });
    let file = match origin {
        SkillOrigin::UserCreated => allowed,
        SkillOrigin::AgentCreated => allowed || declared,
        SkillOrigin::Bundled | SkillOrigin::HubInstalled | SkillOrigin::ExternalDir => false,
    };
    if file {
        EvolutionWriteMode::SkillFile
    } else {
        EvolutionWriteMode::Overlay
    }
}

fn files(package: &SkillPackage) -> BTreeMap<String, &SkillPackageFile> {
    package
        .files
        .iter()
        .map(|file| {
            (
                file.relative_path.to_string_lossy().replace('\\', "/"),
                file,
            )
        })
        .collect()
}

fn heading_level(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    let level = trimmed.chars().take_while(|ch| *ch == '#').count();
    (level > 0 && trimmed[level..].starts_with(' ')).then_some(level)
}

/// The section of `text` that starts at the heading line `heading` and
/// ends before the next heading of the same or a higher level.
fn section<'a>(text: &'a str, heading: &str) -> Option<Vec<&'a str>> {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|line| line.trim() == heading.trim())?;
    let level = heading_level(lines[start]).unwrap_or(usize::MAX);
    let end = lines[start + 1..]
        .iter()
        .position(|line| heading_level(line).is_some_and(|other| other <= level))
        .map(|offset| start + 1 + offset)
        .unwrap_or(lines.len());
    Some(lines[start..end].to_vec())
}

fn evolvable(path: &str, declaration: Option<&SkillEvolutionDeclaration>) -> bool {
    declaration.is_some_and(|declaration| {
        declaration.evolvable.iter().any(|allowed| {
            if let Some(prefix) = allowed.strip_suffix('/') {
                path.starts_with(&format!("{prefix}/"))
            } else {
                path == allowed
            }
        })
    })
}

/// Check that `candidate` changes only what automatic skill edits may
/// change relative to `stable`.
pub fn validate_skill_file_candidate(
    stable: &SkillPackage,
    candidate: &SkillPackage,
    declaration: Option<&SkillEvolutionDeclaration>,
) -> Result<(), String> {
    if stable.name != candidate.name {
        return Err("a candidate cannot rename the skill".into());
    }
    let before = files(stable);
    let after = files(candidate);
    let mut paths: Vec<&String> = before.keys().chain(after.keys()).collect();
    paths.sort();
    paths.dedup();
    for path in paths {
        let (old, new) = (before.get(path), after.get(path));
        let changed = match (old, new) {
            (Some(old), Some(new)) => {
                old.content != new.content || old.executable != new.executable
            }
            _ => true,
        };
        if !changed {
            continue;
        }
        if path == "SKILL.md" {
            let (Some(old), Some(new)) = (old, new) else {
                return Err("SKILL.md cannot be removed".into());
            };
            if new.executable {
                return Err("SKILL.md cannot become executable".into());
            }
            let old_text = std::str::from_utf8(&old.content)
                .map_err(|_| "SKILL.md must be UTF-8".to_string())?;
            let new_text = std::str::from_utf8(&new.content)
                .map_err(|_| "SKILL.md must be UTF-8".to_string())?;
            if split_skill_frontmatter(old_text).0 != split_skill_frontmatter(new_text).0 {
                return Err("automatic edits cannot change the skill frontmatter".into());
            }
            for heading in declaration
                .map(|declaration| declaration.protected.as_slice())
                .unwrap_or_default()
            {
                if let Some(protected) = section(old_text, heading)
                    && section(new_text, heading).as_ref() != Some(&protected)
                {
                    return Err(format!("protected section `{heading}` was changed"));
                }
            }
            continue;
        }
        if !evolvable(path, declaration) {
            return Err(format!("`{path}` is not a declared evolvable path"));
        }
        if new.is_some_and(|file| file.executable) {
            return Err(format!("`{path}` cannot become executable"));
        }
    }
    Ok(())
}

/// Where the managed block lives: the first declared evolvable Markdown
/// file, otherwise `SKILL.md`.
fn block_path(declaration: Option<&SkillEvolutionDeclaration>) -> String {
    declaration
        .and_then(|declaration| {
            declaration
                .evolvable
                .iter()
                .find(|path| !path.ends_with('/') && path.ends_with(".md"))
                .cloned()
        })
        .unwrap_or_else(|| "SKILL.md".to_string())
}

fn render_block(content: &OverlayContent) -> String {
    let mut text = format!("{LEARNED_BLOCK_BEGIN}\n");
    if !content.lessons.trim().is_empty() {
        text.push_str(&format!("{LESSONS_HEADING}\n{}\n", content.lessons.trim()));
    }
    if !content.checklist.trim().is_empty() {
        text.push_str(&format!(
            "{CHECKLIST_HEADING}\n{}\n",
            content.checklist.trim()
        ));
    }
    for example in &content.examples {
        text.push_str(&format!(
            "{EXAMPLE_HEADING}{}\n{}\n",
            example.name.trim(),
            example.text.trim()
        ));
    }
    text.push_str(LEARNED_BLOCK_END);
    text
}

/// Split `text` around its managed block: `(before, block, after)`.
fn split_block(text: &str) -> Option<(&str, &str, &str)> {
    let start = text.find(LEARNED_BLOCK_BEGIN)?;
    let inner_start = start + LEARNED_BLOCK_BEGIN.len();
    let inner_end = inner_start + text[inner_start..].find(LEARNED_BLOCK_END)?;
    Some((
        &text[..start],
        &text[inner_start..inner_end],
        &text[inner_end + LEARNED_BLOCK_END.len()..],
    ))
}

/// Learned content already materialized in `package`.
pub fn materialized_overlay(
    package: &SkillPackage,
    declaration: Option<&SkillEvolutionDeclaration>,
) -> OverlayContent {
    let path = block_path(declaration);
    let Some(text) = files(package)
        .get(&path)
        .and_then(|file| std::str::from_utf8(&file.content).ok())
        .map(str::to_string)
    else {
        return OverlayContent::default();
    };
    let Some((_, block, _)) = split_block(&text) else {
        return OverlayContent::default();
    };
    let mut content = OverlayContent::default();
    enum Part {
        None,
        Lessons,
        Checklist,
        Example(usize),
    }
    let mut part = Part::None;
    for line in block.lines() {
        if line == LESSONS_HEADING {
            part = Part::Lessons;
        } else if line == CHECKLIST_HEADING {
            part = Part::Checklist;
        } else if let Some(name) = line.strip_prefix(EXAMPLE_HEADING) {
            content.examples.push(ProposalExample {
                name: name.to_string(),
                text: String::new(),
            });
            part = Part::Example(content.examples.len() - 1);
        } else {
            let target = match part {
                Part::None => continue,
                Part::Lessons => &mut content.lessons,
                Part::Checklist => &mut content.checklist,
                Part::Example(index) => &mut content.examples[index].text,
            };
            if !target.is_empty() {
                target.push('\n');
            }
            target.push_str(line);
        }
    }
    content
}

/// `stable` with its managed block replaced by `content` (appended when
/// absent). Fails when the destination is not UTF-8 text.
pub fn materialize_overlay(
    stable: &SkillPackage,
    content: &OverlayContent,
    declaration: Option<&SkillEvolutionDeclaration>,
) -> Result<SkillPackage, String> {
    let path = block_path(declaration);
    let block = render_block(content);
    let mut package = stable.clone();
    let existing = package
        .files
        .iter_mut()
        .find(|file| file.relative_path.to_string_lossy().replace('\\', "/") == path);
    match existing {
        Some(file) => {
            let text = std::str::from_utf8(&file.content)
                .map_err(|_| format!("`{path}` is not UTF-8 text"))?;
            let next = match split_block(text) {
                Some((before, _, after)) => format!("{before}{block}{after}"),
                None => {
                    let mut next = text.trim_end().to_string();
                    next.push_str("\n\n");
                    next.push_str(&block);
                    next.push('\n');
                    next
                }
            };
            file.content = next.into_bytes();
        }
        None => package.files.push(SkillPackageFile {
            relative_path: PathBuf::from(Path::new(&path)),
            content: format!("# Learned notes\n\n{block}\n").into_bytes(),
            executable: false,
        }),
    }
    Ok(package)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(body: &str) -> SkillPackage {
        SkillPackage {
            name: "deploy".into(),
            files: vec![SkillPackageFile {
                relative_path: PathBuf::from("SKILL.md"),
                content: format!(
                    "---\nname: deploy\ndescription: d\n---\n# Deploy\n\n## Format\nKeep tables.\n\n## Steps\n{body}\n"
                )
                .into_bytes(),
                executable: false,
            }],
        }
    }

    fn declaration(protected: &[&str], evolvable: &[&str]) -> SkillEvolutionDeclaration {
        SkillEvolutionDeclaration {
            target: SkillEvolutionTarget::Skill,
            protected: protected.iter().map(|item| item.to_string()).collect(),
            evolvable: evolvable.iter().map(|item| item.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn write_mode_honours_origin_setting_and_declaration() {
        let mut settings = EvolutionSettings::default();
        let declared = declaration(&[], &[]);
        assert_eq!(
            skill_write_mode(&settings, &SkillOrigin::UserCreated, Some(&declared)),
            EvolutionWriteMode::Overlay,
            "user-created skills need the setting"
        );
        assert_eq!(
            skill_write_mode(&settings, &SkillOrigin::AgentCreated, Some(&declared)),
            EvolutionWriteMode::SkillFile
        );
        settings.targets.skill.allow_file_edits = Some(true);
        assert_eq!(
            skill_write_mode(&settings, &SkillOrigin::UserCreated, None),
            EvolutionWriteMode::SkillFile
        );
        for origin in [
            SkillOrigin::Bundled,
            SkillOrigin::HubInstalled,
            SkillOrigin::ExternalDir,
        ] {
            assert_eq!(
                skill_write_mode(&settings, &origin, Some(&declared)),
                EvolutionWriteMode::Overlay
            );
        }
    }

    #[test]
    fn materialized_notes_round_trip_and_respect_protected_paths() {
        let stable = package("Run tests.");
        let decl = declaration(&["## Format"], &["references/lessons.md"]);
        let content = OverlayContent {
            lessons: "- Lead with the outcome.".into(),
            checklist: "- [ ] tests ran".into(),
            examples: vec![ProposalExample {
                name: "short".into(),
                text: "Deployed: ok".into(),
            }],
        };
        // Without an evolvable Markdown file the block goes into SKILL.md.
        let inline = materialize_overlay(&stable, &content, None).unwrap();
        assert_eq!(materialized_overlay(&inline, None), content);
        assert!(validate_skill_file_candidate(&stable, &inline, None).is_ok());
        // Re-materializing replaces the block instead of appending another.
        let again = materialize_overlay(&inline, &content, None).unwrap();
        assert_eq!(again, inline);

        let external = materialize_overlay(&stable, &content, Some(&decl)).unwrap();
        assert_eq!(materialized_overlay(&external, Some(&decl)), content);
        assert!(validate_skill_file_candidate(&stable, &external, Some(&decl)).is_ok());
        assert!(
            validate_skill_file_candidate(&stable, &external, None).is_err(),
            "an undeclared path is rejected"
        );

        let mut protected = stable.clone();
        protected.files[0].content = String::from_utf8(stable.files[0].content.clone())
            .unwrap()
            .replace("Keep tables.", "Use prose.")
            .into_bytes();
        let error = validate_skill_file_candidate(&stable, &protected, Some(&decl)).unwrap_err();
        assert!(error.contains("protected section"), "{error}");

        let mut renamed = stable.clone();
        renamed.files[0].content = String::from_utf8(stable.files[0].content.clone())
            .unwrap()
            .replace("description: d", "description: other")
            .into_bytes();
        assert!(validate_skill_file_candidate(&stable, &renamed, Some(&decl)).is_err());

        let mut escaped = stable.clone();
        escaped.files.push(SkillPackageFile {
            relative_path: PathBuf::from("scripts/run.sh"),
            content: b"rm -rf /".to_vec(),
            executable: true,
        });
        assert!(validate_skill_file_candidate(&stable, &escaped, Some(&decl)).is_err());
    }
}
