mod tool_policy_tests {
    use super::super::tool_policy::*;
    use kcoder_tools::{
        AgentKind, Tool, ToolContext, ToolError, ToolOutput, ToolRegistry, ToolSource,
    };
    use std::collections::HashSet;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    struct MutableMetadataTool(Arc<AtomicBool>);

    #[async_trait::async_trait]
    impl Tool for MutableMetadataTool {
        fn name(&self) -> String {
            "read".into()
        }
        fn source(&self) -> ToolSource {
            if self.0.load(Ordering::SeqCst) {
                ToolSource::Builtin
            } else {
                ToolSource::Mcp {
                    server: "docs".into(),
                    tool: "read".into(),
                }
            }
        }
        fn description(&self) -> String {
            "read".into()
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({})
        }
        async fn call(
            &self,
            _: serde_json::Value,
            _: &ToolContext,
        ) -> Result<ToolOutput, ToolError> {
            Ok(ToolOutput::text("read"))
        }
    }

    #[test]
    fn agent_filters_keep_registered_source_snapshot() {
        let changed = Arc::new(AtomicBool::new(false));
        let mut registry = ToolRegistry::new();
        registry
            .try_register(Arc::new(MutableMetadataTool(changed.clone())))
            .unwrap();
        let original_source = registry.source("read").unwrap().clone();
        changed.store(true, Ordering::SeqCst);
        let variants = [
            filter_tools_for_agent_kind(&registry, AgentKind::General, false),
            filter_tools_for_agent_kind(&registry, AgentKind::Explore, true),
            filter_tools_by_names(&registry, &HashSet::from(["read"])),
            filter_tools_by_owned_names(&registry, &HashSet::from(["read".to_owned()])),
        ];
        for filtered in variants {
            assert_eq!(filtered.source("read"), Some(&original_source));
        }
        let disabled = registry.filtered_out_by_patterns(&["read".into()]);
        assert!(
            filter_tools_for_agent_kind(&disabled, AgentKind::General, false)
                .get("read")
                .is_none()
        );
    }
    #[test]
    fn general_agent_allows_apply_patch_and_explorers_do_not() {
        assert!(agent_kind_allowed_tools(AgentKind::General).contains("apply_patch"));
        assert!(!agent_kind_allowed_tools(AgentKind::Explore).contains("apply_patch"));
    }
}

use super::*;

#[test]
fn configured_engine_agent_ids_use_parent_registry() {
    let root = tempfile::tempdir().unwrap();
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path()).build();
    engine.state.set_short_id_registry(&root.path().join("ids"));
    let first = generate_agent_id(&engine).unwrap();
    let second = generate_agent_id(&engine).unwrap();
    assert_eq!(first.len(), 5);
    assert_eq!(second.len(), 5);
    assert!(!first.eq_ignore_ascii_case(&second));
    assert_eq!(
        std::fs::read_dir(root.path().join("ids")).unwrap().count(),
        2
    );
}

#[test]
fn verifier_git_arguments_use_portable_windows_paths_without_changing_other_arguments() {
    assert_eq!(
        windows_verifier_git_argument(r"\\?\C:\private folder\repository.git"),
        "C:/private folder/repository.git"
    );
    assert_eq!(
        windows_verifier_git_argument(r"\\?\UNC\server\share\repo"),
        "//server/share/repo"
    );
    for unchanged in [
        "refs/heads/main",
        ":(exclude).kcoder/**",
        "/tmp/repo",
        r"\\?\Volume{opaque}\repo",
    ] {
        assert_eq!(windows_verifier_git_argument(unchanged), unchanged);
    }
    let long = format!(r"\\?\C:\{}\repo", "segment\\".repeat(50));
    let converted = windows_verifier_git_argument(&long);
    assert!(converted.starts_with("C:/"));
    assert!(converted.len() > 260);
    assert!(!converted.contains('\\'));
}

#[test]
fn subagent_model_detail_preview_is_rate_limited() {
    let start = std::time::Instant::now();

    assert!(!subagent_model_detail_due(
        start,
        start + std::time::Duration::from_millis(499)
    ));
    assert!(subagent_model_detail_due(
        start,
        start + SUBAGENT_MODEL_DETAIL_INTERVAL
    ));
}

#[test]
fn verifier_runtime_prompt_classifies_proven_baseline_failures_as_pass_evidence() {
    let guard = VerifierRuntimeGuard {
        block_dependency_mutation: true,
        minimum_test_scope: Some(GoalProTestScope::TargetSuite),
        require_raw_exit_code: true,
        require_behavior_delta: false,
        shell_isolation_root: None,
        cwd_override: Some(PathBuf::from("/tmp/candidate")),
        workspace_root: Some(PathBuf::from("/tmp/candidate")),
        baseline_root: Some(PathBuf::from("/tmp/baseline")),
        vote_channel: kcoder_tools::VerifierVoteChannel::default(),
    };

    let prompt = guard.role_system_prompt("verifier");
    assert!(
        prompt.contains(
            "PASS when the candidate has at least one successful focused functional check"
        )
    );
    assert!(prompt.contains("A proven baseline-only failure is not a reason for FAIL or FLAKY"));
    assert!(prompt.contains("candidate introduces a failure absent from the baseline"));
    assert!(prompt.contains("an exact candidate/baseline comparison cannot be obtained or paired"));
    assert!(
        prompt.contains("no successful candidate-side functional check demonstrates the repair")
    );
}

#[test]
fn verifier_runtime_prompt_requires_issue_specific_delta_when_enabled() {
    let guard = VerifierRuntimeGuard {
        block_dependency_mutation: true,
        minimum_test_scope: Some(GoalProTestScope::TargetSuite),
        require_raw_exit_code: true,
        require_behavior_delta: true,
        shell_isolation_root: None,
        cwd_override: Some(PathBuf::from("/tmp/candidate")),
        workspace_root: Some(PathBuf::from("/tmp/candidate")),
        baseline_root: Some(PathBuf::from("/tmp/baseline")),
        vote_channel: kcoder_tools::VerifierVoteChannel::default(),
    };

    let prompt = guard.role_system_prompt("verifier");
    assert!(prompt.contains("Behavior-delta gate is active"));
    assert!(prompt.contains("exact same command"));
    assert!(prompt.contains("KCODER_BEHAVIOR_DELTA"));
    assert!(prompt.contains("baseline exits exactly 1"));
    assert!(prompt.contains("baseline exit 0"));
    assert!(prompt.contains("callers, early interception branches, and error remapping"));
}

#[test]
fn verifier_runtime_prompt_documents_external_container_evidence() {
    let guard = VerifierRuntimeGuard {
        block_dependency_mutation: false,
        minimum_test_scope: Some(GoalProTestScope::Focused),
        require_raw_exit_code: true,
        require_behavior_delta: false,
        shell_isolation_root: None,
        cwd_override: None,
        workspace_root: None,
        baseline_root: None,
        vote_channel: kcoder_tools::VerifierVoteChannel::default(),
    };

    let prompt = guard.role_system_prompt("verifier");
    assert!(prompt.contains("external-artifact runtime boundary"));
    assert!(prompt.contains("docker exec"));
    assert!(prompt.contains("raw exit code"));
    assert!(prompt.contains("Do not invent a repository diff"));
    assert!(!prompt.contains("Pristine baseline repository"));
}

#[test]
fn verifier_origin_uses_canonical_candidate_and_baseline_roots() {
    let root = tempfile::tempdir().unwrap();
    let candidate = root.path().join("candidate");
    let baseline = root.path().join("baseline");
    let outside = root.path().join("outside");
    for path in [&candidate, &baseline, &outside] {
        std::fs::create_dir_all(path).unwrap();
    }
    let origin = |workdir: &Path| {
        verifier_test_provenance(workdir, &candidate, &baseline).map(|(origin, _)| origin)
    };

    assert_eq!(
        origin(&candidate),
        Some(kcoder_tools::VerifierTestOrigin::Candidate)
    );
    assert_eq!(
        origin(&baseline),
        Some(kcoder_tools::VerifierTestOrigin::Baseline)
    );
    assert_eq!(
        origin(&candidate.join("..").join("baseline")),
        Some(kcoder_tools::VerifierTestOrigin::Baseline)
    );
    assert_eq!(
        origin(&baseline.join("..").join("candidate")),
        Some(kcoder_tools::VerifierTestOrigin::Candidate)
    );
    assert_eq!(origin(&outside), None);

    let candidate_package = candidate.join("package");
    let baseline_package = baseline.join("package");
    std::fs::create_dir_all(&candidate_package).unwrap();
    std::fs::create_dir_all(&baseline_package).unwrap();
    assert_eq!(
        verifier_test_provenance(&candidate_package, &candidate, &baseline),
        Some((
            kcoder_tools::VerifierTestOrigin::Candidate,
            PathBuf::from("package"),
        ))
    );
    assert_eq!(
        verifier_test_provenance(&baseline_package, &candidate, &baseline),
        Some((
            kcoder_tools::VerifierTestOrigin::Baseline,
            PathBuf::from("package"),
        ))
    );
}

