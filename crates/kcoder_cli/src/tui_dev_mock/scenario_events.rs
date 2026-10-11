use super::MockScenarioProvider;
use kcoder_types::{
    ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent, StreamingMessage,
};

impl MockScenarioProvider {
    pub(super) fn markdown_streaming_events() -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>>
    {
        let mut text = String::from("```rust\n");
        for line in 1..=2400 {
            text.push_str(&format!(
                "let color = \"stream\"; // codex-stream-line-{line:04}\n"
            ));
        }
        text.push_str(
            "```\n\n## Markdown palette\n\n\
             > quote_green\n\n\
             `inline_cyan` and [link_cyan](https://example.com)\n\n\
             1. ordered_blue\n\n\
             | Header | Style |\n\
             | --- | --- |\n\
             | Table | Theme |\n\n\
             tui-lab-final-sentinel",
        );
        mock_assistant_text_events(vec![MockBlock::Text(text)])
    }

    pub(super) fn markdown_showcase_events() -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        let mut text = String::from(
            "# H1 · bold underline\n\
             ## H2 · bold\n\
             ### H3 · bold italic\n\
             #### H4 · italic\n\
             ##### H5 · italic\n\
             ###### H6 · italic\n\n\
             Body text remains clear and supports **bold**, *italic*, ~~strikethrough~~, and `inline_code()`.\n\n\
             > Blockquotes use full-row green while preserving cyan for `code`.\n\n\
             - Unordered lists use the terminal default color\n\
             1. Ordered lists use light blue\n\
             - [ ] Task markers use the default color\n\
             - [x] Completed task markers use the default color\n\n\
             [KCoder link](https://example.com/kcoder-style)\n\n\
             ---\n\n\
             | Semantics | Style source |\n\
             | --- | --- |\n\
             | Header | Active syntax theme |\n\
             | Separator | Neutral DIM |\n\n\
             ```rust\n\
             pub fn render_mode(enabled: bool) -> &'static str {\n\
                 if enabled { \"color\" } else { \"gray\" }\n\
             }\n\
             ```\n\n",
        );
        for line in 1..=120 {
            text.push_str(&format!("tui-lab-final-line-{line:03}\n"));
        }
        text.push_str(
            "\ntui-lab-final-sentinel\nComprehensive Markdown scenario rendering complete.",
        );

