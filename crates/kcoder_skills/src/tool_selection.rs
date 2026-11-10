//! Download metadata narrows task tools; missing metadata inherits them.
use anyhow::{Result, ensure};
use serde::Deserialize;

#[derive(Deserialize, Default)]
struct ToolSelection {
    #[serde(
        default,
        rename = "allowed_tools",
        alias = "allowed-tools",
        alias = "allowedTools"
    )]
    allowed_tools: Option<Vec<String>>,
}

/// Parse only inert frontmatter. No files, accounts or permissions are opened.
pub fn skill_tool_selection(content: &str) -> Result<Option<Vec<String>>> {
    let (frontmatter, _) = super::split_frontmatter(content);
    let selected = if frontmatter.trim().is_empty() {
        ToolSelection::default()
    } else {
        serde_yaml::from_str::<ToolSelection>(&frontmatter)?
    };
    if let Some(tools) = &selected.allowed_tools {
        ensure!(tools.len() <= 256, "SKILL_TOOL_SELECTION_INVALID");
        let mut seen = std::collections::BTreeSet::new();
        for tool in tools {
            ensure!(
                !tool.is_empty()
                    && tool.len() <= 256
                    && !tool.chars().any(char::is_control)
                    && seen.insert(tool),
                "SKILL_TOOL_SELECTION_INVALID"
            );
        }
    }
    Ok(selected.allowed_tools)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_inherits_and_explicit_empty_disables_without_inventing_permissions() {
        for content in ["Instructions", "---\nname: Notes\n---\nInstructions"] {
            assert_eq!(skill_tool_selection(content).unwrap(), None);
        }
        for key in ["allowed_tools", "allowed-tools", "allowedTools"] {
            assert_eq!(
                skill_tool_selection(&format!("---\n{key}: []\n---\nInstructions")).unwrap(),
                Some(vec![])
            );
            assert_eq!(
                skill_tool_selection(&format!("---\n{key}: [read, bash]\n---\nInstructions"))
                    .unwrap(),
                Some(vec!["read".into(), "bash".into()])
            );
        }
        assert!(skill_tool_selection("---\nallowed-tools: true\n---\nInstructions").is_err());
        assert!(
            skill_tool_selection("---\nallowed-tools: [read, read]\n---\nInstructions").is_err()
        );
    }
}