#[cfg(target_os = "linux")]
#[test]
fn verifier_sandbox_inherits_parent_denied_reads_in_real_bash_child() {
    use std::os::unix::process::CommandExt as _;

    if !kcoder_tools::os_sandbox::landlock_supported() {
        eprintln!("landlock unavailable; skipping verifier denied-read test");
        return;
    }

    // Keep the split chain in a small /dev/shm directory so many siblings in shared /tmp cannot affect the test.
    let root = tempfile::tempdir_in("/dev/shm").unwrap();
    let parent_workspace = root.path().join("parent/workspace");
    let denied_dir = root.path().join("parent/reference");
    let verifier_workspace = root.path().join("verifier/workspace");
    let verifier_runtime = root.path().join("verifier/runtime");
    for path in [
        &parent_workspace,
        &denied_dir,
        &verifier_workspace,
        &verifier_runtime,
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    let secret = denied_dir.join("gold.txt");
    let public = verifier_workspace.join("public.txt");
    std::fs::write(&secret, "gold answer\n").unwrap();
    std::fs::write(&public, "candidate data\n").unwrap();

    // Use a deny relative to the parent cwd to cover incorrect reinterpretation after verifier re-rooting.
    let parent = kcoder_tools::Sandbox::new(
        &parent_workspace,
        kcoder_types::SandboxConfig {
            enabled: true,
            denied_paths: vec!["../reference".to_string()],
            allow_shell_escalation: true,
            landlock: Some(true),
            ..kcoder_types::SandboxConfig::default()
        },
    );
    let verifier =
        verifier_sandbox_from_parent(&parent, verifier_workspace.clone(), None, verifier_runtime);
    let spec = verifier
        .os_spec()
        .expect("verifier must retain the parent's forced Landlock policy");

    let run_bash_read = |path: &std::path::Path| {
        let mut command = std::process::Command::new("bash");
        command
            .arg("-c")
            .arg("cat -- \"$1\"")
            .arg("kcoder-verifier-sandbox-test")
            .arg(path);
        let child_spec = spec.clone();
        unsafe {
            command.pre_exec(move || {
                kcoder_tools::os_sandbox::apply(&child_spec).map_err(|error| {
                    std::io::Error::new(std::io::ErrorKind::PermissionDenied, error)
                })
            });
        }
        command.output().unwrap()
    };

    let allowed = run_bash_read(&public);
    assert!(
        allowed.status.success(),
        "verifier must still read its candidate workspace: {}",
        String::from_utf8_lossy(&allowed.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&allowed.stdout), "candidate data\n");

    let denied = run_bash_read(&secret);
    assert!(!denied.status.success(), "denied gold data was readable");
    assert!(!String::from_utf8_lossy(&denied.stdout).contains("gold answer"));
}

#[test]
fn inherited_subagent_cancellation_is_one_way() {
    let parent = CancellationToken::new();
    let child = resolve_subagent_abort_token(
        parent.clone(),
        &SubagentContextOverrides {
            share_abort_controller: true,
            ..SubagentContextOverrides::default()
        },
    );

    child.cancel();
    assert!(child.is_cancelled());
    assert!(!parent.is_cancelled());

    let sibling = resolve_subagent_abort_token(
        parent.clone(),
        &SubagentContextOverrides {
            share_abort_controller: true,
            ..SubagentContextOverrides::default()
        },
    );
    parent.cancel();
    assert!(sibling.is_cancelled());
}

#[test]
fn explicit_subagent_cancellation_token_is_also_one_way() {
    let caller = CancellationToken::new();
    let child = resolve_subagent_abort_token(
        CancellationToken::new(),
        &SubagentContextOverrides {
            abort_token: Some(caller.clone()),
            ..SubagentContextOverrides::default()
        },
    );

    child.cancel();
    assert!(!caller.is_cancelled());

    let sibling = caller.child_token();
    caller.cancel();
    assert!(sibling.is_cancelled());
}

#[test]
fn forked_agent_cancel_error_remains_typed() {
    let error = anyhow::Error::new(ForkedAgentAborted {
        reason: "cancelled by user".to_string(),
        cancelled: true,
    });
    assert!(matches!(
        map_forked_agent_error(error),
        AgentError::Cancelled(reason) if reason == "cancelled by user"
    ));
}

fn platform_shell_tool_name() -> &'static str {
    if cfg!(windows) { "PowerShell" } else { "bash" }
}

#[test]
fn disallowed_tools_contains_known_entries() {
    let disallowed = all_agent_disallowed_tools();
    assert!(disallowed.contains("ask_user_question"));
    assert!(disallowed.contains("task_stop"));
    assert!(!disallowed.contains("read"));
}

#[test]
fn async_allowed_tools_permits_read_and_shell_tools() {
    let allowed = async_agent_allowed_tools();
    assert!(allowed.contains("read"));
    assert!(allowed.contains("bash"));
    assert!(allowed.contains("PowerShell"));
    assert!(allowed.contains("WebFetch"));
    assert!(!allowed.contains("ask_user_question"));
}

#[test]
fn filter_tools_respects_explore_role() {
    let filtered =
        filter_tools_for_agent(&kcoder_tools::default_registry(), Some("explorer"), true);
    let names: HashSet<String> = filtered.names().into_iter().collect();
    assert!(names.contains("read"));
    assert!(names.contains("grep"));
    assert!(names.contains("glob"));
    assert!(!names.contains("bash"));
    assert!(!names.contains("PowerShell"));
    assert!(!names.contains("edit"));
    assert!(!names.contains("write"));
}

#[test]
fn filter_tools_respects_implementer_role() {
    let filtered =
        filter_tools_for_agent(&kcoder_tools::default_registry(), Some("implementer"), true);
    let names: HashSet<String> = filtered.names().into_iter().collect();
    assert!(names.contains("read"));
    assert!(names.contains(platform_shell_tool_name()));
    assert_eq!(names.contains("bash"), !cfg!(windows));
    assert_eq!(names.contains("PowerShell"), cfg!(windows));
    assert!(names.contains("edit"));
    assert!(names.contains("write"));
    assert!(!names.contains("AskUserQuestion"));
    assert!(!names.contains("TaskStop"));
}

#[test]
fn filter_tools_respects_verifier_role() {
    let filtered =
        filter_tools_for_agent(&kcoder_tools::default_registry(), Some("verifier"), true);
    let names: HashSet<String> = filtered.names().into_iter().collect();
    assert!(names.contains("read"));
    assert!(names.contains(platform_shell_tool_name()));
    assert_eq!(names.contains("bash"), !cfg!(windows));
    assert_eq!(names.contains("PowerShell"), cfg!(windows));
    assert!(!names.contains("edit"));
    assert!(!names.contains("write"));
}

#[test]
fn arrangement_filter_allows_verifier_write_tools() {
    let filtered = filter_tools_for_agent_kind_in_mode(
        &kcoder_tools::arrangement_subagent_registry(),
        AgentKind::Verifier,
        true,
        true,
    );
    let names: HashSet<String> = filtered.names().into_iter().collect();
    assert!(names.contains("read"));
    assert!(names.contains(platform_shell_tool_name()));
    assert!(names.contains("edit"));
    assert!(names.contains("write"));
    assert!(!names.contains("AskUserQuestion"));
}

#[test]
fn arrangement_filter_keeps_general_subagent_read_only() {
    let filtered = filter_tools_for_agent_kind_in_mode(
        &kcoder_tools::arrangement_subagent_registry(),
        AgentKind::General,
        true,
        true,
    );
    let names: HashSet<String> = filtered.names().into_iter().collect();
    assert!(names.contains("read"));
    assert!(names.contains(platform_shell_tool_name()));
    assert!(!names.contains("WritePlan"));
    assert!(!names.contains("edit"));
    assert!(!names.contains("write"));
}

#[test]
fn background_review_tool_filter_is_limited_to_skill_memory_management() {
    let allowed = background_review_allowed_tools();
    let expected = HashSet::from(["remember", "skill", "skill_manage", "DiscoverSkills"]);
    assert_eq!(allowed, expected);

    let filtered = filter_tools_by_names(&kcoder_tools::default_registry(), &allowed);
    let names: HashSet<String> = filtered.names().into_iter().collect();
    assert_eq!(
        names,
        expected
            .iter()
            .map(|name| (*name).to_string())
            .collect::<HashSet<_>>()
    );
    assert!(!names.contains("bash"));
    assert!(!names.contains("write"));
    assert!(!names.contains("edit"));
    assert!(!names.contains("TaskCreate"));
}

#[test]
fn matched_tool_use_sequence_is_not_reported_as_unmatched() {
    let messages = vec![
        Message::user_text("use a tool"),
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "tool-1".to_string(),
                name: "read".to_string(),
                input: serde_json::json!({"file_path":"Cargo.toml"}),
            }],
            usage: None,
        },
        Message::User {
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "contents".to_string(),
                }],
                is_error: Some(false),
            }],
        },
        Message::user_text("next"),
    ];

    assert!(unmatched_tool_use_ids(&messages).is_empty());
}

#[test]
fn unmatched_tool_use_sequence_reports_missing_ids() {
    let messages = vec![
        Message::Assistant {
            content: vec![
                ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "read".to_string(),
                    input: serde_json::json!({"file_path":"Cargo.toml"}),
                },
                ContentBlock::ToolUse {
                    id: "tool-2".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({"command":"cargo test"}),
                },
            ],
            usage: None,
        },
        Message::User {
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "contents".to_string(),
                }],
                is_error: Some(false),
            }],
        },
    ];

    assert_eq!(unmatched_tool_use_ids(&messages), vec!["tool-2"]);
}

#[test]
fn semantic_context_removes_tool_traffic_and_reasoning() {
    let messages = vec![
        Message::user_text("original request"),
        Message::Assistant {
            content: vec![
                ContentBlock::Thinking {
                    thinking: "private reasoning".to_string(),
                    signature: "sig".to_string(),
                },
                ContentBlock::Text {
                    text: "I will inspect it".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "read".to_string(),
                    input: serde_json::json!({"file_path":"Cargo.toml"}),
                },
            ],
            usage: Some(kcoder_types::Usage {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            }),
        },
        Message::User {
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "tool output".to_string(),
                }],
                is_error: Some(false),
            }],
        },
        Message::Assistant {
            content: vec![ContentBlock::Text {
                text: "stable conclusion".to_string(),
            }],
            usage: Some(kcoder_types::Usage {
                input_tokens: 150,
                output_tokens: 10,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            }),
        },
    ];

    let projected = project_parent_messages(&messages, SubagentContextMode::Semantic, 2);

    assert_eq!(projected.len(), 2);
    assert_eq!(projected[0].preview(100), "original request");
    assert_eq!(projected[1].preview(100), "stable conclusion");
    let Message::Assistant { usage, .. } = &projected[1] else {
        panic!("expected assistant conclusion");
    };
    assert!(usage.is_none());
    assert!(unmatched_tool_use_ids(&projected).is_empty());
}

