//! Preserve explicit package restrictions; omission inherits the task registry.
use super::*;

pub(super) fn expert_tool_selection(
    manifest: &Value,
    instructions: &str,
) -> Result<Option<Vec<String>>> {
    let mut selected = kcoder_skills::skill_tool_selection(instructions)?;
    let mut declared_before = false;
    for key in ["allowedTools", "allowed_tools", "allowed-tools"] {
        if let Some(value) = manifest.get(key) {
            let declared: Option<Vec<String>> = serde_json::from_value(value.clone())?;
            if declared_before || selected.is_some() {
                ensure!(selected == declared, "OFFICE_TOOL_SELECTION_CONFLICT");
            }
            selected = declared;
            declared_before = true;
        }
    }
    if let Some(tools) = &selected {
        ensure!(tools.len() <= 256, "OFFICE_INVALID_INPUT");
        let mut seen = std::collections::BTreeSet::new();
        for tool in tools {
            ensure!(
                !tool.is_empty()
                    && tool.len() <= 256
                    && !tool.chars().any(char::is_control)
                    && seen.insert(tool),
                "OFFICE_INVALID_INPUT"
            );
        }
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn market_tools_inherit_unless_the_definition_explicitly_selects_them() {
        assert_eq!(
            expert_tool_selection(&json!({}), "Instructions").unwrap(),
            None
        );
        assert_eq!(
            expert_tool_selection(&json!({"allowedTools":null}), "Instructions").unwrap(),
            None
        );
        assert_eq!(
            expert_tool_selection(&json!({"allowedTools":[]}), "Instructions").unwrap(),
            Some(vec![])
        );
        assert_eq!(
            expert_tool_selection(&json!({"allowed_tools":["read"]}), "Instructions").unwrap(),
            Some(vec!["read".into()])
        );
        assert_eq!(
            expert_tool_selection(&json!({}), "---\nallowed-tools: [read]\n---\nInstructions")
                .unwrap(),
            Some(vec!["read".into()])
        );
        assert!(
            expert_tool_selection(
                &json!({"allowedTools":["bash"]}),
                "---\nallowed-tools: [read]\n---\nInstructions"
            )
            .is_err()
        );
        assert!(expert_tool_selection(&json!({"allowedTools":false}), "Instructions").is_err());
    }
}
