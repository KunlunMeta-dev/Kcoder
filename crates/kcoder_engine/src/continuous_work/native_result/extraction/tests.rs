use super::*;
use kcoder_tools::ToolOutput;
use kcoder_types::{BackgroundRunKey, ImageSource};
use std::path::PathBuf;

fn identity() -> BackgroundEventIdentity {
    BackgroundEventIdentity::terminal(BackgroundRunKey {
        parent_session_id: "session-1".into(),
        agent_id: "job-1".into(),
        run_id: "run-1".into(),
    })
}

fn process(exit_code: Option<i32>, signal: Option<i32>) -> ToolExecutionMetadata {
    ToolExecutionMetadata::Process {
        exit_code,
        signal,
        cwd: PathBuf::from("/private/working-directory"),
    }
}

fn completed(output: ToolOutput) -> BackgroundJobEvent {
    BackgroundJobEvent::Completed {
        id: "job-1".into(),
        output,
    }
}

fn prepared(event: &BackgroundJobEvent) -> PreparedTerminalEvidence {
    prepare_terminal(&identity(), event, 4096).unwrap().unwrap()
}

#[test]
fn process_exit_comes_from_typed_metadata_not_output_text() {
    let output = ToolOutput::text("exit_code: 0\n...[truncated 100 bytes]...")
        .with_execution_metadata(process(Some(141), None));
    let result = prepared(&completed(output));
    assert_eq!(result.status, TaskStatus::Completed);
    assert_eq!(result.output_is_error, Some(false));
    assert_eq!(
        result.completeness,
        BackgroundContentCompleteness::Unobserved
    );
    assert_eq!(result.process.state, BackgroundProcessState::Observed);
    assert_eq!(result.process.exit_code, Some(141));
    assert_eq!(result.process.signal, None);
    let PreparedContent::Available(body) = result.content else {
        panic!("bounded text should be prepared")
    };
    assert_eq!(body.kind, BackgroundPayloadKind::ToolOutput);
    assert_eq!(
        body.sha256,
        format!("{:x}", Sha256::digest(body.private_bytes()))
    );
}

#[test]
fn failure_diagnostic_is_not_the_original_complete_tool_output() {
    let event = BackgroundJobEvent::Failed {
        id: "job-1".into(),
        error: "exit_code: 0".into(),
        execution_metadata: vec![process(Some(42), None)],
    };
    let result = prepared(&event);
    assert_eq!(result.status, TaskStatus::Failed);
    assert_eq!(result.output_is_error, None);
    assert_eq!(result.process.exit_code, Some(42));
    assert_eq!(
        result.completeness,
        BackgroundContentCompleteness::Unobserved
    );
    let PreparedContent::Available(body) = result.content else {
        panic!("bounded diagnostic should be prepared")
    };
    assert_eq!(body.kind, BackgroundPayloadKind::TerminalDiagnostic);
}

#[test]
fn absent_unknown_and_conflicting_process_metadata_stay_distinct() {
    for (metadata, state) in [
        (vec![], BackgroundProcessState::NotReported),
        (
            vec![process(None, None)],
            BackgroundProcessState::Indeterminate,
        ),
        (
            vec![process(Some(0), None), process(Some(9), None)],
            BackgroundProcessState::Conflicting,
        ),
        (
            vec![process(Some(0), Some(9))],
            BackgroundProcessState::Conflicting,
        ),
    ] {
        let mut output = ToolOutput::text("body");
        output.execution_metadata = metadata;
        let result = prepared(&completed(output));
        assert_eq!(result.process.state, state);
        assert_eq!(result.process.exit_code, None);
        assert_eq!(result.process.signal, None);
        result.process.validate_shape().unwrap();
    }
    let signal = prepared(&completed(
        ToolOutput::text("body").with_execution_metadata(process(None, Some(9))),
    ));
    assert_eq!(signal.process.state, BackgroundProcessState::Observed);
    assert_eq!(signal.process.signal, Some(9));
}

#[test]
fn inconsistent_outcome_and_producer_flag_are_both_retained() {
    let result = prepared(&completed(ToolOutput::error("producer flagged an error")));
    assert_eq!(result.status, TaskStatus::Completed);
    assert_eq!(result.output_is_error, Some(true));
    assert_eq!(
        result.completeness,
        BackgroundContentCompleteness::Unobserved
    );
}