#[test]
fn recent_window_matches_forward_index_oracle() {
    let variants = [
        Message::user_text("real user"),
        Message::assistant_text("answer"),
        Message::user_text("<subagent_notification id=\"child\"/>"),
        Message::user_text("Earlier conversation summary:\nsummary"),
        Message::User { content: vec![] },
    ];
    for len in 0..=5u32 {
        for mut pattern in 0..variants.len().pow(len) {
            let messages = (0..len)
                .map(|_| {
                    let message = variants[pattern % variants.len()].clone();
                    pattern /= variants.len();
                    message
                })
                .collect::<Vec<_>>();
            let indices = messages
                .iter()
                .enumerate()
                .filter_map(|(index, message)| is_real_user_message(message).then_some(index))
                .collect::<Vec<_>>();
            for turns in [0, 1, 2, 99, usize::MAX] {
                let expected = indices
                    .get(indices.len().saturating_sub(turns.max(1)))
                    .copied();
                assert_eq!(recent_parent_start(&messages, turns), expected);
                let projected =
                    project_parent_messages(&messages, SubagentContextMode::Recent, turns);
                let expected = expected
                    .map(|start| {
                        project_parent_messages(
                            &messages[start..],
                            SubagentContextMode::Semantic,
                            turns,
                        )
                    })
                    .unwrap_or_default();
                assert_eq!(projected, expected);
            }
        }
    }
}

#[test]
fn recent_context_counts_user_turns_not_tool_results() {
    let messages = vec![
        Message::user_text("first request"),
        Message::assistant_text("first answer"),
        Message::user_text("second request"),
        Message::user_text("<subagent_notification id=\"child\" status=\"completed\"/>"),
        Message::user_text("TodoList maintenance reminder: update the current task"),
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "tool-2".to_string(),
                name: "read".to_string(),
                input: serde_json::json!({}),
            }],
            usage: None,
        },
        Message::User {
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-2".to_string(),
                content: vec![ContentBlock::Text {
                    text: "result".to_string(),
                }],
                is_error: None,
            }],
        },
        Message::assistant_text("second answer"),
        Message::user_text("third request"),
    ];

    let projected = project_parent_messages(&messages, SubagentContextMode::Recent, 2);
    let previews = projected
        .iter()
        .map(|message| message.preview(100))
        .collect::<Vec<_>>();

    assert_eq!(
        previews,
        ["second request", "second answer", "third request"]
    );
    assert!(unmatched_tool_use_ids(&projected).is_empty());
}

#[test]
fn semantic_context_keeps_compact_summary_but_drops_engine_reminders() {
    let compact = "This session is being continued from a previous conversation that ran out of context.\n\nImportant decision";
    let messages = vec![
        Message::user_text(compact),
        Message::user_text("<project-instructions>duplicated</project-instructions>"),
        Message::user_text("[system] Continue the loop"),
        Message::user_text("actual request"),
    ];

    let projected = project_parent_messages(&messages, SubagentContextMode::Semantic, 2);
    let previews = projected
        .iter()
        .map(|message| message.preview(200))
        .collect::<Vec<_>>();

    assert_eq!(previews, [compact, "actual request"]);
}

#[test]
fn production_attachment_formats_are_synthetic_and_do_not_consume_recent_turns() {
    let attachments = [
        "Project instructions (KCODER.md):\n# Rules",
        "Project instructions:\ndigest",
        "Additional instructions after compaction:\ncontinue",
        "Relevant memories:\nremember alpha",
        "Active skills: tdd. You may continue to use them via the skill tool.",
        "You are currently in plan mode:\nplan only",
        "Recent file read retained after compaction (/tmp/a):\ncontents",
        "Available tools after compaction: read, bash",
        "<task_notification id=\"task-1\" status=\"completed\"/>",
        "<workflow_notification id=\"workflow-1\" status=\"completed\"/>",
    ];
    let mut messages = vec![Message::user_text("older real request")];
    messages.extend(attachments.into_iter().map(Message::user_text));
    messages.push(Message::user_text("latest real request"));

    let semantic = project_parent_messages(&messages, SubagentContextMode::Semantic, 1);
    assert_eq!(
        semantic
            .iter()
            .map(|message| message.preview(100))
            .collect::<Vec<_>>(),
        ["older real request", "latest real request"]
    );
    let recent = project_parent_messages(&messages, SubagentContextMode::Recent, 1);
    assert_eq!(recent, vec![Message::user_text("latest real request")]);
}

#[test]
fn reserved_generated_prefixes_are_an_explicit_context_origin_boundary() {
    let messages = vec![
        Message::user_text("Project instructions: this text was typed by a user"),
        Message::user_text("Please discuss the phrase Project instructions: literally"),
    ];

    let semantic = project_parent_messages(&messages, SubagentContextMode::Semantic, 2);
    assert_eq!(
        semantic,
        vec![Message::user_text(
            "Please discuss the phrase Project instructions: literally"
        )]
    );
}

#[test]
fn recent_large_window_starts_at_first_real_user_not_startup_summary() {
    let summary = "This session is being continued from a previous conversation that ran out of context.\nstartup summary";
    let messages = vec![
        Message::user_text(summary),
        Message::user_text("only real request"),
        Message::assistant_text("answer"),
    ];

    let projected = project_parent_messages(&messages, SubagentContextMode::Recent, 99);
    assert_eq!(
        projected,
        vec![
            Message::user_text("only real request"),
            Message::assistant_text("answer")
        ]
    );
}

#[test]
fn recent_context_without_real_user_turns_is_empty() {
    let messages = vec![
        Message::user_text("Earlier conversation summary:\nsummary only"),
        Message::user_text("<system-reminder>generated</system-reminder>"),
    ];

    assert!(project_parent_messages(&messages, SubagentContextMode::Recent, 2).is_empty());
}

#[test]
fn initial_context_modes_append_delegated_prompt_once() {
    let cache_safe = CacheSafeParams {
        fork_context_messages: vec![Message::user_text("parent request")].into(),
        active_skills: Vec::new(),
        snapshot_provider: "test-provider".to_string(),
        snapshot_model: "test-model".to_string(),
        full_context_compatible: true,
    };

    let none = initial_agent_messages(
        &cache_safe,
        "delegated".to_string(),
        SubagentContextMode::None,
        2,
    );
    assert_eq!(none, vec![Message::user_text("delegated")]);

    let full = initial_agent_messages(
        &cache_safe,
        "delegated".to_string(),
        SubagentContextMode::Full,
        2,
    );
    assert_eq!(
        full,
        vec![
            Message::user_text("parent request"),
            Message::user_text("delegated")
        ]
    );
}

#[test]
fn role_permission_defaults_are_non_interactive_and_least_privilege() {
    assert_eq!(
        subagent_permission_mode(AgentKind::Implementer),
        PermissionMode::AcceptEdits
    );
    assert_eq!(
        subagent_permission_mode(AgentKind::Verifier),
        PermissionMode::AcceptEdits
    );
    assert_eq!(
        subagent_permission_mode(AgentKind::Explore),
        PermissionMode::Auto
    );
    assert_eq!(
        subagent_permission_mode(AgentKind::Review),
        PermissionMode::Auto
    );
}

#[tokio::test]
async fn transcript_checkpoint_atomically_replaces_readable_json() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("nested/transcript.json");
    let first = vec![Message::user_text("first")];
    write_transcript_checkpoint(&path, &first).await.unwrap();
    let stored: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    assert_eq!(stored, first);

    let second = vec![
        Message::user_text("first"),
        Message::assistant_text("second"),
    ];
    write_transcript_checkpoint(&path, &second).await.unwrap();
    let stored: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    assert_eq!(stored, second);
    assert!(!path.with_extension("json.tmp").exists());
}

#[test]
fn delivery_anchor_matches_only_the_exact_user_message() {
    assert!(is_exact_delivery_message(
        &Message::user_text("follow up"),
        "follow up"
    ));
    assert!(!is_exact_delivery_message(
        &Message::user_text("different"),
        "follow up"
    ));
    assert!(!is_exact_delivery_message(
        &Message::assistant_text("follow up"),
        "follow up"
    ));
}

#[test]
fn completed_delivery_recovery_uses_terminal_assistant_without_new_provider_turn() {
    let messages = vec![
        Message::assistant_text("old"),
        Message::user_text("follow up"),
        Message::assistant_text("finished once"),
    ];
    assert_eq!(
        completed_delivery_output(&messages, 1).as_deref(),
        Some("finished once")
    );

    let interrupted_after_tool = vec![
        Message::user_text("follow up"),
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "tool-1".to_string(),
                name: "read".to_string(),
                input: serde_json::json!({"path":"README.md"}),
            }],
            usage: None,
        },
        Message::User {
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "done".to_string(),
                }],
                is_error: Some(false),
            }],
        },
    ];
    assert!(completed_delivery_output(&interrupted_after_tool, 0).is_none());
}