        mock_assistant_text_events(vec![
            MockBlock::Thinking(
                "Rendering the Markdown style vocabulary through the real streaming path."
                    .to_string(),
            ),
            MockBlock::Text(text),
        ])
    }

    pub(super) fn orchestrate_control_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        const SPAWN_ID: &str = "tui-lab-orchestrate-control-spawn";
        const PAUSE_ID: &str = "tui-lab-orchestrate-control-pause";
        const SEND_ID: &str = "tui-lab-orchestrate-control-send";
        const FLEET_ID: &str = "tui-lab-orchestrate-control-fleet";
        const WORKER_SENTINEL: &str = "tui-lab-orchestrate-control-worker";

        if request_has_tool_result(request, FLEET_ID)
            && let Some(user_text) = plain_user_text_after_latest_tool_result(request, FLEET_ID)
        {
            return mock_assistant_text_events(vec![MockBlock::Text(format!(
                "Received new input after orchestration resumed: {}\nThe paused agent and reliable queue remain unchanged.\n\ntui-lab-second-turn-sentinel",
                short_preview(&user_text, 120)
            ))]);
        }

        if request_text_contains(request, WORKER_SENTINEL)
            && request_text_contains(request, "Global sub-agent contract")
        {
            let mut text = String::from(
                "tui-lab-orchestrate-control-worker-done\nThe sub-agent reached a complete model-response boundary.\n",
            );
            for line in 1..=48 {
                text.push_str(&format!("worker-safe-boundary-line-{line:03}\n"));
            }
            return mock_assistant_text_events(vec![MockBlock::Text(text)]);
        }

        if request_has_tool_result(request, FLEET_ID) {
            let fleet = latest_tool_result_text(request, FLEET_ID).unwrap_or_default();
            let observed_control = fleet.contains("pause_requested") || fleet.contains("paused");
            let mut text = format!(
                "The deterministic orchestration control-plane scenario completed; AgentFleet observed control state: {observed_control}.\n"
            );
            for line in 1..=120 {
                text.push_str(&format!("tui-lab-final-line-{line:03}\n"));
            }
            text.push_str("tui-lab-orchestrate-control-final-sentinel\ntui-lab-final-sentinel");
            return mock_assistant_text_events(vec![MockBlock::Text(text)]);
        }

        let spawned_agent_id = tool_result_agent_id(request, SPAWN_ID)
            .unwrap_or_else(|| "missing-agent-id".to_string());
        if request_has_tool_result(request, SEND_ID) {
            return mock_assistant_text_events(vec![MockBlock::ToolUse {
                id: FLEET_ID.to_string(),
                name: "AgentFleet".to_string(),
                input: serde_json::json!({"include_terminal": true, "limit": 24}),
            }]);
        }
        if request_has_tool_result(request, PAUSE_ID) {
            return mock_assistant_text_events(vec![MockBlock::ToolUse {
                id: SEND_ID.to_string(),
                name: "SendMessage".to_string(),
                input: serde_json::json!({
                    "agent_id": spawned_agent_id,
                    "message": "tui-lab durable message queued while pause is pending"
                }),
            }]);
        }
        if request_has_tool_result(request, SPAWN_ID) {
            return mock_assistant_text_events(vec![MockBlock::ToolUse {
                id: PAUSE_ID.to_string(),
                name: "ControlAgent".to_string(),
                input: serde_json::json!({
                    "agent_id": spawned_agent_id,
                    "action": "pause",
                    "expected_control_revision": 0,
                    "reason": "tui-lab safe-boundary pause verification"
                }),
            }]);
        }

        mock_assistant_text_events(vec![
            MockBlock::Thinking(
                "Start a background sub-agent, pause it through the structured control plane, and write a message to its reliable queue.".to_string(),
            ),
            MockBlock::ToolUse {
                id: SPAWN_ID.to_string(),
                name: "spawn_agent".to_string(),
                input: serde_json::json!({
                    "agent_type": "general",
                    "message": format!(
                        "{WORKER_SENTINEL}: return a bounded report after reaching a safe response boundary"
                    ),
                    "max_turns": 16,
                    "run_in_background": true
                }),
            },
        ])
    }

    pub(super) fn orchestrate_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        const TOOL_ID: &str = "tui-lab-orchestrate-read";
        let user_text = last_plain_user_text(&request.messages)
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "empty user prompt".to_string());
        if latest_user_has_tool_result(request, TOOL_ID) {
            let mut text = format!(
                "The read-only orchestration turn completed. User input: {}\n\n```text\n",
                short_preview(&user_text, 120)
            );
            for line in 1..=120 {
                text.push_str(&format!("tui-lab-final-line-{line:03}\n"));
            }
            text.push_str("```\n\ntui-lab-orchestrate-final-sentinel\ntui-lab-final-sentinel");
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(
                    "The read-only tool result returned; the primary orchestrator remained inside its permission boundary.".to_string(),
                ),
                MockBlock::Text(text),
            ]);
        }
        if request_has_tool_result(request, TOOL_ID) {
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(
                    "This is a regular second user input after the orchestration tool turn completed.".to_string(),
                ),
                MockBlock::Text(format!(
                    "Received the second orchestration message: {}\n\nNo tool state from the previous turn was reused.\n\ntui-lab-second-turn-sentinel",
                    short_preview(&user_text, 120)
                )),
            ]);
        }
        mock_assistant_text_events(vec![
            MockBlock::Thinking(
                "tui-lab-tool-start: I will use the read tool allowed for the primary orchestrator to inspect a fixed workspace file without bash/edit/write."
                    .to_string(),
            ),
            MockBlock::ToolUse {
                id: TOOL_ID.to_string(),
                name: "read".to_string(),
                input: serde_json::json!({
                    "file_path": "README.md",
                    "offset": 1,
                    "limit": 12
                }),
            },
        ])
    }

    pub(super) fn goal_pro_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        const TOOL_ID: &str = "tui-lab-goal-pro-update";
        if request_text_contains(request, "Independently review this Strict Goal")
            || request_text_contains(request, "first line must strictly be PASS")
        {
            return mock_assistant_text_events(vec![MockBlock::Text(
                "PASS\nThe goal, creation-time context, and current workspace were checked; the deterministic Goal Pro scenario meets its acceptance criteria."
                    .to_string(),
            )]);
        }
        if latest_user_has_tool_result(request, TOOL_ID) {
            return mock_assistant_text_events(vec![MockBlock::Text(
                "Goal Pro passed its independent verifier and status was updated to complete.\n\ntui-lab-goal-pro-final-sentinel\ntui-lab-final-sentinel"
                    .to_string(),
            )]);
        }
        mock_assistant_text_events(vec![
            MockBlock::Thinking(
                "The goal is satisfied; I will request update_goal and wait for the independent verifier's completion decision."
                    .to_string(),
            ),
            MockBlock::ToolUse {
                id: TOOL_ID.to_string(),
                name: "update_goal".to_string(),
                input: serde_json::json!({"status": "complete"}),
            },
        ])
    }

    pub(super) fn full_turn_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        Self::counted_turn_events(request, 120)
    }

    pub(super) fn tail_follow_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        Self::counted_turn_events(request, 500)
    }

    fn counted_turn_events(
        request: &MessagesRequest,
        line_count: usize,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        const TOOL_ID: &str = "tui-lab-counted-lines";
        if request.messages.iter().any(|message| {
            let preview = message.preview(2_000);
            preview.contains("<analysis> block followed by a <summary> block")
                || preview.contains("In <summary>, use these sections")
        }) {
            return mock_assistant_text_events(vec![MockBlock::Text(
                "<analysis>checked deterministic app-server transcript</analysis><summary>Deterministic compact summary for the app-server protocol integration test.</summary>"
                    .to_string(),
            )]);
        }
        let user_text = last_plain_user_text(&request.messages)
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "empty user prompt".to_string());
        let has_live_steer =
            user_text_follows_latest_tool_result_without_assistant(request, TOOL_ID);

        if latest_user_has_tool_result(request, TOOL_ID)
            || request_has_subagent_notification(request)
            || has_live_steer
        {
            let mut text = String::new();
            text.push_str("I received your message: ");
            text.push_str(&short_preview(&user_text, 120));
            text.push_str("\n\nThe tool call returned. A long counted-output region follows to exercise transcript scrolling, screenshots, and the scrollbar.\n");
            text.push_str("\n```text\n");
            for line in 1..=line_count {
                text.push_str(&format!("tui-lab-final-line-{line:03}\n"));
            }
            text.push_str("```\n\n");
            text.push_str("tui-lab-final-sentinel\n");
            text.push_str("Complete: user input, model thinking, model tool calls, tool results, the final response, and long counted output all passed through the real TUI rendering path.");
            if has_live_steer {
                text.push_str("\n\ntui-lab-live-steer-sentinel\nNew input after tool completion entered the next model request within the same turn.");
            }
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(format!(
                    "The tool result entered context; now produce the final answer from the original user message: {}",
                    short_preview(&user_text, 80)
                )),
                MockBlock::Text(text),
            ]);
        }

        if request_has_tool_result(request, TOOL_ID) {
            let text = format!(
                "Received the regular second-turn test message: {}\n\nThe previous Bash call was not triggered again and prior assistant streaming state was not reused.\n\ntui-lab-second-turn-sentinel",
                short_preview(&user_text, 160)
            );
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(format!(
                    "This is a regular second-turn user message after the tool turn completed: {}",
                    short_preview(&user_text, 100)
                )),
                MockBlock::Text(text),
            ]);
        }

        let delay_ms = std::env::var("KCODER_TUI_LAB_FULL_TURN_TOOL_DELAY_MS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(0)
            .min(10_000);
        let delay = if delay_ms == 0 {
            String::new()
        } else {
            format!("sleep {}.{:03}; ", delay_ms / 1_000, delay_ms % 1_000)
        };
        let command = format!(
            "printf 'tui-lab-tool-start\\n'; {delay}i=1; while [ \"$i\" -le 420 ]; do printf 'tui-lab-tool-line-%03d\\n' \"$i\"; i=$((i + 1)); done; printf 'tui-lab-tool-end\\n'"
        );
        mock_assistant_text_events(vec![
            MockBlock::Thinking(format!(
                "Received user message: {}. I will call Bash to generate long counted output and verify TUI scrolling and the tool-result area.",
                short_preview(&user_text, 100)
            )),
            MockBlock::ToolUse {
                id: TOOL_ID.to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({
                    "command": command,
                    "description": "TUI lab counted-line output smoke",
                    "timeout": 20000
                }),
            },
        ])
    }

    pub(super) fn busy_wait_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        const TOOL_ID: &str = "tui-lab-busy-wait";
        if latest_user_has_tool_result(request, TOOL_ID) {
            return mock_assistant_text_events(vec![MockBlock::Text(
                "The silent-wait tool completed.\n\ntui-lab-busy-wait-final-sentinel".to_string(),
            )]);
        }

        mock_assistant_text_events(vec![
            MockBlock::Thinking(
                "I will call a Bash command that waits silently for several seconds to verify that continuous activity feedback remains visible."
                    .to_string(),
            ),
            MockBlock::ToolUse {
                id: TOOL_ID.to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({
                    "command": "printf 'tui-lab-busy-wait-start\\n'; sleep 12; printf 'tui-lab-busy-wait-end\\n'",
                    "description": "Wait silently for busy indicator review",
                    "timeout": 20000
                }),
            },
        ])
    }

    pub(super) fn long_write_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        const WRITE_ID: &str = "tui-lab-long-write";
        const DELETE_ID: &str = "tui-lab-long-write-delete";
        const FILE_PATH: &str = "tui-lab-long-write.txt";

        if latest_user_has_tool_result(request, DELETE_ID) {
            return mock_assistant_text_events(vec![MockBlock::Text(
                "Generation of the 20K Write input, file write, and deletion all completed.\n\ntui-lab-long-write-final-sentinel\n"
                    .to_string(),
            )]);
        }

        if latest_user_has_tool_result(request, WRITE_ID) {
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(
                    "Write completed; now delete the test file and confirm that the deletion phase is visible.".to_string(),
                ),
                MockBlock::ToolUse {
                    id: DELETE_ID.to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({
                        "command": format!("rm -f {FILE_PATH} && printf 'tui-lab-long-write-deleted\\n'"),
                        "description": "Delete the 20K TUI progress fixture",
                        "timeout": 20_000
                    }),
                },
            ]);
        }

        let content = (1..=520)
            .map(|line| {
                format!(
                    "line-{line:04}: deterministic long write progress fixture for TUI review and resize checks\n"
                )
            })
            .collect::<String>();
        mock_assistant_text_events_path_first(vec![
            MockBlock::Thinking(
                "I will generate a Write input longer than 20K characters, write it, and then delete the test file.".to_string(),
            ),
            MockBlock::ToolUse {
                id: WRITE_ID.to_string(),
                name: "write".to_string(),
                input: serde_json::json!({
                    "file_path": FILE_PATH,
                    "content": content
                }),
            },
        ], request.path_first_tools)
    }

    pub(super) fn thinking_preview_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        let user_text = last_plain_user_text(&request.messages)
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "empty user prompt".to_string());
        let thinking = (1..=18)
            .map(|step| {
                format!(
                    "**Reasoning step {step:02}** Reviewing the latest evidence for a fixed-height transcript preview while preserving the newest visible content.\n"
                )
            })
            .collect::<String>();
        mock_assistant_text_events(vec![
            MockBlock::Thinking(thinking),
            MockBlock::Text(format!(
                "thinking preview complete\n\nUser input: {}",
                short_preview(&user_text, 120)
            )),
        ])
    }

    pub(super) fn mixed_tools_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        const TOOL_IDS: &[&str] = &[
            "tui-lab-mixed-read",
            "tui-lab-mixed-grep",
            "tui-lab-mixed-todo",
            "tui-lab-mixed-bash",
            "tui-lab-mixed-edit",
        ];
        let user_text = last_plain_user_text(&request.messages)
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "empty user prompt".to_string());

        if latest_user_has_any_tool_result(request, TOOL_IDS) {
            let mut text = String::new();
            text.push_str("Mixed tool calls completed: read / grep / TodoWrite / bash / edit all used the real tool path.\n");
            text.push_str("This scenario verifies default collapsing of consecutive tool calls and ensures an edit diff does not expand the committed area while collapsed.\n\n");
            text.push_str("```text\n");
            for line in 1..=120 {
                text.push_str(&format!("tui-lab-final-line-{line:03}\n"));
            }
            text.push_str("```\n\n");
            text.push_str("tui-lab-mixed-tools-final-sentinel\n");
            text.push_str("tui-lab-final-sentinel\n");
            text.push_str(&format!(
                "Complete: the mixed-tool collapsing scenario returned its final response. User input preview: {}",
                short_preview(&user_text, 120)
            ));
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(
                    "Every mixed-tool result entered context; now emit the final long-text tail for scroll validation."
                        .to_string(),
                ),
                MockBlock::Text(text),
            ]);
        }

        if request_has_any_tool_result(request, TOOL_IDS) {
            let text = format!(
                "Received the regular second-turn test message: {}\n\nMixed tool calls were not triggered again and prior assistant streaming state was not reused.\n\ntui-lab-second-turn-sentinel",
                short_preview(&user_text, 160)
            );
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(format!(
                    "This is a regular second-turn user message after the mixed-tool turn completed: {}",
                    short_preview(&user_text, 100)
                )),
                MockBlock::Text(text),
            ]);
        }

        let command = "printf 'tui-lab-tool-start\\n'; i=1; while [ \"$i\" -le 40 ]; do printf 'tui-lab-tool-line-%03d\\n' \"$i\"; i=$((i + 1)); done; printf 'tui-lab-tool-end\\n'";
        mock_assistant_text_events(vec![
            MockBlock::Thinking(format!(
                "Received user message: {}. I will call several tools in sequence and verify that the TUI collapses consecutive calls into one summary.",
                short_preview(&user_text, 100)
            )),
            MockBlock::ToolUse {
                id: "tui-lab-mixed-read".to_string(),
                name: "read".to_string(),
                input: serde_json::json!({
                    "file_path": "src/sample.txt",
                    "offset": 1,
                    "limit": 20
                }),
            },
            MockBlock::ToolUse {
                id: "tui-lab-mixed-grep".to_string(),
                name: "grep".to_string(),
                input: serde_json::json!({
                    "pattern": "sample",
                    "path": "src",
                    "output_mode": "content",
                    "head_limit": 20
                }),
            },
            MockBlock::ToolUse {
                id: "tui-lab-mixed-edit".to_string(),
                name: "edit".to_string(),
                input: serde_json::json!({
                    "file_path": "src/sample.txt",
                    "old_string": "sample workspace file",
                    "new_string": "sample workspace file edited by mixed tool scenario"
                }),
            },
            MockBlock::ToolUse {
                id: "tui-lab-mixed-todo".to_string(),
                name: "TodoWrite".to_string(),
                input: serde_json::json!({
                    "TodoList": [
                        {
                            "content": "Verify mixed tool folding",
                            "activeForm": "Verifying mixed tool folding",
                            "status": "in_progress"
                        },
                        {
                            "content": "Check Alt+T expansion",
                            "activeForm": "Checking Alt+T expansion",
                            "status": "pending"
                        }
                    ]
                }),
            },
            MockBlock::ToolUse {
                id: "tui-lab-mixed-bash".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({
                    "command": command,
                    "description": "TUI lab short counted output inside mixed tool storm",
                    "timeout": 20000
                }),
            },
        ])
    }

    pub(super) fn lsp_diagnostics_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        const TOOL_ID: &str = "tui-lab-lsp-write";
        let user_text = last_plain_user_text(&request.messages)
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "empty user prompt".to_string());

        if request_has_tool_result(request, TOOL_ID) || request_has_subagent_notification(request) {
            let tool_text = latest_tool_result_text(request, TOOL_ID).unwrap_or_default();
            let saw_diagnostics = tool_text.contains("<diagnostics source=\"lsp\"")
                && tool_text.contains("server=\"pyright\"")
                && tool_text.contains("reportArgumentType");
            let mut text = String::new();
            text.push_str("LSP diagnostics scenario complete.\n");
            text.push_str(&format!(
                "The tool result {} real pyright LSP diagnostics.\n\n",
                if saw_diagnostics {
                    "contains"
                } else {
                    "does not contain"
                }
            ));
            text.push_str("tui-lab-lsp-diagnostics-final-sentinel\n");
            text.push_str("tui-lab-final-sentinel\n");
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(format!(
                    "The Write result entered the next model request; LSP diagnostics visible: {saw_diagnostics}. User input: {}",
                    short_preview(&user_text, 100)
                )),
                MockBlock::Text(text),
            ]);
        }

        let content = r#"# pyright: strict

