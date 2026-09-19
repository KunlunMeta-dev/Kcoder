use std::path::Path;
use std::sync::Arc;

use kcoder_api::Provider;
use kcoder_config::Settings;
use kcoder_memory::MemoryManager;

use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use crate::test_support::providers::{EmptyProvider, TextDraftProvider};

#[test]
fn provider_error_summary_observer_parse_omits_invalid_values() {
    let error =
        parse_memory_observer_model_draft(r#"{"observation_candidates":"SENTINEL_PRIVATE"}"#)
            .unwrap_err();
    assert!(!error.contains("SENTINEL_PRIVATE"));
    assert!(error.len() <= 512);
}

#[test]
fn provider_error_summary_observer_validation_omits_invalid_values() {
    let tmp = tempfile::tempdir().unwrap();
    let memory = MemoryManager::global_only(MemoryStore::empty());
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        Settings::default(),
        memory,
    );
    engine.record_memory_observer_validation_failure(&[MemoryObserverDraftValidationIssue {
        path: "source_event_ids[0]".into(),
        message: "SENTINEL_PRIVATE".repeat(1000),
    }]);
    let diagnostics = engine.memory_observer_last_validation_failure().unwrap();
    assert!(
        !diagnostics
            .first_issue_message
            .unwrap()
            .contains("SENTINEL_PRIVATE")
    );
}

#[path = "internal_provider_failure_fixture.rs"]
mod internal_failure_fixture;

#[tokio::test]
async fn internal_provider_failure_observer_records_safe_facts_with_fallback() {
    for boundary in 0..3 {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(internal_failure_fixture::FailureProvider::new(boundary));
        let memory = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
            kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
            "project-a",
        );
        let settings = Settings {
            memory: kcoder_config::MemorySettings {
                observer_mode: kcoder_config::MemoryObserverMode::Model,
                ..kcoder_config::MemorySettings::default()
            },
            ..Settings::default()
        };
        let engine =
            test_engine_with_memory_manager(provider.clone(), tmp.path(), settings, memory);
        engine.record_file_change_observation("tool-write", "write", &["notes.txt".into()], false);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if !engine
                    .memory_manager
                    .search_structured_observations(Some("notes.txt"), 10)
                    .unwrap()
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let raw = fs::read_to_string(engine.memory_observer_event_log_path()).unwrap();
        let entries: Vec<Value> = raw
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let fallbacks: Vec<_> = entries
            .iter()
            .filter(|entry| entry["event_type"] == "model_fallback")
            .collect();
        assert_eq!(fallbacks.len(), 1);
        let details = &fallbacks[0]["details"];
        assert_eq!(details["purpose"], "memory_observer");
        assert_eq!(
            details["phase"],
            if boundary == 0 { "start" } else { "stream" }
        );
        assert_eq!(details["outcome"], "deterministic_fallback");
        let failure = &details["failure"];
        assert_eq!(
            failure["category"],
            if boundary < 2 {
                "provider_error"
            } else {
                "model_protocol_error"
            }
        );
        assert_eq!(
            failure["http_status"],
            if boundary < 2 {
                serde_json::json!(503)
            } else {
                Value::Null
            }
        );
        assert_eq!(failure.as_object().unwrap().len(), 6);
        assert_eq!(failure["retryable"], boundary < 2);
        assert_eq!(failure["resume_safe"], false);
        assert_eq!(
            failure["retry_after_ms"],
            if boundary < 2 {
                serde_json::json!(37)
            } else {
                Value::Null
            }
        );
        assert!(!failure.to_string().contains("private-provider-code"));
        assert!(
            engine
                .memory_manager
                .search_structured_observations(Some("notes.txt"), 10)
                .unwrap()[0]
                .generated_by_model
                .is_none()
        );
    }
}

fn test_engine_with_settings(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .build()
}

fn test_engine_with_memory_manager(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
    memory_manager: MemoryManager,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .memory_manager(memory_manager)
        .build()
}