#[tokio::test]
async fn goal_verifier_worktree_reproduces_candidate_without_touching_parent() {
    fn git(cwd: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let source = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(source.path().join("src")).unwrap();
    std::fs::create_dir_all(source.path().join("tests")).unwrap();
    std::fs::create_dir_all(source.path().join("fixtures/pytest-of-recorded")).unwrap();
    std::fs::write(source.path().join("src/lib.py"), "value = 'base'\n").unwrap();
    std::fs::write(
        source.path().join("tests/test_case.py"),
        "def test_case():\n    assert True\n",
    )
    .unwrap();
    std::fs::write(
        source
            .path()
            .join("fixtures/pytest-of-recorded/tracked.txt"),
        "base\n",
    )
    .unwrap();
    std::fs::write(source.path().join(".gitignore"), "issue.md\n").unwrap();
    git(source.path(), &["init", "-q"]);
    git(
        source.path(),
        &["config", "user.email", "verifier@example.test"],
    );
    git(source.path(), &["config", "user.name", "Verifier Test"]);
    git(source.path(), &["add", "."]);
    git(source.path(), &["commit", "-qm", "base"]);

    std::fs::write(
        source.path().join("issue.md"),
        "Fix the complete production behavior.\n",
    )
    .unwrap();
    std::fs::write(source.path().join("src/lib.py"), "value = 'candidate'\n").unwrap();
    std::fs::write(source.path().join("src/new_module.py"), "new_value = 1\n").unwrap();
    std::fs::write(
        source.path().join("tests/test_case.py"),
        "def test_case():\n    assert True  # candidate change\n",
    )
    .unwrap();
    std::fs::write(
        source
            .path()
            .join("fixtures/pytest-of-recorded/tracked.txt"),
        "candidate\n",
    )
    .unwrap();
    std::fs::create_dir_all(
        source
            .path()
            .join("pytest-of-root/pytest-0/test_integrate0"),
    )
    .unwrap();
    std::fs::write(
        source
            .path()
            .join("pytest-of-root/pytest-0/test_integrate0/test_trap"),
        "runtime artifact\n",
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        source
            .path()
            .join("pytest-of-root/pytest-0/test_integrate0"),
        source
            .path()
            .join("pytest-of-root/pytest-0/test_integrate_current"),
    )
    .unwrap();
    std::fs::create_dir_all(source.path().join(".pytest_cache/v/cache")).unwrap();
    std::fs::write(source.path().join(".pytest_cache/v/cache/nodeids"), "[]\n").unwrap();
    std::fs::create_dir_all(source.path().join(".kcoder")).unwrap();
    std::fs::write(source.path().join(".kcoder/session.json"), "{}\n").unwrap();

    let isolation = create_verifier_workspace_isolation(&source.path().join("src"), None)
        .await
        .unwrap();
    let isolated_root = isolation.worktree_root.clone();
    let baseline_root = isolation.baseline_root.clone();
    assert_ne!(isolation.cwd, source.path().join("src"));
    assert_eq!(
        std::fs::read_to_string(isolation.cwd.join("lib.py")).unwrap(),
        "value = 'candidate'\n"
    );
    assert_eq!(
        std::fs::read_to_string(isolation.cwd.join("new_module.py")).unwrap(),
        "new_value = 1\n"
    );
    assert_eq!(
        std::fs::read_to_string(isolation.worktree_root.join("issue.md")).unwrap(),
        "Fix the complete production behavior.\n"
    );
    assert_eq!(
        isolation.changed_paths,
        vec![
            "fixtures/pytest-of-recorded/tracked.txt".to_string(),
            "src/lib.py".to_string(),
            "src/new_module.py".to_string(),
            "tests/test_case.py".to_string(),
        ]
    );
    assert!(!isolation.worktree_root.join("pytest-of-root").exists());
    assert!(!isolation.worktree_root.join(".pytest_cache").exists());
    assert!(!isolation.worktree_root.join(".kcoder").exists());
    assert_eq!(
        std::fs::read_to_string(isolation.baseline_root.join("src/lib.py")).unwrap(),
        "value = 'base'\n"
    );
    assert!(!isolation.baseline_root.join("src/new_module.py").exists());

    let before = verifier_workspace_fingerprint(&isolation.worktree_root)
        .await
        .unwrap();
    let baseline_before = verifier_workspace_fingerprint(&isolation.baseline_root)
        .await
        .unwrap();
    std::fs::write(
        isolation.baseline_root.join("src/lib.py"),
        "value = 'polluted during build'\n",
    )
    .unwrap();
    let baseline_after = verifier_workspace_fingerprint(&isolation.baseline_root)
        .await
        .unwrap();
    assert_ne!(
        baseline_before, baseline_after,
        "a native preparation that changes tracked baseline source must invalidate the pristine fingerprint"
    );
    std::fs::create_dir_all(
        isolation
            .worktree_root
            .join("pytest-of-ci/pytest-1/test_runtime0"),
    )
    .unwrap();
    std::fs::write(
        isolation
            .worktree_root
            .join("pytest-of-ci/pytest-1/test_runtime0/test_trap"),
        "runtime artifact\n",
    )
    .unwrap();
    std::fs::create_dir_all(isolation.worktree_root.join(".pytest_cache/v/cache")).unwrap();
    std::fs::write(
        isolation
            .worktree_root
            .join(".pytest_cache/v/cache/nodeids"),
        "[]\n",
    )
    .unwrap();
    let after_runtime_artifacts = verifier_workspace_fingerprint(&isolation.worktree_root)
        .await
        .unwrap();
    assert_eq!(before, after_runtime_artifacts);
    std::fs::write(
        isolation.worktree_root.join("tests/test_case.py"),
        "def test_case():\n    assert False\n",
    )
    .unwrap();
    let after = verifier_workspace_fingerprint(&isolation.worktree_root)
        .await
        .unwrap();
    assert_ne!(before, after);
    assert_eq!(
        std::fs::read_to_string(source.path().join("tests/test_case.py")).unwrap(),
        "def test_case():\n    assert True  # candidate change\n"
    );

    drop(isolation);
    assert!(!isolated_root.exists());
    assert!(!baseline_root.exists());
}

#[tokio::test]
async fn goal_verifier_snapshot_fallback_supports_non_git_workspace() {
    let source = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(source.path().join("src")).unwrap();
    std::fs::write(source.path().join("src/lib.py"), "value = 'base'\n").unwrap();
    std::fs::write(source.path().join("removed.txt"), "baseline only\n").unwrap();

    let bundle = artifacts.path().join("goal-baseline.bundle");
    let baseline = capture_verifier_workspace_baseline(source.path(), &bundle)
        .await
        .unwrap()
        .expect("a non-Git workspace requires a private baseline");

    std::fs::write(source.path().join("src/lib.py"), "value = 'candidate'\n").unwrap();
    std::fs::remove_file(source.path().join("removed.txt")).unwrap();
    std::fs::write(source.path().join("created.txt"), "candidate only\n").unwrap();

    let isolation = create_verifier_workspace_isolation(source.path(), Some(&baseline))
        .await
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(isolation.worktree_root.join("src/lib.py")).unwrap(),
        "value = 'candidate'\n"
    );
    assert_eq!(
        std::fs::read_to_string(isolation.baseline_root.join("src/lib.py")).unwrap(),
        "value = 'base'\n"
    );
    assert!(isolation.worktree_root.join("created.txt").exists());
    assert!(!isolation.baseline_root.join("created.txt").exists());
    assert!(!isolation.worktree_root.join("removed.txt").exists());
    assert!(isolation.baseline_root.join("removed.txt").exists());
    assert_eq!(
        isolation.changed_paths,
        vec![
            "created.txt".to_string(),
            "removed.txt".to_string(),
            "src/lib.py".to_string(),
        ]
    );
    assert!(!source.path().join(".git").exists());
}

#[tokio::test]
async fn goal_verifier_snapshot_fallback_supports_unborn_head() {
    fn git(cwd: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {} failed", args.join(" "));
    }

    let source = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    git(source.path(), &["init", "-q"]);
    std::fs::write(source.path().join("app.txt"), "before\n").unwrap();

    let bundle = artifacts.path().join("goal-baseline.bundle");
    let baseline = capture_verifier_workspace_baseline(source.path(), &bundle)
        .await
        .unwrap()
        .expect("an unborn HEAD requires a private baseline");
    std::fs::write(source.path().join("app.txt"), "after\n").unwrap();

    let isolation = create_verifier_workspace_isolation(source.path(), Some(&baseline))
        .await
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(isolation.worktree_root.join("app.txt")).unwrap(),
        "after\n"
    );
    assert_eq!(
        std::fs::read_to_string(isolation.baseline_root.join("app.txt")).unwrap(),
        "before\n"
    );
    assert_eq!(isolation.changed_paths, vec!["app.txt".to_string()]);
    assert!(source.path().join(".git").is_dir());
    assert!(
        !std::process::Command::new("git")
            .arg("-C")
            .arg(source.path())
            .args(["rev-parse", "--verify", "HEAD^{commit}"])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[tokio::test]
async fn goal_creation_persists_private_baseline_reference_before_work() {
    let source = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("app.txt"), "before\n").unwrap();
    let state = AppState::new(source.path());
    let goal = state
        .set_goal_prepared_with_mode_and_verification(
            "change app.txt",
            None,
            None,
            kcoder_state::GoalMode::Strict,
            kcoder_state::GoalVerificationKind::Artifact,
        )
        .unwrap();

    let prepared = ensure_goal_pro_workspace_baseline(&state, &goal)
        .await
        .unwrap();
    let baseline = prepared
        .workspace_baseline
        .as_ref()
        .expect("non-Git Goal Pro must persist a private baseline reference");

    assert!(baseline.bundle_path.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&baseline.bundle_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_eq!(
        baseline.source_root,
        dunce::canonicalize(source.path()).unwrap()
    );
    assert_eq!(state.goal().unwrap(), prepared);
    assert!(
        serde_json::to_string(&prepared)
            .unwrap()
            .contains("workspace_baseline")
    );
    assert!(!source.path().join(".git").exists());
}

#[tokio::test]
async fn goal_verifier_rejects_a_tampered_private_baseline_without_retrying_git() {
    let source = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("app.txt"), "before\n").unwrap();
    let bundle = artifacts.path().join("goal-baseline.bundle");
    let baseline = capture_verifier_workspace_baseline(source.path(), &bundle)
        .await
        .unwrap()
        .unwrap();
    std::fs::write(&bundle, "tampered\n").unwrap();

    let error = create_verifier_workspace_isolation(source.path(), Some(&baseline))
        .await
        .unwrap_err();
    let message = error.to_string();

    assert!(
        message.contains("goal_pro_workspace_baseline_unavailable:"),
        "{message}"
    );
    assert!(message.contains("SHA-256 mismatch"), "{message}");
}

#[test]
fn fork_result_uses_only_the_latest_assistant_response_text() {
    let messages = vec![
        Message::assistant_text("I'll start by inspecting the patch."),
        Message::user_text("tool result"),
        Message::assistant_text("PASS\nTarget suite passed with exit code 0."),
    ];

    assert_eq!(
        latest_assistant_response_text(&messages).as_deref(),
        Some("PASS\nTarget suite passed with exit code 0.")
    );
}