def takes_int(value: int) -> int:
    return value + 1

result: int = takes_int("not-an-int")
print(result)
"#;
        mock_assistant_text_events(vec![
            MockBlock::Thinking(format!(
                "Received user message: {}. I will write a Python type-error file so the real pyright LSP returns diagnostics after Write.",
                short_preview(&user_text, 100)
            )),
            MockBlock::ToolUse {
                id: TOOL_ID.to_string(),
                name: "write".to_string(),
                input: serde_json::json!({
                    "file_path": "src/diagnostic-fixture/lsp_case.py",
                    "content": content
                }),
            },
        ])
    }

    pub(super) fn ocr_review_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        const TOOL_ID: &str = "tui-lab-ocr-preview";
        let user_text = last_plain_user_text(&request.messages)
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "empty user prompt".to_string());

        if latest_user_has_tool_result(request, TOOL_ID) {
            let tool_text = latest_tool_result_text(request, TOOL_ID).unwrap_or_default();
            let saw_preview = tool_text.contains("OpenCodeReview command:")
                && tool_text.contains("ocr review")
                && tool_text.contains("--preview");
            let mut text = String::new();
            text.push_str("OCR preview scenario complete.\n");
            text.push_str(&format!(
                "The tool result {} OpenCodeReview preview output.\n\n",
                if saw_preview {
                    "contains"
                } else {
                    "does not contain"
                }
            ));
            text.push_str("tui-lab-ocr-review-final-sentinel\n");
            text.push_str("tui-lab-final-sentinel\n");
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(format!(
                    "The OCR result entered the next model request; preview visible: {saw_preview}. User input: {}",
                    short_preview(&user_text, 100)
                )),
                MockBlock::Text(text),
            ]);
        }

        mock_assistant_text_events(vec![
            MockBlock::Thinking(format!(
                "Received user message: {}. I will first call preview mode on the built-in OCR tool to confirm review scope before a long full review.",
                short_preview(&user_text, 100)
            )),
            MockBlock::ToolUse {
                id: TOOL_ID.to_string(),
                name: "ocr".to_string(),
                input: serde_json::json!({
                    "command": "review",
                    "preview": true,
                    "format": "text",
                    "timeoutMinutes": 1,
                    "concurrency": 1
                }),
            },
        ])
    }

    pub(super) fn subagent_trace_events(
        request: &MessagesRequest,
    ) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
        const TOOL_ID: &str = "tui-lab-spawn-agent";
        const WORKER_SENTINEL: &str = "tui-lab-subagent-worker-sentinel";
        const LIVE_STEER_POLL: &str = "app-server-live-steer-lab";
        const LIVE_STEER_POLL_TOOL: &str = "tui-lab-worker-poll";
        const LIVE_STEER_POLL_LIMIT: usize = 40;

        if request_text_contains(request, WORKER_SENTINEL)
            && request_text_contains(request, "Global sub-agent contract")
        {
            // A live-steer check needs a worker that is still running when the steer
            // arrives: the engine only acknowledges a queued message at the safe
            // boundary before the next model request, so a worker that answers its
            // single request with a final text can never report it. Keep requesting
            // until the delegated task text shows the steer landed.
            let live_steer_worker = subagent_contract_text(request)
                .is_some_and(|contract| contract.contains(LIVE_STEER_POLL));
            let steered = request_text_contains(request, "APP_SERVER_TARGETED_STEER_SENTINEL");
            if live_steer_worker
                && !steered
                && count_tool_uses(request, LIVE_STEER_POLL_TOOL) < LIVE_STEER_POLL_LIMIT
            {
                return mock_assistant_text_events(vec![
                    MockBlock::Thinking(
                        "The live-steer worker keeps one request in flight so a queued steer has a safe boundary to land on."
                            .to_string(),
                    ),
                    MockBlock::ToolUse {
                        id: LIVE_STEER_POLL_TOOL.to_string(),
                        name: "TodoWrite".to_string(),
                        input: serde_json::json!({
                            "todos": [{
                                "content": "wait for a live steer",
                                "activeForm": "waiting for a live steer",
                                "status": "in_progress"
                            }]
                        }),
                    },
                ]);
            }
            let mut report = String::from(
                "tui-lab-subagent-worker-done\n\nSub-agent trace worker completed its bounded inspection.\n",
            );
            if request_text_contains(request, "STUDIO_TARGETED_SUBAGENT_STEER_E2E") {
                report.push_str("tui-lab-targeted-steer-observed\n");
            }
            if is_targeted_steer_worker(request) {
                for index in 1..=180 {
                    report.push_str(&format!(
                        "tui-lab-child-line-{index:03}: durable child transcript viewport evidence\n"
                    ));
                }
            }
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(
                    "subagent-trace worker request detected; return a concise final report."
                        .to_string(),
                ),
                MockBlock::Text(report),
            ]);
        }

        if request_text_contains(request, "TUI_LAB_PARENT_INPUT_SENTINEL") {
            return mock_assistant_text_events(vec![MockBlock::Text(
                "TUI_LAB_PARENT_INPUT_ACK".to_string(),
            )]);
        }

        if request_has_subagent_notification(request) {
            return mock_assistant_text_events(vec![MockBlock::Text(
                "subagent completion notification observed; no further spawn is needed."
                    .to_string(),
            )]);
        }

        if request_has_tool_result(request, TOOL_ID) {
            let mut text = String::new();
            text.push_str("Sub-agent trace scenario complete.\n");
            text.push_str("The primary model started a sub-agent through spawn_agent; its transcript, output, and raw LLM exchanges should be stored under the session's subagents directory.\n\n");
            text.push_str("tui-lab-subagent-trace-final-sentinel\n");
            text.push_str("tui-lab-final-sentinel\n");
            return mock_assistant_text_events(vec![
                MockBlock::Thinking(
                    "The spawn_agent result returned; now produce the final response for the primary session.".to_string(),
                ),
                MockBlock::Text(text),
            ]);
        }

        let targeted_steer_lab = request_text_contains(request, "tui-lab-targeted-subagent-steer");
        let targeted_stop_lab = request_text_contains(request, "tui-lab-targeted-subagent-stop");
        let run_in_background = targeted_steer_lab
            || targeted_stop_lab
            || request_text_contains(request, "app-server-background-subagent");
        let live_steer_lab = request_text_contains(request, "APP_SERVER_LIVE_STEER_LAB");
        let target_message = if targeted_steer_lab {
            format!(
                "{WORKER_SENTINEL} tui-lab-targeted-subagent-steer-long-transcript target: Inspect the copied workspace README and return the phrase tui-lab-subagent-worker-done."
            )
        } else if live_steer_lab {
            format!(
                "{WORKER_SENTINEL} app-server-live-steer-lab target: Inspect the copied workspace README and return the phrase tui-lab-subagent-worker-done."
            )
        } else {
            format!(
                "{WORKER_SENTINEL} target: Inspect the copied workspace README and return the phrase tui-lab-subagent-worker-done."
            )
        };
        let mut blocks = vec![
            MockBlock::Thinking(
                "Received the user message. I will start a lightweight sub-agent to verify that its records persist independently."
                    .to_string(),
            ),
            MockBlock::ToolUse {
                id: TOOL_ID.to_string(),
                name: "spawn_agent".to_string(),
                input: serde_json::json!({
                    "agent_type": "general",
                    "message": target_message,
                    "max_turns": 60,
                    "run_in_background": run_in_background
                }),
            },
        ];
        if targeted_steer_lab || targeted_stop_lab {
            blocks.push(MockBlock::ToolUse {
                id: "tui-lab-spawn-agent-sibling".to_string(),
                name: "spawn_agent".to_string(),
                input: serde_json::json!({
                    "agent_type": "general",
                    "message": format!("{WORKER_SENTINEL} sibling: Independently inspect the copied workspace README and return the phrase tui-lab-subagent-worker-done."),
                    "max_turns": 60,
                    "run_in_background": true
                }),
            });
        }
        mock_assistant_text_events(blocks)
    }
}