#[test]
fn observer_disabled_mode_skips_automatic_observer_memories() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            observer_mode: kcoder_config::MemoryObserverMode::Disabled,
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings,
        memory_manager,
    );

    engine.record_file_change_observation("tool-write", "write", &["notes.txt".to_string()], false);
    engine.record_verification_observation(
        "tool-test",
        "bash",
        &serde_json::json!({"command": "cargo test"}),
        false,
    );
    engine.record_failure_recovery_observation(
        "tool-recovered",
        "bash",
        &serde_json::json!({}),
        Some(&ToolFailureRecord {
            count: 1,
            input_preview: "same input".to_string(),
        }),
    );

    let observations = engine
        .memory_manager
        .search_structured_observations(None, 10)
        .unwrap();
    assert!(observations.is_empty());
}

#[test]
fn training_mode_forces_the_model_memory_observer_off() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        training_mode: true,
        memory: kcoder_config::MemorySettings {
            observer_mode: kcoder_config::MemoryObserverMode::Model,
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);

    assert_eq!(
        engine.memory_observer_mode(),
        kcoder_config::MemoryObserverMode::Disabled
    );
}

#[test]
fn model_memory_observer_mode_queues_and_drains_deterministic_fallback() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            observer_mode: kcoder_config::MemoryObserverMode::Model,
            observer_queue_size: 2,
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings,
        memory_manager,
    );

    engine.record_file_change_observation("tool-write", "write", &["notes.txt".to_string()], false);

    let observations = engine
        .memory_manager
        .search_structured_observations(Some("notes.txt"), 10)
        .unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].observation_type, "file_change");

    let stats = engine.memory_observer_queue_stats();
    assert_eq!(stats.capacity, 2);
    assert_eq!(stats.submitted, 1);
    assert_eq!(stats.enqueued, 1);
    assert_eq!(stats.drained, 1);
    assert_eq!(stats.queued, 0);
    assert_eq!(stats.inline_fallbacks, 0);
}