#[test]
fn verifier_trusted_shell_result_is_hard_bounded_and_keeps_head_and_tail() {
    let output = ToolOutput::error(format!(
        "exit_code: 1\n{}\nFAILED tests/test_issue.py::test_regression - AssertionError",
        "x".repeat(MAX_VERIFIER_TRUSTED_TOOL_RESULT_BYTES * 2)
    ));

    let (bounded, bytes) = bounded_verifier_tool_result("bash", output).unwrap();
    let text = bounded
        .content
        .iter()
        .find_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap();

    assert!(bytes <= MAX_VERIFIER_TRUSTED_TOOL_RESULT_BYTES);
    assert!(text.starts_with("exit_code: 1\n"));
    assert!(text.contains("FAILED tests/test_issue.py::test_regression"));
    assert!(bounded_verifier_tool_result("read", ToolOutput::text("ignored")).is_none());
}

#[test]
fn verifier_provenance_falls_back_to_requested_workdir_on_tool_error() {
    let baseline = PathBuf::from("/tmp/kcoder-goal-baseline-a/workspace");
    let execution = kcoder_tools::AgentToolExecution {
        name: "bash".to_string(),
        input: serde_json::json!({
            "command": "python -m pytest tests -q",
            "workdir": baseline,
        }),
        output: "sandbox denied: command output indicates sandbox denial".to_string(),
        is_error: Some(true),
        test_origin: None,
        verifier_relative_workdir: None,
        process_exit_code: None,
        process_signal: None,
        process_cwd: None,
        artifacts: Vec::new(),
        raw_exit_code: false,
    };

    assert_eq!(
        bash_execution_workdir(&execution),
        Some(PathBuf::from("/tmp/kcoder-goal-baseline-a/workspace"))
    );
}

#[test]
fn verifier_session_tools_expose_vote_only_to_the_verifier_face() {
    let base = kcoder_tools::default_registry();
    let verifier = verifier_session_tools(&base);
    assert!(
        verifier
            .get(kcoder_tools::VERIFIER_VOTE_TOOL_NAME)
            .is_some()
    );
    assert!(verifier.get("read").is_some());
    assert!(verifier.get("edit").is_none());
    // Base registries and other role surfaces never receive VerifierVote.
    assert!(base.get(kcoder_tools::VERIFIER_VOTE_TOOL_NAME).is_none());
    for kind in [
        AgentKind::General,
        AgentKind::Explore,
        AgentKind::Plan,
        AgentKind::Review,
        AgentKind::Implementer,
        AgentKind::ToolAgent,
    ] {
        let tools = filter_tools_for_agent_kind(&base, kind, true);
        assert!(
            tools.get(kcoder_tools::VERIFIER_VOTE_TOOL_NAME).is_none(),
            "{kind:?} must not see VerifierVote"
        );
    }
}

fn vote_record_for_tests(cited_ids: Option<Vec<String>>) -> kcoder_tools::VerifierVoteRecord {
    kcoder_tools::VerifierVoteRecord {
        input: kcoder_tools::VerifierVoteInput {
            verdict: kcoder_tools::VerifierVoteOutcome::Pass,
            summary: "focused checks passed".to_string(),
            rejection_reason: None,
            commands: None,
            verified_tool_use_ids: cited_ids,
        },
        tool_use_id: "vote-1".to_string(),
    }
}

fn vote_transcript(include_vote: bool) -> Vec<Message> {
    if !include_vote {
        return vec![Message::assistant_text("PASS\nverified")];
    }
    vec![
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "vote-1".to_string(),
                name: kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string(),
                input: serde_json::json!({"verdict": "pass", "summary": "focused checks passed"}),
            }],
            usage: None,
        },
        Message::User {
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "vote-1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "Verdict vote recorded: pass.".to_string(),
                }],
                is_error: Some(false),
            }],
        },
    ]
}

#[test]
fn validated_verifier_vote_accepts_transcript_backed_vote() {
    let channel = kcoder_tools::VerifierVoteChannel::default();
    channel.record_authenticated_tool_use("bash-1");
    channel.record_authenticated_tool_use("vote-1");
    channel
        .record_vote(vote_record_for_tests(Some(vec!["bash-1".to_string()])))
        .unwrap();

    let vote = validated_verifier_vote(&channel, &vote_transcript(true)).expect("valid vote");
    assert_eq!(vote.input.verdict, kcoder_tools::VerifierVoteOutcome::Pass);
}

#[test]
fn validated_verifier_vote_drops_vote_missing_from_transcript() {
    let channel = kcoder_tools::VerifierVoteChannel::default();
    channel.record_authenticated_tool_use("vote-1");
    channel.record_vote(vote_record_for_tests(None)).unwrap();

    assert!(validated_verifier_vote(&channel, &vote_transcript(false)).is_none());
}

#[test]
fn validated_verifier_vote_drops_ids_outside_the_authenticated_set() {
    let channel = kcoder_tools::VerifierVoteChannel::default();
    channel.record_authenticated_tool_use("vote-1");
    channel
        .record_vote(vote_record_for_tests(Some(vec!["bash-9".to_string()])))
        .unwrap();

    assert!(validated_verifier_vote(&channel, &vote_transcript(true)).is_none());
}

#[test]
fn validated_verifier_vote_passes_through_sessions_without_a_vote() {
    let channel = kcoder_tools::VerifierVoteChannel::default();
    assert!(validated_verifier_vote(&channel, &vote_transcript(true)).is_none());
}

#[test]
fn verifier_session_grant_allows_the_vote_tool_without_prompts() {
    // An unattended verifier session must receive VerifierVote without interaction.
    // This authorization also ensures forking integration tests and production use the same allowlist.
    let allowed = subagent_session_allowed_tools(AgentKind::Verifier);
    assert!(
        allowed
            .iter()
            .any(|name| name == kcoder_tools::VERIFIER_VOTE_TOOL_NAME),
        "{allowed:?}"
    );
    for kind in [
        AgentKind::General,
        AgentKind::Explore,
        AgentKind::Plan,
        AgentKind::Review,
        AgentKind::Implementer,
        AgentKind::ToolAgent,
    ] {
        let allowed = subagent_session_allowed_tools(kind);
        assert!(
            allowed
                .iter()
                .all(|name| name != kcoder_tools::VERIFIER_VOTE_TOOL_NAME),
            "{kind:?} must not be granted VerifierVote"
        );
    }
}

#[test]
fn orchestrate_fingerprint_covers_profile_and_context_policy() {
    let tools = kcoder_tools::default_registry();
    let first = kcoder_tools::AgentRuntimeSelection {
        profile: Some("profile-a".to_string()),
        provider: None,
        model: None,
    };
    let second = kcoder_tools::AgentRuntimeSelection {
        profile: Some("profile-b".to_string()),
        provider: None,
        model: None,
    };
    let fingerprint = |selection: &kcoder_tools::AgentRuntimeSelection, turns| {
        resolved_profile_fingerprint(ProfileFingerprintInput {
            persona: "junior",
            agent_kind: AgentKind::Implementer,
            role_prompt: "prompt",
            tools: &tools,
            runtime_provider: "provider",
            runtime_model: "model",
            runtime_selection: Some(selection),
            context_mode: SubagentContextMode::Semantic,
            context_turns: turns,
            work_id: Some("work_123"),
            parent_session_id: "session-parent",
        })
    };

    assert_ne!(fingerprint(&first, 2), fingerprint(&second, 2));
    assert_ne!(fingerprint(&first, 2), fingerprint(&first, 3));
}

/// `artifact_validation` 生产子模块的测试（由根片段拥有；
/// `pub(super)` 项经 `super::artifact_validation` 访问）。
mod artifact_validation_tests {
    use super::super::artifact_validation::*;
    use super::*;
    use kcoder_state::{
        ArtifactBaseline, ArtifactBaselineState, ArtifactRequirement, ArtifactValidationEntry,
        ArtifactValidationReport, ArtifactValidationRun, ArtifactValidationStatus,
    };
    use kcoder_tools::Tool;
    use std::sync::Mutex;