enum MockBlock {
    Thinking(String),
    Text(String),
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
}

fn mock_assistant_text_events(
    blocks: Vec<MockBlock>,
) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
    mock_assistant_text_events_path_first(blocks, false)
}

fn mock_assistant_text_events_path_first(
    blocks: Vec<MockBlock>,
    path_first: bool,
) -> Vec<Result<StreamEvent, kcoder_api::ApiErrorKind>> {
    let mut events = vec![Ok(StreamEvent::MessageStart {
        message: StreamingMessage {
            id: "tui-dev-message".to_string(),
            role: "assistant".to_string(),
            content: Vec::new(),
            model: "tui-dev-mock".to_string(),
            stop_reason: None,
            stop_sequence: None,
            usage: None,
        },
    })];

    for (index, block) in blocks.into_iter().enumerate() {
        match block {
            MockBlock::Thinking(thinking) => {
                events.push(Ok(StreamEvent::ContentBlockStart {
                    index,
                    content_block: ContentBlock::Thinking {
                        thinking: String::new(),
                        signature: String::new(),
                    },
                }));
                let chunk_chars = std::env::var("KCODER_TUI_LAB_THINKING_CHUNK_CHARS")
                    .ok()
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(128);
                for thinking in chunk_text(&thinking, chunk_chars) {
                    events.push(Ok(StreamEvent::ContentBlockDelta {
                        index,
                        delta: ContentDelta::ThinkingDelta { thinking },
                    }));
                }
                events.push(Ok(StreamEvent::ContentBlockDelta {
                    index,
                    delta: ContentDelta::SignatureDelta {
                        signature: "tui-dev-signature".to_string(),
                    },
                }));
                events.push(Ok(StreamEvent::ContentBlockStop { index }));
            }
            MockBlock::Text(text) => {
                events.push(Ok(StreamEvent::ContentBlockStart {
                    index,
                    content_block: ContentBlock::Text {
                        text: String::new(),
                    },
                }));
                let chunk_chars = std::env::var("KCODER_TUI_LAB_TEXT_CHUNK_CHARS")
                    .ok()
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(128);
                for chunk in chunk_text(&text, chunk_chars) {
                    events.push(Ok(StreamEvent::ContentBlockDelta {
                        index,
                        delta: ContentDelta::TextDelta { text: chunk },
                    }));
                }
                events.push(Ok(StreamEvent::ContentBlockStop { index }));
            }
            MockBlock::ToolUse { id, name, input } => {
                events.push(Ok(StreamEvent::ContentBlockStart {
                    index,
                    content_block: ContentBlock::ToolUse {
                        id,
                        name,
                        input: serde_json::Value::Object(serde_json::Map::new()),
                    },
                }));
                let input = if path_first && input.get("file_path").is_some() {
                    // Preserve the fixture payload while mirroring path-first wire order.
                    let mut rest = input.clone();
                    let path = rest.as_object_mut().unwrap().remove("file_path").unwrap();
                    let rest = rest.to_string();
                    format!("{{\"file_path\":{path},{}", &rest[1..])
                } else {
                    input.to_string()
                };
                let chunk_chars = std::env::var("KCODER_TUI_LAB_TOOL_INPUT_CHUNK_CHARS")
                    .ok()
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .filter(|value| *value > 0)
                    .unwrap_or_else(|| input.chars().count().max(1));
                for partial_json in chunk_text(&input, chunk_chars) {
                    events.push(Ok(StreamEvent::ContentBlockDelta {
                        index,
                        delta: ContentDelta::InputJsonDelta { partial_json },
                    }));
                }
                events.push(Ok(StreamEvent::ContentBlockStop { index }));
            }
        }
    }

    events.push(Ok(StreamEvent::MessageStop));
    events
}

