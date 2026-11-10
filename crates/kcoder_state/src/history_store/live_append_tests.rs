//! Focused authority, acceptance-ticket and live-append regressions.
use super::*;

#[test]
fn source_commit_uncertain_task_receipt_preserves_pending_delivery_in_memory() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("delivery-cut.jsonl");
    let state = crate::AppState::new(temp.path());
    state.with_history_path(&path);
    let mut task = crate::Task::new("agent", "pending delivery");
    task.kind = crate::TaskKind::Subagent;
    state.upsert_task(task);
    let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
    let error = state
        .enqueue_subagent_delivery("agent", "keep me")
        .unwrap_err();
    assert!(is_uncertain_mutation(&error));
    assert_eq!(
        state.task("agent").unwrap().message_queue.len(),
        1,
        "do not roll memory behind possibly committed authority"
    );
    state.save_history().unwrap();
    let restored = crate::AppState::new(temp.path());
    restored.resume_from_history(&path).unwrap();
    assert_eq!(restored.task("agent").unwrap().message_queue.len(), 1);
}

#[test]
fn source_commit_uncertain_mode_receipt_cannot_roll_back_or_report_retry_success() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("mode-cut.jsonl");
    let state = crate::AppState::new(temp.path());
    state.with_history_path(&path);
    let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
    assert!(state.enter_orchestrate_before_first_message().is_err());
    assert_eq!(state.session_mode(), crate::SessionMode::Orchestrate);
    assert!(state.enter_orchestrate_before_first_message().is_err());
    state.save_history().unwrap();
    assert!(!state.enter_orchestrate_before_first_message().unwrap());
}

#[tokio::test]
async fn exact_input_ticket_never_confirms_an_uncertain_authority_write() {
    for existing in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("input-cut.jsonl");
        if existing {
            std::fs::write(&path, b"").unwrap();
        }
        let state = crate::AppState::new(temp.path());
        state.with_history_path(&path);
        let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
        let owner = state.inspection_lifecycle_identity();
        let pending =
            match state.try_begin_user_input(&owner, crate::Message::user_text("original input")) {
                crate::UserInputStart::Accepted(pending) => pending,
                _ => panic!("the isolated original input must be accepted"),
            };
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), pending.wait())
            .await
            .unwrap();
        assert!(result.is_err());
        let bytes = std::fs::read(&path).unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("original input"));
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "an uncertain original input must never be retried by the writer timer"
        );
    }
}

#[test]
fn witnessed_append_keeps_original_handles_and_exact_commit_facts() -> Result<()> {
    use sha2::Digest;
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("witnessed.jsonl");
    std::fs::write(&path, b"")?;
    let source = HistorySource::bind(&path)?;
    let bytes = b"{\"message\":\"first\"}\n";
    let mut first = source.append_with_live_receipt(bytes)?;
    assert_eq!((first.start, first.end), (0, bytes.len() as u64));
    assert_eq!(first.sha256, format!("{:x}", sha2::Sha256::digest(bytes)));
    let committed = first
        .committed
        .as_ref()
        .context("source commit facts missing")?;
    assert_ne!(committed.incarnation, uuid::Uuid::nil());
    assert_ne!(committed.generation, uuid::Uuid::nil());
    assert_eq!(committed.revision, 1);
    assert_eq!(committed.control_sha256.len(), 64);
    first.verify_contents()?;
    let second_bytes = b"{\"message\":\"second\"}\n";
    let mut second = source.append_with_live_receipt(second_bytes)?;
    assert_eq!(second.start, bytes.len() as u64);
    assert_eq!(second.end, (bytes.len() + second_bytes.len()) as u64);
    second.verify_contents()?;
    assert!(first.verify_contents().is_err());
    Ok(())
}

#[cfg(unix)]
#[test]
fn witnessed_append_rejects_same_content_replacement_of_the_original_file() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("witnessed-replace.jsonl");
    std::fs::write(&path, b"")?;
    let source = HistorySource::bind(&path)?;
    let bytes = b"{\"message\":\"original\"}\n";
    let mut receipt = source.append_with_live_receipt(bytes)?;
    let original = temp.path().join("original-held.jsonl");
    std::fs::rename(&path, &original)?;
    std::fs::write(&path, bytes)?;
    assert!(receipt.verify_contents().is_err());
    assert_eq!(std::fs::read(original)?, bytes);
    Ok(())
}

#[cfg(unix)]
#[test]
fn witnessed_append_rejects_same_content_replacement_of_the_source_control() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("witnessed-control.jsonl");
    std::fs::write(&path, b"")?;
    let source = HistorySource::bind(&path)?;
    let mut receipt = source.append_with_live_receipt(b"{\"message\":\"original\"}\n")?;
    let control = path.with_extension("hctl").join("source.json");
    let original_bytes = std::fs::read(&control)?;
    let original = control.with_file_name("source-original.json");
    std::fs::rename(&control, &original)?;
    std::fs::write(&control, &original_bytes)?;
    assert!(receipt.verify_contents().is_err());
    assert_eq!(std::fs::read(original)?, original_bytes);
    Ok(())
}

#[test]
fn witnessed_append_never_returns_receipt_when_authority_outcome_is_uncertain() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("witnessed-cut.jsonl");
    std::fs::write(&path, b"")?;
    let source = HistorySource::bind(&path)?;
    let _cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
    let result = source.append_with_live_receipt(b"{\"message\":\"uncertain\"}\n");
    match result {
        Err(error) => assert!(is_uncertain_mutation(&error)),
        Ok(_) => anyhow::bail!("uncertain authority incorrectly produced a live receipt"),
    }
    assert!(String::from_utf8_lossy(&std::fs::read(&path)?).contains("uncertain"));
    Ok(())
}

#[test]
fn witnessed_append_does_not_recreate_a_missing_original_source() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("missing-original.jsonl");
    let source = HistorySource::bind(&path)?;
    let before: Vec<_> = std::fs::read_dir(temp.path())?.collect::<std::io::Result<_>>()?;
    assert!(source.append_with_live_receipt(b"{}\n").is_err());
    assert!(!path.exists());
    let after: Vec<_> = std::fs::read_dir(temp.path())?.collect::<std::io::Result<_>>()?;
    assert_eq!(before.len(), after.len());
    Ok(())
}

#[test]
fn witnessed_append_preserves_existing_control_if_its_body_is_missing() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("missing-existing.jsonl");
    let source = HistorySource::bind(&path)?;
    source.append(b"{\"message\":\"original\"}\n")?;
    let control = path.with_extension("hctl").join("source.json");
    let original_control = std::fs::read(&control)?;
    std::fs::remove_file(&path)?;
    assert!(
        source
            .append_with_live_receipt(b"{\"message\":\"new\"}\n")
            .is_err()
    );
    assert!(!path.exists());
    assert_eq!(std::fs::read(control)?, original_control);
    Ok(())
}
