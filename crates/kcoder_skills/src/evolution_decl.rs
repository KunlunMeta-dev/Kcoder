//! Optional `evolution:` frontmatter declaration (plan section 5.4).
//!
//! ```yaml
//! evolution:
//!   enabled: true                    # false opts the skill out
//!   target: overlay                  # overlay (default) | skill
//!   protected: ["## Output format"]  # SKILL.md sections automatic edits keep
//!   evolvable: ["references/lessons.md", "examples/"]
//!   profile: [artifact]              # artifact | procedure | conversation
//!   categories: [opening, dialogue]
//!   eval: evals/evals.json
//!   creative: true                   # free-text output: diversity is checked
//! ```
//!
//! Every field is optional; a skill without the block uses the defaults.
//! The parser never fails discovery: an invalid block is reported to the
//! caller, which falls back to the defaults.

use serde::Deserialize;

/// Where learned content of a skill goes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillEvolutionTarget {
    #[default]
    Overlay,
    Skill,
}

/// Parsed `evolution:` block.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillEvolutionDeclaration {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub target: SkillEvolutionTarget,
    /// Section headings of `SKILL.md` automatic edits must keep unchanged.
    #[serde(default)]
    pub protected: Vec<String>,
    /// Package paths automatic edits may change (a trailing `/` marks a
    /// directory prefix).
    #[serde(default)]
    pub evolvable: Vec<String>,
    #[serde(default)]
    pub profile: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    /// Skill-creator `evals.json` path relative to the skill directory.
    #[serde(default)]
    pub eval: Option<String>,
    /// The skill produces free-form creative text.
    #[serde(default)]
    pub creative: Option<bool>,
}

#[derive(Deserialize)]
struct Frontmatter {
    #[serde(default)]
    evolution: Option<serde_yaml::Value>,
}

/// Bounds of the declaration lists.
const LIST_MAX: usize = 32;
const ITEM_MAX_CHARS: usize = 200;

/// Parse the `evolution:` block of a `SKILL.md` text. `Ok(None)` when the
/// skill declares nothing.
pub fn skill_evolution_declaration(
    skill_md: &str,
) -> Result<Option<SkillEvolutionDeclaration>, String> {
    let (frontmatter, _) = crate::split_skill_frontmatter(skill_md);
    if frontmatter.trim().is_empty() {
        return Ok(None);
    }
    let parsed: Frontmatter =
        serde_yaml::from_str(&frontmatter).map_err(|error| format!("frontmatter: {error}"))?;
    let Some(value) = parsed.evolution else {
        return Ok(None);
    };
    let declaration: SkillEvolutionDeclaration =
        serde_yaml::from_value(value).map_err(|error| format!("evolution block: {error}"))?;
    for list in [
        &declaration.protected,
        &declaration.evolvable,
        &declaration.profile,
        &declaration.categories,
    ] {
        if list.len() > LIST_MAX
            || list
                .iter()
                .any(|item| item.trim().is_empty() || item.chars().count() > ITEM_MAX_CHARS)
        {
            return Err("evolution block lists are bounded to 32 non-empty items".into());
        }
    }
    for path in declaration.evolvable.iter().chain(declaration.eval.iter()) {
        if path.starts_with('/')
            || path.contains('\\')
            || path.split('/').any(|part| part == ".." || part == ".")
        {
            return Err(format!(
                "evolution path must be relative and contained: {path}"
            ));
        }
    }
    Ok(Some(declaration))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_optional_block_and_rejects_escaping_paths() {
        let text = "---\nname: deploy\ndescription: d\nevolution:\n  target: skill\n  protected: [\"## Format\"]\n  evolvable: [references/lessons.md, examples/]\n  profile: [procedure]\n---\nbody\n";
        let declaration = skill_evolution_declaration(text).unwrap().unwrap();
        assert_eq!(declaration.target, SkillEvolutionTarget::Skill);
        assert_eq!(declaration.protected, vec!["## Format".to_string()]);
        assert_eq!(declaration.evolvable.len(), 2);
        assert!(
            skill_evolution_declaration("---\nname: plain\n---\nbody")
                .unwrap()
                .is_none()
        );
        assert!(
            skill_evolution_declaration("---\nevolution:\n  evolvable: [../escape]\n---\n")
                .is_err()
        );
        assert!(skill_evolution_declaration("---\nevolution:\n  unknown: 1\n---\n").is_err());
    }
}