fn request_has_tool_result(request: &MessagesRequest, tool_use_id: &str) -> bool {
    request.messages.iter().any(|message| {
        message_content(message).iter().any(|block| {
            matches!(
                block,
                ContentBlock::ToolResult {
                    tool_use_id: id,
                    ..
                } if id == tool_use_id
            )
        })
    })
}

fn request_has_any_tool_result(request: &MessagesRequest, tool_use_ids: &[&str]) -> bool {
    tool_use_ids
        .iter()
        .any(|tool_use_id| request_has_tool_result(request, tool_use_id))
}

fn latest_user_has_tool_result(request: &MessagesRequest, tool_use_id: &str) -> bool {
    request
        .messages
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::User { content, .. } => Some(content.iter().any(|block| {
                matches!(
                    block,
                    ContentBlock::ToolResult {
                        tool_use_id: id,
                        ..
                    } if id == tool_use_id
                )
            })),
            Message::Assistant { .. } => None,
        })
        .unwrap_or(false)
}

fn user_text_follows_latest_tool_result_without_assistant(
    request: &MessagesRequest,
    tool_use_id: &str,
) -> bool {
    let Some(tool_result_index) = request.messages.iter().rposition(|message| {
        message_content(message).iter().any(|block| {
            matches!(
                block,
                ContentBlock::ToolResult {
                    tool_use_id: id,
                    ..
                } if id == tool_use_id
            )
        })
    }) else {
        return false;
    };
    !request
        .messages
        .iter()
        .skip(tool_result_index + 1)
        .any(|message| matches!(message, Message::Assistant { .. }))
        && last_plain_user_text(request.messages.iter().skip(tool_result_index + 1)).is_some()
}