#[tokio::test]
async fn model_memory_observer_worker_writes_provider_draft() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(TextDraftProvider {
        text: r#"```json
{
  "observation_candidates": [
{
  "source_event_ids": ["tool-write"],
  "observation_type": "file_change",
  "title": "Model file update",
  "subtitle": null,
  "narrative": "The model observer selected the edited notes file.",
  "facts": ["notes.txt was updated"],
  "concepts": ["notes"],
  "files_read": [],
  "files_modified": ["notes.txt"],
  "confidence": 0.91
}
  ],
  "summary_candidates": [],
  "skip_reasons": [],
  "audit": {
"model": null,
"generated_at_epoch": null,
"privacy_notes": []
  }
}
```"#
            .to_string(),
        requests: Arc::clone(&requests),
        delay: None,
    });
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            observer_mode: kcoder_config::MemoryObserverMode::Model,
            observer_queue_size: 2,
            observer_model: Some("observer-test".to_string()),
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(provider, tmp.path(), settings, memory_manager);

    engine.record_file_change_observation("tool-write", "write", &["notes.txt".to_string()], false);

    let mut observations = Vec::new();
    for _ in 0..50 {
        observations = engine
            .memory_manager
            .search_structured_observations(Some("notes.txt"), 10)
            .unwrap();
        if !observations.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].title.as_deref(), Some("Model file update"));
    assert_eq!(
        observations[0].generated_by_model.as_deref(),
        Some("observer-test")
    );
    let stats = engine.memory_observer_queue_stats();
    assert_eq!(stats.submitted, 1);
    assert_eq!(stats.enqueued, 1);
    assert_eq!(stats.drained, 1);
    assert_eq!(stats.queued, 0);
    assert!(engine.memory_observer_last_validation_failure().is_none());
    let worker_diagnostics = engine.memory_observer_worker_diagnostics();
    assert_eq!(worker_diagnostics.model_successes, 1);
    assert_eq!(worker_diagnostics.model_fallbacks, 0);
    assert_eq!(worker_diagnostics.model_parse_failures, 0);
    assert_eq!(worker_diagnostics.model_validation_failures, 0);

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].model, "observer-test");
    assert!(requests[0].tools.is_empty());
    let response_schema = requests[0]
        .response_json_schema
        .as_ref()
        .expect("observer request should include a response JSON schema");
    assert_eq!(response_schema.name, "memory_observer_draft");
    assert!(
        requests[0]
            .system
            .as_deref()
            .unwrap_or_default()
            .contains("Schema:")
    );
}

#[tokio::test]
async fn model_memory_observer_worker_falls_back_on_invalid_json() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(TextDraftProvider {
        text: "not json".to_string(),
        requests: Arc::clone(&requests),
        delay: None,
    });
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            observer_mode: kcoder_config::MemoryObserverMode::Model,
            observer_queue_size: 2,
            observer_model: Some("observer-test".to_string()),
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(provider, tmp.path(), settings, memory_manager);

    engine.record_file_change_observation("tool-write", "write", &["notes.txt".to_string()], false);

    let mut observations = Vec::new();
    for _ in 0..50 {
        observations = engine
            .memory_manager
            .search_structured_observations(Some("notes.txt"), 10)
            .unwrap();
        if !observations.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    assert_eq!(observations.len(), 1);
    assert_eq!(
        observations[0].title.as_deref(),
        Some("Tool `write` modified 1 file(s)")
    );
    assert!(observations[0].generated_by_model.is_none());
    assert!(engine.memory_observer_last_validation_failure().is_none());
    let worker_diagnostics = engine.memory_observer_worker_diagnostics();
    assert_eq!(worker_diagnostics.model_successes, 0);
    assert_eq!(worker_diagnostics.model_fallbacks, 1);
    assert_eq!(worker_diagnostics.model_parse_failures, 1);
    assert_eq!(worker_diagnostics.model_validation_failures, 0);
    assert!(
        worker_diagnostics
            .last_fallback_reason
            .as_deref()
            .unwrap_or_default()
            .contains("did not contain a JSON object")
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
    let event_log = engine.memory_observer_event_log_diagnostics();
    assert_eq!(event_log.event_count, 4);
    assert_eq!(
        event_log.last_event_type.as_deref(),
        Some("deterministic_success")
    );
    let raw_event_log = fs::read_to_string(engine.memory_observer_event_log_path()).unwrap();
    let fallback: Value = raw_event_log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|entry| entry["event_type"] == "model_fallback")
        .unwrap();
    assert_eq!(fallback["details"]["phase"], "parse");
    assert_eq!(fallback["details"]["outcome"], "deterministic_fallback");
    assert!(fallback["details"]["failure"].is_null());
    let event_types = raw_event_log
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line).unwrap()["event_type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        event_types,
        vec![
            "enqueue",
            "dequeue",
            "model_fallback",
            "deterministic_success"
        ]
    );
    let recovery = engine.memory_observer_recovery_audit();
    assert_eq!(recovery.event_count, 4);
    assert_eq!(recovery.malformed_event_count, 0);
    assert_eq!(recovery.pending_enqueued, 0);
    assert_eq!(recovery.pending_dequeued, 0);
    assert_eq!(recovery.orphan_dequeue_count, 0);
    assert_eq!(recovery.orphan_terminal_count, 0);
}

#[test]
fn memory_observer_recovery_audit_reports_pending_event_log_sequences() {
    let tmp = tempfile::tempdir().unwrap();
    let engine =
        test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), Settings::default());
    let path = engine.memory_observer_event_log_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        [
            r#"{"event_type":"enqueue","occurred_at_epoch":1}"#,
            r#"{"event_type":"dequeue","occurred_at_epoch":2}"#,
            r#"{"event_type":"enqueue","occurred_at_epoch":3}"#,
            "not json",
            r#"{"occurred_at_epoch":4}"#,
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();

    let audit = engine.memory_observer_recovery_audit();

    assert_eq!(audit.path, path);
    assert_eq!(audit.event_count, 3);
    assert_eq!(audit.malformed_event_count, 2);
    assert_eq!(audit.pending_enqueued, 1);
    assert_eq!(audit.pending_dequeued, 1);
    assert_eq!(audit.orphan_dequeue_count, 0);
    assert_eq!(audit.orphan_terminal_count, 0);
    assert_eq!(audit.dropped_queued_before_dequeue, 0);
    assert_eq!(audit.last_incomplete_event_type.as_deref(), Some("enqueue"));
    assert_eq!(audit.last_incomplete_at_epoch, Some(3));
}

#[tokio::test]
async fn model_memory_observer_worker_drains_bundles_queued_while_running() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(TextDraftProvider {
        text: "not json".to_string(),
        requests: Arc::clone(&requests),
        delay: Some(Duration::from_millis(50)),
    });
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            observer_mode: kcoder_config::MemoryObserverMode::Model,
            observer_queue_size: 4,
            observer_model: Some("observer-test".to_string()),
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(provider, tmp.path(), settings, memory_manager);

    engine.record_file_change_observation("tool-write-1", "write", &["one.txt".to_string()], false);
    for _ in 0..50 {
        if requests.lock().unwrap().len() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(requests.lock().unwrap().len(), 1);

    engine.record_file_change_observation("tool-write-2", "write", &["two.txt".to_string()], false);

    for _ in 0..80 {
        let diagnostics = engine.memory_observer_worker_diagnostics();
        if diagnostics.model_parse_failures == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let diagnostics = engine.memory_observer_worker_diagnostics();
    assert_eq!(diagnostics.model_successes, 0);
    assert_eq!(diagnostics.model_fallbacks, 2);
    assert_eq!(diagnostics.model_parse_failures, 2);
    let stats = engine.memory_observer_queue_stats();
    assert_eq!(stats.submitted, 2);
    assert_eq!(stats.enqueued, 2);
    assert_eq!(stats.drained, 2);
    assert_eq!(stats.queued, 0);
    assert_eq!(requests.lock().unwrap().len(), 2);
    let observations = engine
        .memory_manager
        .search_structured_observations(None, 10)
        .unwrap();
    assert_eq!(observations.len(), 2);
}

#[tokio::test]
async fn model_memory_observer_worker_records_validation_failure_and_falls_back() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(TextDraftProvider {
        text: r#"{
  "observation_candidates": [
{
  "source_event_ids": ["missing-event"],
  "observation_type": "file_change",
  "title": "Invalid model file update",
  "subtitle": null,
  "narrative": "This candidate points at a missing event.",
  "facts": ["invalid source event"],
  "concepts": ["notes"],
  "files_read": [],
  "files_modified": ["notes.txt"],
  "confidence": 0.91
}
  ],
  "summary_candidates": [],
  "skip_reasons": [],
  "audit": {
"model": null,
"generated_at_epoch": null,
"privacy_notes": []
  }
}"#
        .to_string(),
        requests: Arc::clone(&requests),
        delay: None,
    });
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            observer_mode: kcoder_config::MemoryObserverMode::Model,
            observer_queue_size: 2,
            observer_model: Some("observer-test".to_string()),
            ..kcoder_config::MemorySettings::default()
        },
        ..Settings::default()
    };
    let engine = test_engine_with_memory_manager(provider, tmp.path(), settings, memory_manager);

    engine.record_file_change_observation("tool-write", "write", &["notes.txt".to_string()], false);

    let mut observations = Vec::new();
    for _ in 0..50 {
        observations = engine
            .memory_manager
            .search_structured_observations(Some("notes.txt"), 10)
            .unwrap();
        if !observations.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    assert_eq!(observations.len(), 1);
    assert_eq!(
        observations[0].title.as_deref(),
        Some("Tool `write` modified 1 file(s)")
    );
    assert!(observations[0].generated_by_model.is_none());
    let diagnostics = engine
        .memory_observer_last_validation_failure()
        .expect("validation failure should be recorded");
    assert_eq!(diagnostics.issue_count, 1);
    assert_eq!(
        diagnostics.first_issue_path.as_deref(),
        Some("observation_candidates[0].source_event_ids[0]")
    );
    let worker_diagnostics = engine.memory_observer_worker_diagnostics();
    assert_eq!(worker_diagnostics.model_successes, 0);
    assert_eq!(worker_diagnostics.model_fallbacks, 1);
    assert_eq!(worker_diagnostics.model_parse_failures, 0);
    assert_eq!(worker_diagnostics.model_validation_failures, 1);
    assert!(
        worker_diagnostics
            .last_fallback_reason
            .as_deref()
            .unwrap_or_default()
            .contains("validation failed")
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
    let raw = fs::read_to_string(engine.memory_observer_event_log_path()).unwrap();
    let fallback: Value = raw
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|entry| entry["event_type"] == "model_fallback")
        .unwrap();
    assert_eq!(fallback["details"]["phase"], "validation");
    assert_eq!(fallback["details"]["outcome"], "deterministic_fallback");
    assert!(fallback["details"]["failure"].is_null());
}

#[test]
fn observer_validation_failure_diagnostics_are_recorded() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        Settings::default(),
        memory_manager,
    );

    assert!(engine.memory_observer_last_validation_failure().is_none());

    engine.record_memory_observer_validation_failure(&[
        MemoryObserverDraftValidationIssue {
            path: "observation_candidates[0].title".to_string(),
            message: "field must not be empty".to_string(),
        },
        MemoryObserverDraftValidationIssue {
            path: "summary_candidates[0].summary_text".to_string(),
            message: "field must not be empty".to_string(),
        },
    ]);

    let diagnostics = engine
        .memory_observer_last_validation_failure()
        .expect("validation failure diagnostics should be recorded");
    assert_eq!(diagnostics.issue_count, 2);
    assert_eq!(
        diagnostics.first_issue_path.as_deref(),
        Some("observation_candidates[0].title")
    );
    assert_eq!(
        diagnostics.first_issue_message.as_deref(),
        Some("observer draft validation failed; response details withheld")
    );
    assert!(diagnostics.occurred_at_epoch > 0);
}

// Moved from `memory_observer/model_codec.rs`: production modules must keep
// tests external (source_layout governance). Items are `pub(super)` on
// `model_codec`, reachable from this sibling fragment.
mod model_codec_tests {
    use super::super::model_codec::*;
    use std::sync::Arc;

    fn retained_source(
        error: &MemoryObserverModelDraftError,
    ) -> Option<&Arc<kcoder_api::ApiErrorKind>> {
        error.source.as_ref()
    }

    #[test]
    fn observer_provider_source_retains_metadata_and_shares_safe_clone() {
        let error = MemoryObserverModelDraftError::provider(
            kcoder_api::ApiErrorKind::Http {
                error_type: "sentinel-private-type".into(),
                message: "sentinel-private-body".into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status: 503,
                    provider_code: Some("sentinel-private-code".into()),
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: Some(std::time::Duration::from_millis(37)),
                },
            },
            MemoryObserverFailurePhase::Start,
        );
        let source = retained_source(&error).expect("observer provider source must be retained");
        let kcoder_api::ApiErrorKind::Http { metadata, .. } = source.as_ref() else {
            panic!("HTTP source changed")
        };
        assert_eq!(metadata.status, 503);
        assert_eq!(
            metadata.provider_code.as_deref(),
            Some("sentinel-private-code")
        );
        assert_eq!(
            metadata.retry_after,
            Some(std::time::Duration::from_millis(37))
        );
        let cloned = error.clone();
        assert!(Arc::ptr_eq(source, retained_source(&cloned).unwrap()));
        assert!(
            std::error::Error::source(&cloned)
                .unwrap()
                .downcast_ref::<kcoder_api::ApiErrorKind>()
                .is_some()
        );
        assert!(!format!("{cloned:?}").contains("sentinel-private"));
        assert!(retained_source(&MemoryObserverModelDraftError::parse("bad draft")).is_none());
        assert!(
            !serde_json::to_string(&error.failure)
                .unwrap()
                .contains("sentinel-private")
        );
    }
}