#[test]
fn only_the_exact_run_and_scoped_event_are_accepted() {
    let original = identity();
    let mut other = original.clone();
    other.run.run_id = "different-run".into();
    let event = BackgroundJobEvent::Scoped {
        identity: other,
        event: Box::new(completed(ToolOutput::text("result"))),
    };
    assert_eq!(
        prepare_terminal(&original, &event, 4096),
        Err(ExtractionError::IdentityMismatch)
    );
    let wrong_job = BackgroundJobEvent::Completed {
        id: "other-job".into(),
        output: ToolOutput::text("result"),
    };
    assert_eq!(
        prepare_terminal(&original, &wrong_job, 4096),
        Err(ExtractionError::IdentityMismatch)
    );
    let nonterminal = BackgroundJobEvent::Started {
        id: "job-1".into(),
        description: "task".into(),
        continuation: false,
    };
    assert_eq!(prepare_terminal(&original, &nonterminal, 4096), Ok(None));
}

#[test]
fn multimodal_output_is_not_silently_dropped_or_encoded() {
    let mut output = ToolOutput::text("visible text");
    output.content.push(ContentBlock::Image {
        source: ImageSource::base64("image/png", "image-data"),
    });
    let result = prepared(&completed(output));
    assert_eq!(result.content, PreparedContent::Unsupported);
    assert_eq!(
        result.completeness,
        BackgroundContentCompleteness::Unobserved
    );
}

#[test]
fn oversized_payload_preserves_terminal_and_exit_without_partial_body() {
    let output = ToolOutput::text("x".repeat(4096)).with_execution_metadata(process(Some(5), None));
    let result = prepare_terminal(&identity(), &completed(output), 128)
        .unwrap()
        .unwrap();
    assert_eq!(result.content, PreparedContent::TooLarge);
    assert_eq!(result.process.exit_code, Some(5));
    assert_eq!(result.status, TaskStatus::Completed);
    assert_eq!(
        result.completeness,
        BackgroundContentCompleteness::Unobserved
    );
}

#[test]
fn private_context_and_working_directory_never_enter_prepared_body_or_debug() {
    let mut output =
        ToolOutput::text("visible body").with_execution_metadata(process(Some(0), None));
    output.user_context.push(ContentBlock::Text {
        text: "private hidden context".into(),
    });
    let result = prepared(&completed(output));
    let debug = format!("{result:?}");
    assert!(!debug.contains("visible body"));
    assert!(!debug.contains("private hidden context"));
    assert!(!debug.contains("/private/working-directory"));
    let PreparedContent::Available(body) = result.content else {
        panic!("bounded text should be prepared")
    };
    let text = std::str::from_utf8(body.private_bytes()).unwrap();
    assert!(text.contains("visible body"));
    assert!(!text.contains("private hidden context"));
    assert!(!text.contains("/private/working-directory"));
}

#[test]
fn cancellation_and_halt_are_diagnostics_not_success_or_proof_of_no_side_effect() {
    for (event, status) in [
        (
            BackgroundJobEvent::Cancelled {
                id: "job-1".into(),
                reason: "cancelled".into(),
            },
            TaskStatus::Cancelled,
        ),
        (
            BackgroundJobEvent::Halted {
                id: "job-1".into(),
                reason: "halted".into(),
            },
            TaskStatus::Halted,
        ),
    ] {
        let result = prepared(&event);
        assert_eq!(result.status, status);
        assert_eq!(result.process.state, BackgroundProcessState::NotReported);
        assert_eq!(
            result.completeness,
            BackgroundContentCompleteness::Unobserved
        );
        assert!(matches!(
            result.content,
            PreparedContent::Available(PreparedPayload {
                kind: BackgroundPayloadKind::TerminalDiagnostic,
                ..
            })
        ));
    }
}

#[test]
fn invalid_capture_limit_is_never_interpreted_as_unlimited() {
    let event = completed(ToolOutput::text("result"));
    for limit in [0, MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES as usize + 1] {
        assert_eq!(
            prepare_terminal(&identity(), &event, limit),
            Err(ExtractionError::InvalidLimit)
        );
    }
}