fn plain_user_text_after_latest_tool_result(
    request: &MessagesRequest,
    tool_use_id: &str,
) -> Option<String> {
    let tool_result_index = request.messages.iter().rposition(|message| {
        message_content(message).iter().any(|block| {
            matches!(
                block,
                ContentBlock::ToolResult {
                    tool_use_id: id,
                    ..
                } if id == tool_use_id
            )
        })
    })?;
    last_plain_user_text(request.messages.iter().skip(tool_result_index + 1))
}

fn latest_user_has_any_tool_result(request: &MessagesRequest, tool_use_ids: &[&str]) -> bool {
    tool_use_ids
        .iter()
        .any(|tool_use_id| latest_user_has_tool_result(request, tool_use_id))
}

fn latest_tool_result_text(request: &MessagesRequest, tool_use_id: &str) -> Option<String> {
    request.messages.iter().rev().find_map(|message| {
        let Message::User { content, .. } = message else {
            return None;
        };
        content.iter().find_map(|block| {
            let ContentBlock::ToolResult {
                tool_use_id: id,
                content,
                ..
            } = block
            else {
                return None;
            };
            if id != tool_use_id {
                return None;
            }
            Some(
                content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        })
    })
}

fn tool_result_agent_id(request: &MessagesRequest, tool_use_id: &str) -> Option<String> {
    let text = latest_tool_result_text(request, tool_use_id)?;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        .get("agent_id")?
        .as_str()
        .map(str::to_string)
}

fn last_plain_user_text<'a>(
    messages: impl IntoIterator<Item = &'a Message, IntoIter: DoubleEndedIterator>,
) -> Option<String> {
    let mut latest_internal_preview = None;
    for message in messages.into_iter().rev() {
        let Message::User { content, .. } = message else {
            continue;
        };
        let text = content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        if text.is_empty() {
            continue;
        }
        if is_generated_user_text(&text) {
            continue;
        }
        if let Some(preview) = internal_followup_user_preview(&text) {
            latest_internal_preview.get_or_insert(preview);
            continue;
        }
        return Some(text);
    }
    latest_internal_preview
}