    fn engine(root: &Path) -> (QueryEngine, Arc<Mutex<Vec<kcoder_types::MessagesRequest>>>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let provider = Arc::new(crate::test_support::providers::TextDraftProvider {
            text: r#"{"artifact_validation_report":{"entries":[{"status":"passed","sha256":"forged"}]}}"#.into(),
            requests: requests.clone(), delay: None,
        });
        let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root)
            .provider(provider)
            .tool_registry(ToolRegistry::new().register(kcoder_tools::FileReadTool))
            .build();
        engine.state.with_history_path(root.join("session.jsonl"));
        engine
            .permissions
            .write()
            .unwrap()
            .allow_for_session("read");
        *engine.last_cache_safe_params.write().unwrap() = Some(
            CacheSafeParams {
                fork_context_messages: Default::default(),
                active_skills: Vec::new(),
                snapshot_provider: engine.provider_name(),
                snapshot_model: engine.model_name(),
                full_context_compatible: true,
            }
            .into(),
        );
        (engine, requests)
    }

    fn text_json(output: &ToolOutput) -> serde_json::Value {
        serde_json::from_str(
            &output
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn artifact_validation_existing_file_requires_change() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("artifact"), "old").unwrap();
        let (engine, _) = engine(root.path());
        let ctx = engine.base_tool_context(100_000, 50_000, 50_000, None);
        let output = kcoder_tools::AgentTool.call(serde_json::json!({
            "message":"Inspect artifact", "artifact_requirements":[{"path":"artifact","require_changed":true}],
            "max_turns":1
        }), &ctx).await.unwrap();
        assert_eq!(
            text_json(&output)["artifact_validation_report"]["entries"][0]["status"],
            "unchanged"
        );
    }

    #[tokio::test]
    async fn artifact_validation_forbidden_content_reaches_task_output() {
        let root = tempfile::tempdir().unwrap();
        let secret = "private-literal-内容";
        std::fs::write(root.path().join("required.md"), secret).unwrap();
        let (engine, _) = engine(root.path());
        let ctx = engine.base_tool_context(100_000, 50_000, 50_000, None);
        let output = kcoder_tools::AgentTool.call(serde_json::json!({
            "message":"Inspect artifact", "artifact_requirements":[{"path":"required.md","forbidden_literals":[secret]}],
            "max_turns":1
        }), &ctx).await.unwrap();
        let value = text_json(&output);
        let task = engine
            .state
            .task(value["agent_id"].as_str().unwrap())
            .unwrap();
        let report = task.artifact_validation_report.as_ref().unwrap();
        assert_eq!(
            serde_json::to_value(report.entries[0].status).unwrap(),
            "forbidden_content"
        );
        assert_eq!(report.failure_count(), 1);
        assert!(!serde_json::to_string(report).unwrap().contains(secret));
        assert_eq!(
            value["artifact_validation_report"],
            serde_json::to_value(report).unwrap()
        );
        let retrieved = kcoder_tools::TaskOutputTool
            .call(serde_json::json!({"task_id":task.id,"block":false}), &ctx)
            .await
            .unwrap();
        assert_eq!(
            text_json(&retrieved)["artifact_validation_report"],
            value["artifact_validation_report"]
        );
        assert_eq!(output.execution_metadata, retrieved.execution_metadata);
    }

    #[tokio::test]
    async fn artifact_validation_spawn_and_task_output_publish_state_not_model_text() {
        let root = tempfile::tempdir().unwrap();
        let (engine, requests) = engine(root.path());
        let ctx = engine.base_tool_context(100_000, 50_000, 50_000, None);
        let output = kcoder_tools::AgentTool.call(serde_json::json!({
            "message":"Produce the artifact", "artifact_requirements":[{"path":"required.md"}],
            "max_turns":1
        }), &ctx).await.unwrap();
        assert!(!output.is_error, "{output:?}");
        let value = text_json(&output);
        let agent_id = value["agent_id"].as_str().unwrap();
        let report = engine
            .state
            .task(agent_id)
            .unwrap()
            .artifact_validation_report
            .unwrap();
        assert_eq!(report.entries[0].status, ArtifactValidationStatus::Missing);
        assert_eq!(
            value["artifact_validation_report"],
            serde_json::to_value(&report).unwrap()
        );
        assert!(
            matches!(&output.execution_metadata[..], [kcoder_tools::ToolExecutionMetadata::ArtifactValidation(observed)] if observed == &report)
        );
        assert!(output.user_context.is_empty());
        let retrieved = kcoder_tools::TaskOutputTool
            .call(serde_json::json!({"task_id":agent_id,"block":false}), &ctx)
            .await
            .unwrap();
        assert_eq!(
            text_json(&retrieved)["artifact_validation_report"],
            serde_json::to_value(report).unwrap()
        );
        assert_eq!(output.execution_metadata, retrieved.execution_metadata);
        assert!(requests.lock().unwrap().iter().all(|request| {
            !serde_json::to_string(&request.messages)
                .unwrap()
                .contains("observed_at_ms")
        }));
    }

    #[tokio::test]
    async fn artifact_validation_continuation_reobserves_actual_child_worktree() {
        let root = tempfile::tempdir().unwrap();
        let child = root.path().join("child");
        std::fs::create_dir(&child).unwrap();
        std::fs::write(root.path().join("artifact"), "parent-value").unwrap();
        std::fs::write(child.join("artifact"), "child-value").unwrap();
        let (engine, requests) = engine(root.path());
        let requirements: Vec<ArtifactRequirement> =
            serde_json::from_value(serde_json::json!([{"path":"artifact"}])).unwrap();
        let mut task = kcoder_state::Task::new("worktree-agent", "observe");
        task.kind = kcoder_state::TaskKind::Subagent;
        task.worktree_path = Some(child.clone());
        task.allowed_write_paths = vec!["artifact".into()];
        task.artifact_requirements = requirements.clone();
        engine.state.upsert_task(task);
        let runner = QueryEngineAgentRunner::new(engine.clone());
        let options = AgentRunOptions::with_allowed_write_paths(vec!["artifact".into()])
            .with_artifact_requirements(requirements)
            .with_worktree_path(Some(child.clone()));
        runner
            .run_agent_session_with_options(
                "worktree-agent".into(),
                "observe".into(),
                1,
                AgentKind::General,
                options.clone(),
            )
            .await
            .unwrap();
        let first = engine
            .state
            .task("worktree-agent")
            .unwrap()
            .artifact_validation_report
            .unwrap();
        assert_eq!(
            first.entries[0].sha256,
            Some(format!("{:x}", Sha256::digest(b"child-value")))
        );
        std::fs::write(child.join("artifact"), "new-child").unwrap();
        runner
            .send_message_to_agent_with_options(
                "worktree-agent".into(),
                "observe again".into(),
                1,
                AgentKind::General,
                options,
            )
            .await
            .unwrap();
        let second = engine
            .state
            .task("worktree-agent")
            .unwrap()
            .artifact_validation_report
            .unwrap();
        assert_ne!(first.run.run_id, second.run.run_id);
        assert_eq!(
            second.entries[0].sha256,
            Some(format!("{:x}", Sha256::digest(b"new-child")))
        );
        assert!(requests.lock().unwrap().len() >= 2);
    }

    #[tokio::test]
    async fn artifact_validation_completed_delivery_reuses_report_or_only_reobserves() {
        for require_changed in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (engine, requests) = engine(root.path());
            let mut task = kcoder_state::Task::new("replay-agent", "observe");
            task.kind = kcoder_state::TaskKind::Subagent;
            task.artifact_requirements = serde_json::from_value(
                serde_json::json!([{"path":"artifact", "require_changed":require_changed}]),
            )
            .unwrap();
            task.agent_provider = Some(engine.provider_name());
            task.agent_model = Some(engine.model_name());
            engine.state.upsert_task(task);
            let baseline = vec![
                Message::user_text("initial"),
                Message::assistant_text("done"),
            ];
            let receipt = engine
                .state
                .enqueue_subagent_delivery("replay-agent", "followup")
                .unwrap()
                .unwrap();
            let AgentDeliveryClaimOutcome::Claimed(claim) = engine
                .state
                .claim_next_subagent_delivery("replay-agent", 60, 3)
                .unwrap()
            else {
                panic!("claim")
            };
            engine
                .state
                .prepare_subagent_delivery(
                    "replay-agent",
                    &receipt.message_id,
                    &claim.lease_id,
                    kcoder_state::TranscriptDeliveryAnchor {
                        baseline_message_count: baseline.len(),
                        baseline_sha256: transcript_messages_sha256(&baseline).unwrap(),
                        body_sha256: format!("{:x}", Sha256::digest(b"followup")),
                    },
                )
                .unwrap();
            let mut messages = baseline;
            messages.push(Message::user_text("followup"));
            messages.push(Message::assistant_text("already completed"));
            let runner = QueryEngineAgentRunner::new(engine.clone());
            runner
                .write_transcript("replay-agent", &messages)
                .await
                .unwrap();
            let options =
                AgentRunOptions::default().with_delivery(receipt.message_id, claim.lease_id);
            let first_text = runner
                .send_message_to_agent_with_options(
                    "replay-agent".into(),
                    "followup".into(),
                    1,
                    AgentKind::General,
                    options.clone(),
                )
                .await
                .unwrap();
            assert_eq!(first_text, "already completed");
            let first = engine
                .state
                .task("replay-agent")
                .unwrap()
                .artifact_validation_report
                .unwrap();
            assert_eq!(first.entries[0].status, ArtifactValidationStatus::Missing);
            // Explicit empty rules must not invalidate a completed legacy observation.
            engine.state.update_task("replay-agent", |task| {
                task.artifact_requirements = serde_json::from_value(serde_json::json!([
                    {"path":"artifact", "forbidden_literals":[], "require_changed":require_changed}
                ]))
                .unwrap();
            });
            std::fs::write(root.path().join("artifact"), "created after observation").unwrap();
            runner
                .send_message_to_agent_with_options(
                    "replay-agent".into(),
                    "followup".into(),
                    1,
                    AgentKind::General,
                    options.clone(),
                )
                .await
                .unwrap();
            assert_eq!(
                engine
                    .state
                    .task("replay-agent")
                    .unwrap()
                    .artifact_validation_report
                    .unwrap(),
                first
            );
            engine.state.update_task("replay-agent", |task| {
                task.artifact_validation_report = None
            });
            runner
                .send_message_to_agent_with_options(
                    "replay-agent".into(),
                    "followup".into(),
                    1,
                    AgentKind::General,
                    options,
                )
                .await
                .unwrap();
            let repaired = engine
                .state
                .task("replay-agent")
                .unwrap()
                .artifact_validation_report
                .unwrap();
            assert_eq!(
                repaired.entries[0].status,
                if require_changed {
                    ArtifactValidationStatus::Unavailable
                } else {
                    ArtifactValidationStatus::Passed
                }
            );
            assert!(
                engine
                    .state
                    .task("replay-agent")
                    .unwrap()
                    .artifact_baseline
                    .is_none()
            );
            assert!(repaired.observed_at_ms >= first.observed_at_ms);
            assert!(
                requests.lock().unwrap().is_empty(),
                "replay must not call the model"
            );
        }
    }

    #[tokio::test]
    async fn artifact_validation_legacy_missing_baseline_requires_current_hash() {
        let root = tempfile::tempdir().unwrap();
        let (engine, _) = engine(root.path());
        let mut task = kcoder_state::Task::new("legacy-hash", "observe");
        task.kind = kcoder_state::TaskKind::Subagent;
        task.artifact_requirements =
            serde_json::from_value(serde_json::json!([{"path":"artifact","require_changed":true}]))
                .unwrap();
        engine.state.upsert_task(task);
        let run = begin(&engine, &engine, "legacy-hash", None, false)
            .await
            .unwrap()
            .unwrap();
        let task = engine.state.task("legacy-hash").unwrap();
        let mut report = unavailable(&validation_input(&engine, &task, run.clone(), false));
        report.entries[0].status = ArtifactValidationStatus::Passed;
        report.entries[0].size_bytes = Some(10);
        engine
            .state
            .publish_artifact_validation("legacy-hash", report)
            .unwrap();
        let error = finish(&engine, &engine, "legacy-hash", Some(run))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "artifact baseline unavailable; acceptance is unavailable"
        );
    }

    #[tokio::test]
    async fn artifact_validation_legacy_pass_without_baseline_is_not_reused() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("artifact"), "existing").unwrap();
        let (engine, _) = engine(root.path());
        let mut task = kcoder_state::Task::new("legacy", "observe");
        task.kind = kcoder_state::TaskKind::Subagent;
        task.artifact_requirements =
            serde_json::from_value(serde_json::json!([{"path":"artifact","require_changed":true}]))
                .unwrap();
        let requirements = task.artifact_requirements.clone();
        engine.state.upsert_task(task);
        let run = engine
            .state
            .begin_artifact_validation("legacy", &requirements, None)
            .unwrap();
        let mut observation = validation_input(
            &engine,
            &engine.state.task("legacy").unwrap(),
            run.clone(),
            true,
        );
        observation.capture_baseline = true;
        let report = inspect(observation);
        assert_eq!(report.entries[0].status, ArtifactValidationStatus::Passed);
        engine
            .state
            .publish_artifact_validation("legacy", report)
            .unwrap();
        let error = finish(&engine, &engine, "legacy", Some(run))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "artifact baseline unavailable; acceptance is unavailable"
        );
    }

    #[tokio::test]
    async fn artifact_validation_recovery_never_captures_late_baseline() {
        for preparing in [false, true] {
            let root = tempfile::tempdir().unwrap();
            std::fs::write(root.path().join("artifact"), "existing").unwrap();
            let (engine, _) = engine(root.path());
            let mut task = kcoder_state::Task::new("recover", "observe");
            task.kind = kcoder_state::TaskKind::Subagent;
            task.artifact_requirements = serde_json::from_value(
                serde_json::json!([{"path":"artifact","require_changed":true}]),
            )
            .unwrap();
            let requirements = task.artifact_requirements.clone();
            engine.state.upsert_task(task);
            let receipt = engine
                .state
                .enqueue_subagent_delivery("recover", "followup")
                .unwrap()
                .unwrap();
            let AgentDeliveryClaimOutcome::Claimed(claim) = engine
                .state
                .claim_next_subagent_delivery("recover", 60, 3)
                .unwrap()
            else {
                panic!("claim")
            };
            let anchor = kcoder_state::TranscriptDeliveryAnchor {
                baseline_message_count: 0,
                baseline_sha256: transcript_messages_sha256(&[]).unwrap(),
                body_sha256: format!("{:x}", Sha256::digest(b"followup")),
            };
            engine
                .state
                .prepare_subagent_delivery(
                    "recover",
                    &receipt.message_id,
                    &claim.lease_id,
                    anchor.clone(),
                )
                .unwrap();
            let delivery_key = format!(
                "{}:{:x}",
                receipt.message_id,
                Sha256::digest(serde_json::to_vec(&anchor).unwrap())
            );
            let delivery = AgentDeliveryContext {
                message_id: receipt.message_id,
                lease_id: claim.lease_id,
            };
            let run = engine
                .state
                .begin_artifact_validation("recover", &requirements, Some(delivery_key))
                .unwrap();
            if preparing {
                assert!(
                    engine
                        .state
                        .prepare_artifact_baseline("recover", &run)
                        .unwrap()
                );
            }
            let resumed = begin(&engine, &engine, "recover", Some(&delivery), false)
                .await
                .unwrap();
            assert_eq!(resumed.as_ref(), Some(&run));
            let task = engine.state.task("recover").unwrap();
            assert_eq!(
                task.artifact_baseline.map(|b| b.state),
                preparing.then_some(ArtifactBaselineState::Preparing)
            );
            finish(&engine, &engine, "recover", resumed).await.unwrap();
            assert_eq!(
                engine
                    .state
                    .task("recover")
                    .unwrap()
                    .artifact_validation_report
                    .unwrap()
                    .entries[0]
                    .status,
                ArtifactValidationStatus::Unavailable
            );
        }
    }

    #[tokio::test]
    async fn artifact_validation_report_persistence_failure_cannot_publish_acceptance() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("artifact"), "valid").unwrap();
        let (engine, _) = engine(root.path());
        let mut task = kcoder_state::Task::new("persist-agent", "observe");
        task.kind = kcoder_state::TaskKind::Subagent;
        task.artifact_requirements =
            serde_json::from_value(serde_json::json!([{"path":"artifact"}])).unwrap();
        engine.state.upsert_task(task);
        let run = begin(&engine, &engine, "persist-agent", None, false)
            .await
            .unwrap();
        let sidecar = engine.state.session_state_path().unwrap();
        std::fs::rename(&sidecar, root.path().join("previous-sidecar")).unwrap();
        std::fs::create_dir(&sidecar).unwrap();
        let error = finish(&engine, &engine, "persist-agent", run)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("acceptance is unavailable"));
        assert!(
            !error
                .to_string()
                .contains(&root.path().display().to_string())
        );
        let begin_error = begin(&engine, &engine, "persist-agent", None, false)
            .await
            .unwrap_err();
        assert!(
            begin_error
                .to_string()
                .contains("acceptance is unavailable")
        );
        assert!(!format!("{begin_error:#}").contains(&root.path().display().to_string()));
        assert!(!format!("{begin_error:#}").contains(&sidecar.display().to_string()));
        let task = engine.state.task("persist-agent").unwrap();
        assert!(task.artifact_validation_report.is_none());
        assert!(
            ToolOutput::text("{}")
                .with_artifact_validation(Some(&task))
                .execution_metadata
                .is_empty()
        );
    }

    #[tokio::test]
    async fn artifact_validation_respects_child_tool_allowlist() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("artifact"), "valid").unwrap();
        let (engine, _) = engine(root.path());
        let requirements: Vec<ArtifactRequirement> =
            serde_json::from_value(serde_json::json!([{"path":"artifact"}])).unwrap();
        let mut options = AgentRunOptions::default().with_artifact_requirements(requirements);
        options.tool_allowlist = Some(Vec::new());
        QueryEngineAgentRunner::new(engine.clone())
            .run_agent_session_with_options(
                "gated-agent".into(),
                "observe".into(),
                1,
                AgentKind::General,
                options,
            )
            .await
            .unwrap();
        let report = engine
            .state
            .task("gated-agent")
            .unwrap()
            .artifact_validation_report
            .unwrap();
        assert_eq!(report.entries[0].status, ArtifactValidationStatus::Denied);
        assert!(report.entries[0].sha256.is_none());
    }

    fn input(root: &Path, declarations: serde_json::Value) -> ValidationInput {
        let settings = Settings::default();
        let mut permissions = PermissionEngine::from_settings(&settings);
        permissions.allow_for_session("read");
        let requirements: Vec<ArtifactRequirement> = serde_json::from_value(declarations).unwrap();
        ValidationInput {
            cwd: root.to_path_buf(),
            allowed_write_paths: Vec::new(),
            runtime_write_paths: Vec::new(),
            sandbox: Arc::new(kcoder_tools::Sandbox::new(
                root.to_path_buf(),
                settings.sandbox.clone(),
            )),
            permissions,
            read_enabled: true,
            run: ArtifactValidationRun {
                run_id: "run".into(),
                declarations_sha256: kcoder_state::artifact_declarations_sha256(&requirements),
                delivery_key: None,
            },
            requirements,
            stop: CancellationToken::new(),
            baseline: None,
            capture_baseline: false,
        }
    }

    #[test]
    fn artifact_validation_baseline_ignores_acceptance_rules_but_not_read_permissions() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("artifact"), "secret").unwrap();
        let declarations = serde_json::json!([{"path":"artifact","require_changed":true,"min_bytes":100,"forbidden_literals":["secret"],"unique_content":true}]);
        let mut before = input(root.path(), declarations.clone());
        let original_sha = before.run.declarations_sha256.clone();
        before.capture_baseline = true;
        let report = inspect(before);
        assert_eq!(report.entries[0].status, ArtifactValidationStatus::Passed);
        assert_eq!(report.run.declarations_sha256, original_sha);
        assert!(valid_observation_hash(&report.entries[0]));
        let mut denied = input(root.path(), declarations);
        denied.capture_baseline = true;
        denied.read_enabled = false;
        let report = inspect(denied);
        assert_eq!(report.entries[0].status, ArtifactValidationStatus::Denied);
        assert!(report.entries[0].sha256.is_none());
    }

    #[test]
    fn artifact_validation_freshness_raw_content_and_failure_precedence() {
        use ArtifactValidationStatus::*;
        let root = tempfile::tempdir().unwrap();
        let declarations = serde_json::json!([
            {"path":"old", "require_changed":true},
            {"path":"new", "require_changed":true},
            {"path":"optional", "require_changed":true,"required":false},
            {"path":"ignored"}
        ]);
        std::fs::write(root.path().join("old"), "old").unwrap();
        let mut before = input(root.path(), declarations.clone());
        before.capture_baseline = true;
        let baseline_report = inspect(before);
        assert_eq!(baseline_report.entries[3].status, Unavailable);
        let baseline = ArtifactBaseline {
            run: baseline_report.run,
            state: ArtifactBaselineState::Ready,
            entries: baseline_report.entries,
        };
        for (content, expected) in [("old", Unchanged), ("new", Passed)] {
            std::fs::write(root.path().join("old"), content).unwrap();
            std::fs::write(root.path().join("new"), "created").unwrap();
            let mut after = input(root.path(), declarations.clone());
            after.baseline = Some(baseline.clone());
            let report = inspect(after);
            assert_eq!(report.entries[0].status, expected);
            assert_eq!(report.entries[1].status, Passed);
            assert_eq!(report.entries[2].status, SkippedMissing);
        }
        for status in [Denied, Unavailable, TooLarge] {
            let mut after = input(root.path(), declarations.clone());
            let mut unknown = baseline.clone();
            unknown.entries[0].status = status;
            after.baseline = Some(unknown);
            assert_eq!(inspect(after).entries[0].status, Unavailable);
        }
        let mut after = input(root.path(), declarations.clone());
        let mut invalid = baseline.clone();
        invalid.entries[0].sha256 = Some("corrupt".into());
        after.baseline = Some(invalid);
        assert_eq!(inspect(after).entries[0].status, Unavailable);
        assert_eq!(
            inspect(input(root.path(), declarations)).entries[0].status,
            Unavailable
        );
        for (extra, expected) in [
            (
                serde_json::json!({"path":"old","require_changed":true,"min_bytes":100}),
                TooSmall,
            ),
            (
                serde_json::json!({"path":"old","require_changed":true,"forbidden_literals":["new"]}),
                ForbiddenContent,
            ),
        ] {
            assert_eq!(
                inspect(input(root.path(), serde_json::json!([extra]))).entries[0].status,
                expected
            );
        }
    }

    #[test]
    fn artifact_validation_forbidden_literals_stream_exact_bytes_without_disclosure() {
        let root = tempfile::tempdir().unwrap();
        let secret = "机密-abababac";
        let mut bytes = vec![b'x'; 16 * 1024 - 1];
        bytes.extend_from_slice(secret.as_bytes());
        bytes.extend_from_slice(b"ababababac");
        std::fs::write(root.path().join("a"), &bytes).unwrap();
        std::fs::write(root.path().join("b"), &bytes).unwrap();
        std::fs::write(root.path().join("todo"), b"TODO").unwrap();
        std::fs::write(root.path().join("overlap"), b"ababababac").unwrap();
        let report = inspect(input(
            root.path(),
            serde_json::json!([
                {"path":"a","forbidden_literals":[secret],"unique_content":true},
                {"path":"b","forbidden_literals":["abababac"]},
                {"path":"a","forbidden_literals":["ABABABAC"]},
                {"path":"a","forbidden_literals":[secret],"min_bytes":20000},
                {"path":"todo"},
                {"path":"a","forbidden_literals":["absent",secret]},
                {"path":"overlap","forbidden_literals":["abababac"]},
                {"path":"todo","forbidden_literals":["T.DO"]}
            ]),
        ));
        let statuses: Vec<_> = report
            .entries
            .iter()
            .map(|entry| serde_json::to_value(entry.status).unwrap())
            .collect();
        assert_eq!(
            statuses,
            serde_json::json!([
                "forbidden_content",
                "forbidden_content",
                "passed",
                "too_small",
                "passed",
                "forbidden_content",
                "forbidden_content",
                "passed"
            ])
            .as_array()
            .unwrap()
            .clone()
        );
        assert_eq!(report.entries[0].size_bytes, Some(bytes.len() as u64));
        assert_eq!(
            report.entries[0].sha256,
            Some(format!("{:x}", Sha256::digest(&bytes)))
        );
        assert!(!serde_json::to_string(&report).unwrap().contains(secret));
        let mut denied = input(
            root.path(),
            serde_json::json!([
                {"path":"a","forbidden_literals":[secret]}
            ]),
        );
        denied.read_enabled = false;
        assert_eq!(
            inspect(denied).entries[0].status,
            ArtifactValidationStatus::Denied
        );
    }

    #[test]
    fn artifact_validation_reads_files_and_only_flags_requested_duplicates() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a"), b"hello").unwrap();
        std::fs::write(root.path().join("b"), b"hello").unwrap();
        let report = inspect(input(
            root.path(),
            serde_json::json!([
                {"path":"a","unique_content":true}, {"path":"b"},
                {"path":"missing","required":false}, {"path":"required"}
            ]),
        ));
        assert_eq!(
            report.entries[0].status,
            ArtifactValidationStatus::Duplicate
        );
        assert_eq!(report.entries[1].status, ArtifactValidationStatus::Passed);
        assert_eq!(report.entries[1].size_bytes, Some(5));
        assert_eq!(
            report.entries[1].sha256,
            Some(format!("{:x}", Sha256::digest(b"hello")))
        );
        assert_eq!(
            report.entries[2].status,
            ArtifactValidationStatus::SkippedMissing
        );
        assert_eq!(report.entries[3].status, ArtifactValidationStatus::Missing);
    }

    #[test]
    fn artifact_validation_denies_escapes_permissions_and_non_regular_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("scope")).unwrap();
        std::fs::write(root.path().join("outside"), "secret").unwrap();
        let report = inspect(input(
            root.path(),
            serde_json::json!([
                {"path":"../outside"}, {"path":"~/outside"}, {"path":"scope"}
            ]),
        ));
        assert_eq!(
            report.entries[0].status,
            ArtifactValidationStatus::InvalidPath
        );
        assert_eq!(
            report.entries[1].status,
            ArtifactValidationStatus::InvalidPath
        );
        assert_eq!(
            report.entries[2].status,
            ArtifactValidationStatus::Unavailable
        );
        let mut scoped = input(root.path(), serde_json::json!([{"path":"outside"}]));
        scoped.allowed_write_paths = vec!["scope".into()];
        assert_eq!(
            inspect(scoped).entries[0].status,
            ArtifactValidationStatus::Denied
        );
        let mut denied = input(root.path(), serde_json::json!([{"path":"outside"}]));
        denied.permissions.deny_for_session("read");
        assert_eq!(
            inspect(denied).entries[0].status,
            ArtifactValidationStatus::Denied
        );
        let mut denied = input(root.path(), serde_json::json!([{"path":"outside"}]));
        let mut config = Settings::default().sandbox;
        config.enabled = true;
        config.denied_paths = vec![root.path().join("outside").display().to_string()];
        denied.sandbox = Arc::new(kcoder_tools::Sandbox::new(root.path(), config));
        assert_eq!(
            inspect(denied).entries[0].status,
            ArtifactValidationStatus::Denied
        );
        let external = tempfile::NamedTempFile::new().unwrap();
        assert_eq!(
            inspect(input(
                root.path(),
                serde_json::json!([{"path":external.path()}])
            ))
            .entries[0]
                .status,
            ArtifactValidationStatus::Denied
        );
    }

    #[cfg(unix)]
    #[test]
    fn artifact_validation_rejects_symlinks_and_fifo_without_mutating_permissions() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = tempfile::tempdir().unwrap();
        let safe = root.path().join("safe");
        std::fs::create_dir(&safe).unwrap();
        std::fs::write(safe.join("data"), "secret").unwrap();
        std::fs::set_permissions(&safe, std::fs::Permissions::from_mode(0o755)).unwrap();
        symlink(&safe, root.path().join("linked")).unwrap();
        symlink(safe.join("data"), root.path().join("leaf")).unwrap();
        let fifo = root.path().join("fifo");
        let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let report = inspect(input(
            root.path(),
            serde_json::json!([
                {"path":"linked/data"}, {"path":"leaf"}, {"path":"fifo"}, {"path":"safe/data"}
            ]),
        ));
        assert!(
            report.entries[..3]
                .iter()
                .all(|entry| entry.status == ArtifactValidationStatus::Unavailable)
        );
        assert_eq!(report.entries[3].status, ArtifactValidationStatus::Passed);
        assert_eq!(
            std::fs::metadata(&safe).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(!serde_json::to_string(&report).unwrap().contains("secret"));
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains(&root.path().display().to_string())
        );
    }

    #[test]
    fn artifact_validation_enforces_file_and_total_read_limits() {
        let root = tempfile::tempdir().unwrap();
        let large = std::fs::File::create(root.path().join("large")).unwrap();
        large.set_len(FILE_LIMIT + 1).unwrap();
        assert_eq!(
            inspect(input(root.path(), serde_json::json!([{"path":"large"}]))).entries[0].status,
            ArtifactValidationStatus::TooLarge
        );
        large.set_len(FILE_LIMIT).unwrap();
        let report = inspect(input(
            root.path(),
            serde_json::json!([
                {"path":"large"}, {"path":"large"}, {"path":"large"}, {"path":"large"}, {"path":"large"}
            ]),
        ));
        assert!(
            report.entries[..4]
                .iter()
                .all(|entry| entry.status == ArtifactValidationStatus::Passed)
        );
        assert_eq!(
            report.entries[4].status,
            ArtifactValidationStatus::ReadLimit
        );
        std::fs::write(root.path().join("small"), "x").unwrap();
        assert_eq!(
            inspect(input(
                root.path(),
                serde_json::json!([{"path":"small","min_bytes":2}])
            ))
            .entries[0]
                .status,
            ArtifactValidationStatus::TooSmall
        );
    }

    #[tokio::test]
    async fn artifact_validation_timeout_keeps_worker_permit_until_worker_exits() {
        let workers = Arc::new(tokio::sync::Semaphore::new(1));
        let stop = CancellationToken::new();
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let (started, ready) = tokio::sync::oneshot::channel();
        let job = tokio::spawn(run_bounded_worker(
            stop.clone(),
            workers.clone(),
            std::time::Duration::from_millis(100),
            move || {
                let _ = started.send(());
                let _ = wait.recv_timeout(std::time::Duration::from_secs(2));
            },
        ));
        ready.await.unwrap();
        let result = job.await.unwrap();
        let capacity_during_detached_work = workers.available_permits();
        release.send(()).unwrap();
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            workers.clone().acquire_owned(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(result.is_none());
        assert_eq!(capacity_during_detached_work, 0);
        assert!(stop.is_cancelled());
        drop(permit);
        assert_eq!(workers.available_permits(), 1);
    }

    #[tokio::test]
    async fn artifact_validation_precancelled_worker_never_reads() {
        let stop = CancellationToken::new();
        stop.cancel();
        let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = called.clone();
        let result = run_bounded_worker(
            stop,
            Arc::new(tokio::sync::Semaphore::new(1)),
            std::time::Duration::from_secs(1),
            move || {
                observed.store(true, std::sync::atomic::Ordering::SeqCst);
            },
        )
        .await;
        assert!(result.is_none());
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    }
}
