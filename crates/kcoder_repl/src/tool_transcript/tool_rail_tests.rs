use super::*;

fn make_tool_msg(text: &str) -> DisplayMessage {
    DisplayMessage {
        role: MessageRole::System,
        text: text.to_string(),
    }
}

fn make_assistant_msg(text: &str) -> DisplayMessage {
    DisplayMessage {
        role: MessageRole::Assistant,
        text: text.to_string(),
    }
}

fn make_user_msg(text: &str) -> DisplayMessage {
    DisplayMessage {
        role: MessageRole::User,
        text: text.to_string(),
    }
}

fn label(p: Option<ToolRailPos>) -> &'static str {
    match p {
        None => "None",
        Some(ToolRailPos::Top) => "Top",
        Some(ToolRailPos::Middle) => "Middle",
        Some(ToolRailPos::Bottom) => "Bottom",
        Some(ToolRailPos::Single) => "Single",
    }
}

fn summarize(positions: &[Option<ToolRailPos>]) -> Vec<&'static str> {
    positions.iter().map(|p| label(*p)).collect()
}

#[test]
fn single_tool_message_renders_as_single_card() {
    let msgs = vec![make_tool_msg("✓ Tool succeeded: read\nstuff")];
    assert_eq!(summarize(&tool_rail_positions(&msgs)), vec!["Single"]);
}

#[test]
fn two_consecutive_tools_remain_independent_cards() {
    let msgs = vec![
        make_tool_msg("✓ Tool succeeded: read\nfoo"),
        make_tool_msg("✓ Tool succeeded: bash\nbar"),
    ];
    assert_eq!(
        summarize(&tool_rail_positions(&msgs)),
        vec!["Single", "Single"]
    );
}

#[test]
fn three_or_more_consecutive_tools_form_a_rail() {
    let msgs = vec![
        make_tool_msg("✓ Tool succeeded: read\na"),
        make_tool_msg("✓ Tool succeeded: read\nb"),
        make_tool_msg("✓ Tool succeeded: bash\nc"),
    ];
    assert_eq!(
        summarize(&tool_rail_positions(&msgs)),
        vec!["Top", "Middle", "Bottom"]
    );
}

#[test]
fn diff_message_is_not_part_of_tool_rail() {
    let msgs = vec![
        make_tool_msg("[Tool use: write] {\"file\":\"a.rs\"}"),
        make_tool_msg("✓ Tool succeeded: write - Wrote a.rs"),
        make_tool_msg("[Tool diff: write]\nWrote a.rs\n@@ -1 +1 @@\n-old\n+new"),
    ];
    assert_eq!(
        summarize(&tool_rail_positions(&msgs)),
        vec!["Single", "Single", "None"]
    );
}

#[test]
fn tools_from_different_turns_are_not_grouped() {
    // Two independent turns, each issuing one tool. The messages
    // happen to be adjacent in the transcript, but they are
    // semantically distinct and must not be folded into a rail.
    let msgs = vec![
        make_user_msg("first request"),
        make_assistant_msg(""),
        make_tool_msg("✓ Tool succeeded: read\na"),
        make_assistant_msg("second turn begins"),
        make_tool_msg("✓ Tool succeeded: bash\nb"),
    ];
    assert_eq!(
        summarize(&tool_rail_positions(&msgs)),
        vec!["None", "None", "Single", "None", "Single"]
    );
}

#[test]
fn very_long_run_keeps_visual_rail() {
    let msgs: Vec<DisplayMessage> = (0..5)
        .map(|i| make_tool_msg(&format!("✓ Tool succeeded: read\ncall {i}")))
        .collect();
    let s = summarize(&tool_rail_positions(&msgs));
    assert_eq!(s, vec!["Top", "Middle", "Middle", "Middle", "Bottom"]);
}