fn is_generated_user_text(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with("<skill_content")
        || text.starts_with("<project-instructions>")
        || text.starts_with("<relevant-memories>")
        || text.starts_with("[system] Trusted Orchestrate fleet delta")
}

pub(super) fn request_has_subagent_notification(request: &MessagesRequest) -> bool {
    request.messages.iter().any(|message| {
        let Message::User { content, .. } = message else {
            return false;
        };
        content.iter().any(|block| {
            matches!(
                block,
                ContentBlock::Text { text }
                    if text.trim_start().starts_with("<subagent_notification")
            )
        })
    })
}

fn internal_followup_user_preview(text: &str) -> Option<String> {
    let text = text.trim_start();
    if text.starts_with("[system] Continue working toward the active `/goal` objective.")
        || text.starts_with("[system] Continue working toward the active `/ultgoal` objective.")
    {
        return Some(
            extract_goal_objective_preview(text)
                .filter(|preview| !preview.trim().is_empty())
                .unwrap_or_else(|| "active goal objective".to_string()),
        );
    }
    if text.starts_with("[system] A background sub-agent run just completed while you were idle.") {
        return Some("background follow-up".to_string());
    }
    None
}

fn extract_goal_objective_preview(text: &str) -> Option<String> {
    let objective = text
        .split_once("<objective>\n")?
        .1
        .split_once("\n</objective>")?
        .0;
    Some(unescape_mock_prompt_xml(objective))
}

fn unescape_mock_prompt_xml(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The newest delegated sub-agent contract text, i.e. the worker's own task
/// description rather than a parent tool call that copied the same words.
fn subagent_contract_text(request: &MessagesRequest) -> Option<&str> {
    request
        .messages
        .iter()
        .rev()
        .flat_map(|message| message_content(message).iter().rev())
        .find_map(|block| match block {
            ContentBlock::Text { text }
                if text.starts_with("You are a KCoder")
                    && text.contains("Global sub-agent contract") =>
            {
                Some(text.as_str())
            }
            _ => None,
        })
}

fn count_tool_uses(request: &MessagesRequest, tool_use_id: &str) -> usize {
    request
        .messages
        .iter()
        .flat_map(|message| message_content(message).iter())
        .filter(|block| {
            matches!(
                block,
                ContentBlock::ToolUse { id, .. } if id == tool_use_id
            )
        })
        .count()
}

pub(super) fn is_targeted_steer_worker(request: &MessagesRequest) -> bool {
    // Inspect the newest delegated role/task text, not copied parent tool-call arguments.
    request
        .messages
        .iter()
        .rev()
        .flat_map(|message| message_content(message).iter().rev())
        .find_map(|block| match block {
            ContentBlock::Text { text }
                if text.starts_with("You are a KCoder")
                    && text.contains("Global sub-agent contract") =>
            {
                Some(text.contains("tui-lab-targeted-subagent-steer-long-transcript"))
            }
            _ => None,
        })
        .unwrap_or(false)
}

fn message_content(message: &Message) -> &[ContentBlock] {
    match message {
        Message::User { content, .. } | Message::Assistant { content, .. } => content,
    }
}

pub(super) fn request_text_contains(request: &MessagesRequest, needle: &str) -> bool {
    request.messages.iter().any(|message| {
        message_content(message).iter().any(|block| match block {
            ContentBlock::Text { text } => text.contains(needle),
            ContentBlock::Thinking { thinking, .. } => thinking.contains(needle),
            ContentBlock::ToolUse { input, .. } => input.to_string().contains(needle),
            ContentBlock::ToolResult { content, .. } => content.iter().any(|nested| match nested {
                ContentBlock::Text { text } => text.contains(needle),
                _ => false,
            }),
            ContentBlock::Image { .. } | ContentBlock::RedactedThinking { .. } => false,
        })
    })
}

fn short_preview(text: &str, max_chars: usize) -> String {
    let mut preview = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        preview.push('…');
    }
    preview
}

fn chunk_text(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(1);
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if current.chars().count() >= max_chars {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}
