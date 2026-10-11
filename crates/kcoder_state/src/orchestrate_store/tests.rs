use super::*;

fn plan(title: &str) -> String {
    format!(
        "# {title}\n\n## Context\n目标。\n\n## TODOs\n- [ ] 1. 实现一个动作\n  - artifacts: src/lib.rs\n  - write_scope: src/\n  - acceptance: focused test passes\n  - verify: cargo test\n\n## Final Verification Wave\n- [ ] F1. 工作区测试通过\n  - evidence: manual\n"
    )
}

#[cfg(windows)]
#[test]
fn windows_plan_store_pins_root_and_supports_revision_roundtrip() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("windows", &plan("Windows"), "session", true)
        .unwrap();
    assert_eq!(
        store.active_work_id().unwrap(),
        Some(created.work.work_id.clone())
    );
    assert!(fs::rename(store.root(), temp.path().join("replaced")).is_err());
    assert_eq!(
        store.read_work(&created.work.work_id).unwrap().plan,
        created.plan
    );
    drop(store);
    fs::rename(
        temp.path().join(".kcoder/orchestrate"),
        temp.path().join("replaced"),
    )
    .unwrap();
}

#[cfg(windows)]
#[test]
fn windows_plan_store_rejects_junction_directory() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join(".kcoder")).unwrap();
    let link = temp.path().join(".kcoder").join("orchestrate");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(outside.path())
        .status()
        .unwrap();
    assert!(status.success());
    let store = PlanStore::for_workspace(temp.path());
    assert!(store.active_work_id().is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    fs::remove_dir(link).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_atomic_publish_retains_target_on_post_publish_failure() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("current.json");
    let _failure = PlanStoreFailpointGuard::set("after_windows_publish");
    assert!(windows_io::write_atomic(&path, b"new").is_err());
    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn windows_write_rejects_existing_hardlinks() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("events.jsonl");
    let outside = temp.path().join("outside.txt");
    fs::write(&outside, b"unchanged").unwrap();
    fs::hard_link(&outside, &file).unwrap();
    assert!(open_append_no_follow(&file).is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"unchanged");
}

#[cfg(windows)]
#[test]
fn windows_atomic_replace_coexists_with_read_handle() {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_GENERIC_READ, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("current.json");
    windows_io::write_atomic(&path, b"old").unwrap();
    let mut reader = windows_io::open_file(
        &path,
        FILE_GENERIC_READ,
        windows_io::FILE_OPEN,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    )
    .unwrap();
    windows_io::write_atomic(&path, b"new").unwrap();
    let mut old = String::new();
    reader.read_to_string(&mut old).unwrap();
    assert_eq!(old, "old");
    assert_eq!(read_bytes_no_follow(&path).unwrap(), b"new");
}

#[cfg(target_os = "macos")]
#[test]
fn macos_plan_store_can_traverse_opened_root_handle() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());

    assert_eq!(store.active_work_id().unwrap(), None);
    assert!(store.root().join("works").is_dir());
    assert!(store.root().join("store.lock").is_file());
}

#[test]
fn parser_requires_strict_sections_metadata_and_contiguous_numbers() {
    let parsed = parse_plan(&plan("严格计划")).unwrap();
    assert_eq!(parsed.tasks.len(), 2);
    assert_eq!(parsed.tasks[0].key, "1");
    assert_eq!(parsed.tasks[1].key, "F1");
    assert!(parse_plan(&plan("坏计划").replace("1. 实现", "2. 实现")).is_err());
    assert!(parse_plan(&plan("坏计划").replace("  - verify: cargo test\n", "")).is_err());
    assert!(parse_plan(&plan("坏计划").replace("  - evidence: manual\n", "")).is_err());
}

#[test]
fn same_slug_creates_distinct_uuid_v4_work_ids_and_explicit_active_pointer() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let first = store
        .create_work("same", &plan("一"), "session-a", true)
        .unwrap();
    let second = store
        .create_work("same", &plan("二"), "session-a", false)
        .unwrap();

    assert_ne!(first.work.work_id, second.work.work_id);
    assert_eq!(
        store.active_work_id().unwrap().as_deref(),
        Some(first.work.work_id.as_str())
    );
    store.select_active_work(&second.work.work_id).unwrap();
    assert_eq!(
        store.read_active_work().unwrap().work.work_id,
        second.work.work_id
    );
}

#[test]
fn edit_is_cas_guarded_and_cannot_change_checkbox_state() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("edit", &plan("原计划"), "session-a", true)
        .unwrap();
    let edited = store
        .edit_plan(
            &created.work.work_id,
            1,
            "实现一个动作",
            "实现单一动作",
            false,
        )
        .unwrap();
    assert_eq!(edited.work.revision, 2);
    let error = store
        .edit_plan(&created.work.work_id, 1, "单一", "原子", false)
        .unwrap_err();
    assert!(
        error
            .downcast_ref::<PlanStoreError>()
            .is_some_and(|error| matches!(error, PlanStoreError::RevisionConflict { .. }))
    );
    assert!(
        store
            .edit_plan(&created.work.work_id, 2, "- [ ] 1.", "- [x] 1.", false)
            .is_err()
    );
}

#[test]
fn acceptance_and_reopen_are_the_only_checkbox_mutations() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("accept", &plan("验收"), "session-a", true)
        .unwrap();
    store
        .append_evidence(
            &created.work.work_id,
            AgentEvidence {
                evidence_id: "evidence-1".to_string(),
                work_id: created.work.work_id.clone(),
                revision: 1,
                plan_sha256: created.work.plan_sha256.clone(),
                agent_id: "agent-1".to_string(),
                workspace_digest: "sha256:workspace".to_string(),
                recorded_at: Utc::now(),
                evidence: AgentEvidenceKind::Manual {
                    statement: "manual check".to_string(),
                    recorded_by: "user".to_string(),
                },
            },
        )
        .unwrap();
    let accepted = store
        .record_acceptance(
            &created.work.work_id,
            1,
            AcceptanceRecord {
                task_key: "1".to_string(),
                result_digest: "sha256:result".to_string(),
                evidence_ids: vec!["evidence-1".to_string()],
                works: true,
                conforms: true,
                matches_contract: true,
                honored_boundaries: true,
                accepted_at: Utc::now(),
            },
        )
        .unwrap();
    assert!(accepted.plan.contains("- [x] 1."));
    let reopened = store
        .reopen_task(&created.work.work_id, 2, "1", "regression")
        .unwrap();
    assert!(reopened.plan.contains("- [ ] 1."));
    assert!(reopened.work.acceptances.is_empty());
}

#[test]
fn batch_acceptance_uses_one_revision_for_a_shared_verification_wave() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("batch", &plan("批量验收"), "session-a", true)
        .unwrap();
    for evidence in [
        AgentEvidence {
            evidence_id: "process-current".to_string(),
            work_id: created.work.work_id.clone(),
            revision: 1,
            plan_sha256: created.work.plan_sha256.clone(),
            agent_id: "verifier-a".to_string(),
            workspace_digest: "digest".to_string(),
            recorded_at: Utc::now(),
            evidence: AgentEvidenceKind::ProcessExit {
                tool: "bash".to_string(),
                command: "cargo test".to_string(),
                exit_code: Some(0),
                signal: None,
                cwd: temp.path().to_path_buf(),
                raw_exit_code: true,
            },
        },
        AgentEvidence {
            evidence_id: "manual-current".to_string(),
            work_id: created.work.work_id.clone(),
            revision: 1,
            plan_sha256: created.work.plan_sha256.clone(),
            agent_id: "verifier-a".to_string(),
            workspace_digest: "digest".to_string(),
            recorded_at: Utc::now(),
            evidence: AgentEvidenceKind::Manual {
                statement: "final review complete".to_string(),
                recorded_by: "verifier-a".to_string(),
            },
        },
    ] {
        store
            .append_evidence(&created.work.work_id, evidence)
            .unwrap();
    }

    let completed = store
        .record_acceptances(
            &created.work.work_id,
            1,
            vec![
                acceptance("1", "process-current"),
                acceptance("F1", "manual-current"),
            ],
        )
        .unwrap();

    assert_eq!(completed.work.revision, 2);
    assert_eq!(completed.work.status, WorkStatus::Completed);
    assert_eq!(completed.work.acceptances.len(), 2);
    assert!(completed.plan.contains("- [x] 1."));
    assert!(completed.plan.contains("- [x] F1."));
}

#[test]
fn final_acceptance_requires_declared_evidence_type_and_completes_work() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("typed", &plan("类型"), "session-a", true)
        .unwrap();
    let manual = |revision: u64, sha: &str, id: &str| AgentEvidence {
        evidence_id: id.to_string(),
        work_id: created.work.work_id.clone(),
        revision,
        plan_sha256: sha.to_string(),
        agent_id: "agent-a".to_string(),
        workspace_digest: "digest".to_string(),
        recorded_at: Utc::now(),
        evidence: AgentEvidenceKind::Manual {
            statement: "人工复核".to_string(),
            recorded_by: "user".to_string(),
        },
    };
    store
        .append_evidence(
            &created.work.work_id,
            manual(1, &created.work.plan_sha256, "todo"),
        )
        .unwrap();
    let task = store
        .record_acceptance(&created.work.work_id, 1, acceptance("1", "todo"))
        .unwrap();
    store
        .append_evidence(
            &created.work.work_id,
            manual(2, &task.work.plan_sha256, "final"),
        )
        .unwrap();
    let completed = store
        .record_acceptance(&created.work.work_id, 2, acceptance("F1", "final"))
        .unwrap();
    assert_eq!(completed.work.status, WorkStatus::Completed);
    assert_eq!(
        completed.work.progress.completed,
        completed.work.progress.total
    );
    let reopened = store
        .reopen_task(&created.work.work_id, 3, "F1", "发现新风险")
        .unwrap();
    assert_eq!(reopened.work.status, WorkStatus::Active);
}

fn acceptance(task_key: &str, evidence_id: &str) -> AcceptanceRecord {
    AcceptanceRecord {
        task_key: task_key.to_string(),
        result_digest: "sha256:result".to_string(),
        evidence_ids: vec![evidence_id.to_string()],
        works: true,
        conforms: true,
        matches_contract: true,
        honored_boundaries: true,
        accepted_at: Utc::now(),
    }
}

#[cfg(unix)]
#[test]
fn symlinked_workspace_prefix_is_accepted_without_weakening_store_checks() {
    use std::os::unix::fs::symlink;

    let real_parent = tempfile::tempdir().unwrap();
    let real_workspace = real_parent.path().join("workspace");
    fs::create_dir(&real_workspace).unwrap();
    let alias_parent = tempfile::tempdir().unwrap();
    let alias = alias_parent.path().join("workspace-parent-alias");
    symlink(real_parent.path(), &alias).unwrap();
    let aliased_workspace = alias.join("workspace");

    let store = PlanStore::for_workspace(&aliased_workspace);

    assert_eq!(store.active_work_id().unwrap(), None);
    assert_eq!(
        store.root(),
        real_workspace.join(".kcoder/orchestrate").as_path()
    );
    assert!(real_workspace.join(".kcoder/orchestrate/works").is_dir());
}

#[cfg(unix)]
#[test]
fn symlinked_store_component_fails_closed() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join(".kcoder")).unwrap();
    symlink(outside.path(), temp.path().join(".kcoder/orchestrate")).unwrap();
    let store = PlanStore::for_workspace(temp.path());

    let error = store
        .create_work("unsafe", &plan("不安全"), "session-a", true)
        .unwrap_err();

    assert!(
        error
            .downcast_ref::<PlanStoreError>()
            .is_some_and(|error| matches!(error, PlanStoreError::UnsafePath(_)))
    );
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}

#[cfg(target_os = "linux")]
#[test]
fn replaced_store_parent_is_detected_and_never_writes_to_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("parent-race", &plan("父目录替换"), "session-a", true)
        .unwrap();
    let original = temp.path().join("original-orchestrate");
    fs::rename(store.root(), &original).unwrap();
    fs::create_dir_all(store.root().join("works")).unwrap();

    let error = store
        .append_notepad(&created.work.work_id, "issues", "不得写入替换目录")
        .unwrap_err();

    assert!(
        error
            .downcast_ref::<PlanStoreError>()
            .is_some_and(|error| matches!(error, PlanStoreError::UnsafePath(_)))
    );
    assert_eq!(fs::read_dir(store.root().join("works")).unwrap().count(), 0);
    assert!(!store.root().join("state.json").exists());
}

#[test]
fn current_manifest_digest_mismatch_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("digest", &plan("摘要"), "session-a", true)
        .unwrap();
    let path = store
        .root()
        .join("works")
        .join(&created.work.work_id)
        .join("revisions/1/plan.md");
    fs::write(path, "tampered").unwrap();
    assert!(store.read_work(&created.work.work_id).is_err());
}

#[test]
fn corrupt_index_lists_candidates_but_requires_explicit_selection_to_repair() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let first = store
        .create_work("first", &plan("第一项"), "session-a", true)
        .unwrap();
    let second = store
        .create_work("second", &plan("第二项"), "session-a", false)
        .unwrap();
    fs::write(store.root().join("state.json"), b"{damaged").unwrap();

    assert!(store.active_work_id().is_err());
    let candidates = store.list_works().unwrap();
    assert_eq!(candidates.len(), 2);
    assert!(store.active_work_id().is_err());

    store.select_active_work(&second.work.work_id).unwrap();
    assert_eq!(
        store.active_work_id().unwrap().as_deref(),
        Some(second.work.work_id.as_str())
    );
    assert_ne!(first.work.work_id, second.work.work_id);
}

#[test]
fn notepad_tail_is_utf8_bounded_and_continuation_claim_is_persistent() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("continue", &plan("续跑"), "session-a", true)
        .unwrap();
    store
        .append_notepad(&created.work.work_id, "learnings", "开头-甲乙丙-结尾")
        .unwrap();
    let tail = store
        .read_notepad_tail(&created.work.work_id, "learnings", 10)
        .unwrap();
    assert!(tail.len() <= 10);
    assert!(tail.trim_end().ends_with("结尾"));

    let first = store
        .claim_auto_continuation(&created.work.work_id, 1, 1)
        .unwrap();
    assert!(first.claimed);
    assert_eq!(
        store
            .read_continuation_state(&created.work.work_id)
            .unwrap()
            .auto_turn_count,
        1
    );
    store
        .record_continuation_outcome(&created.work.work_id, false)
        .unwrap();
    let capped = store
        .claim_auto_continuation(&created.work.work_id, first.snapshot.work.revision, 1)
        .unwrap();
    assert!(!capped.claimed);
    assert!(
        store
            .read_continuation_state(&created.work.work_id)
            .unwrap()
            .manual_intervention_required
    );
}

#[test]
fn concurrent_revision_cas_has_one_winner_without_lost_update() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("race", &plan("并发"), "session-a", true)
        .unwrap();
    let work_id = created.work.work_id.clone();
    let first = store.clone();
    let first_id = work_id.clone();
    let second = store.clone();
    let second_id = work_id.clone();
    let a = std::thread::spawn(move || {
        first.edit_plan(&first_id, 1, "实现一个动作", "实现动作 A", false)
    });
    let b = std::thread::spawn(move || {
        second.edit_plan(&second_id, 1, "实现一个动作", "实现动作 B", false)
    });
    let results = [a.join().unwrap(), b.join().unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(store.read_work(&work_id).unwrap().work.revision, 2);
}

#[test]
fn commit_failpoints_never_switch_current_and_orphans_are_recoverable() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("fault", &plan("故障"), "session-a", true)
        .unwrap();
    {
        let _guard = PlanStoreFailpointGuard::set("before_current");
        assert!(
            store
                .edit_plan(
                    &created.work.work_id,
                    1,
                    "实现一个动作",
                    "实现新动作",
                    false
                )
                .is_err()
        );
    }
    assert_eq!(
        store
            .read_work(&created.work.work_id)
            .unwrap()
            .work
            .revision,
        1
    );
    let retried = store
        .edit_plan(
            &created.work.work_id,
            1,
            "实现一个动作",
            "实现新动作",
            false,
        )
        .unwrap();
    assert_eq!(retried.work.revision, 2);

    let orphan_temp = tempfile::tempdir().unwrap();
    let orphan_store = PlanStore::for_workspace(orphan_temp.path());
    {
        let _guard = PlanStoreFailpointGuard::set("before_index");
        assert!(
            orphan_store
                .create_work("orphan", &plan("孤儿"), "session-a", true)
                .is_err()
        );
    }
    assert_eq!(orphan_store.active_work_id().unwrap(), None);
    assert_eq!(
        fs::read_dir(orphan_store.root().join("works"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn concurrent_evidence_appends_are_complete_jsonl_records() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("append", &plan("追加"), "session-a", true)
        .unwrap();
    let mut threads = Vec::new();
    for index in 0..8 {
        let store = store.clone();
        let work = created.work.clone();
        threads.push(std::thread::spawn(move || {
            store.append_evidence(
                &work.work_id,
                AgentEvidence {
                    evidence_id: format!("e-{index}"),
                    work_id: work.work_id.clone(),
                    revision: work.revision,
                    plan_sha256: work.plan_sha256.clone(),
                    agent_id: format!("agent-{index}"),
                    workspace_digest: "digest".to_string(),
                    recorded_at: Utc::now(),
                    evidence: AgentEvidenceKind::Citation {
                        url: format!("https://example.test/{index}"),
                        source_date: None,
                    },
                },
            )
        }));
    }
    for thread in threads {
        thread.join().unwrap().unwrap();
    }
    let result = store.read_evidence(&created.work.work_id).unwrap();
    assert_eq!(result.records.len(), 8);
    assert!(!result.degraded_trailing_record);
}

#[test]
fn task_session_audit_binds_parent_fingerprint_and_plan_revision() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let work = store
        .create_work("sessions", &plan("会话审计"), "parent-a", true)
        .unwrap();
    let record = TaskSessionRecord {
        agent_id: "agent-a".to_string(),
        parent_session_id: "parent-a".to_string(),
        plan_revision: work.work.revision,
        status: "spawned".to_string(),
        profile_fingerprint: "sha256:profile".to_string(),
        recorded_at: Utc::now(),
    };

    store
        .append_task_session(&work.work.work_id, record.clone())
        .unwrap();
    let records = store.read_task_sessions(&work.work.work_id).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].parent_session_id, "parent-a");
    assert_eq!(records[0].profile_fingerprint, "sha256:profile");

    let mut stale = record;
    stale.agent_id = "agent-b".to_string();
    stale.plan_revision += 1;
    assert!(
        store
            .append_task_session(&work.work.work_id, stale)
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn evidence_leaf_symlink_is_rejected_without_touching_outside_target() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("leaf", &plan("叶子"), "session-a", true)
        .unwrap();
    let outside = temp.path().join("outside.jsonl");
    fs::write(&outside, "unchanged").unwrap();
    let evidence_path = store
        .work_dir(&created.work.work_id)
        .unwrap()
        .join("evidence.jsonl");
    symlink(&outside, &evidence_path).unwrap();
    let error = store
        .append_evidence(
            &created.work.work_id,
            AgentEvidence {
                evidence_id: "e".to_string(),
                work_id: created.work.work_id.clone(),
                revision: 1,
                plan_sha256: created.work.plan_sha256,
                agent_id: "agent".to_string(),
                workspace_digest: "digest".to_string(),
                recorded_at: Utc::now(),
                evidence: AgentEvidenceKind::Manual {
                    statement: "x".to_string(),
                    recorded_by: "user".to_string(),
                },
            },
        )
        .unwrap_err();
    assert!(
        error
            .downcast_ref::<PlanStoreError>()
            .is_some_and(|error| { matches!(error, PlanStoreError::UnsafePath(_)) })
    );
    assert_eq!(fs::read_to_string(outside).unwrap(), "unchanged");
}

#[test]
fn evidence_trailing_damage_degrades_but_middle_damage_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("evidence", &plan("证据"), "session-a", true)
        .unwrap();
    let record = AgentEvidence {
        evidence_id: "e-1".to_string(),
        work_id: created.work.work_id.clone(),
        revision: 1,
        plan_sha256: created.work.plan_sha256.clone(),
        agent_id: "agent-a".to_string(),
        workspace_digest: "digest".to_string(),
        recorded_at: Utc::now(),
        evidence: AgentEvidenceKind::Citation {
            url: "https://example.test".to_string(),
            source_date: None,
        },
    };
    store
        .append_evidence(&created.work.work_id, record.clone())
        .unwrap();
    let path = store
        .work_dir(&created.work.work_id)
        .unwrap()
        .join("evidence.jsonl");
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{broken")
        .unwrap();
    let read = store.read_evidence(&created.work.work_id).unwrap();
    assert_eq!(read.records.len(), 1);
    assert!(read.degraded_trailing_record);

    let mut bytes = serde_json::to_vec(&record).unwrap();
    bytes.extend_from_slice(b"\n{broken}\n");
    bytes.extend_from_slice(&serde_json::to_vec(&record).unwrap());
    bytes.push(b'\n');
    fs::write(&path, bytes).unwrap();
    assert!(store.read_evidence(&created.work.work_id).is_err());
}

#[test]
fn continuation_runtime_state_does_not_create_plan_revisions() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("counter", &plan("计数"), "session-a", true)
        .unwrap();
    let claim = store
        .claim_auto_continuation(&created.work.work_id, 1, 8)
        .unwrap();
    assert!(claim.claimed);
    assert!(
        store
            .read_continuation_state(&created.work.work_id)
            .unwrap()
            .in_flight
    );
    assert_eq!(
        store
            .read_work(&created.work.work_id)
            .unwrap()
            .work
            .revision,
        1
    );
    store
        .record_continuation_outcome(&created.work.work_id, true)
        .unwrap();
    let continuation = store
        .read_continuation_state(&created.work.work_id)
        .unwrap();
    assert_eq!(continuation.consecutive_failures, 1);
    assert!(!continuation.in_flight);
    assert!(
        store
            .require_manual_intervention(&created.work.work_id, "consecutive_failures")
            .unwrap()
    );
    assert!(
        !store
            .require_manual_intervention(&created.work.work_id, "consecutive_failures")
            .unwrap()
    );
    store
        .reset_auto_continuation_after_user_input(&created.work.work_id, 1)
        .unwrap();
    assert_eq!(
        store
            .read_continuation_state(&created.work.work_id)
            .unwrap(),
        ContinuationState::default()
    );
}

#[test]
fn critic_reject_and_infrastructure_limits_are_independent() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("review", &plan("评审"), "session-a", true)
        .unwrap();
    let rejected = store
        .record_critic_review(
            &created.work.work_id,
            1,
            &created.work.plan_sha256,
            CriticReviewOutcome::Reject,
            3,
            2,
        )
        .unwrap();
    assert_eq!(rejected.reject_count, 1);
    assert_eq!(rejected.infrastructure_retry_count, 0);
    let unavailable = store
        .record_critic_review(
            &created.work.work_id,
            1,
            &created.work.plan_sha256,
            CriticReviewOutcome::InfrastructureError,
            3,
            1,
        )
        .unwrap();
    assert_eq!(unavailable.reject_count, 1);
    assert!(unavailable.review_unavailable);
    assert!(unavailable.automatic_review_stopped);
}

#[test]
fn critic_reject_limit_persists_explicit_exhausted_state() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("review-limit", &plan("拒绝上限"), "session-a", true)
        .unwrap();

    for expected in 1..=3 {
        let review = store
            .record_critic_review(
                &created.work.work_id,
                1,
                &created.work.plan_sha256,
                CriticReviewOutcome::Reject,
                3,
                2,
            )
            .unwrap();
        assert_eq!(review.reject_count, expected);
        assert_eq!(review.rejected_exhausted, expected == 3);
        assert_eq!(review.automatic_review_stopped, expected == 3);
        assert!(!review.review_unavailable);
    }

    let persisted = store
        .read_critic_review_state(&created.work.work_id)
        .unwrap()
        .unwrap();
    assert!(persisted.rejected_exhausted);
    assert!(persisted.automatic_review_stopped);
    assert!(!persisted.review_unavailable);
}

#[test]
fn human_decision_is_idempotent_and_old_revision_is_stale() {
    let temp = tempfile::tempdir().unwrap();
    let store = PlanStore::for_workspace(temp.path());
    let created = store
        .create_work("decision", &plan("人工决策"), "session-a", true)
        .unwrap();
    let record = HumanDecisionRecord {
        decision_id: "decision-1".to_string(),
        work_id: created.work.work_id.clone(),
        plan_revision: created.work.revision,
        task_id: Some("1".to_string()),
        question_id: "question-1".to_string(),
        option_id: Some("approve".to_string()),
        answer_summary: "approved".to_string(),
        actor: DecisionActor::User,
        recorded_at: Utc::now(),
        supersedes: None,
        stale: false,
    };
    let saved = store
        .append_human_decision(&created.work.work_id, record.clone())
        .unwrap();
    let duplicate = store
        .append_human_decision(&created.work.work_id, record)
        .unwrap();
    assert_eq!(saved.decision_id, duplicate.decision_id);
    assert_eq!(
        store
            .read_human_decisions(&created.work.work_id)
            .unwrap()
            .len(),
        1
    );

    store
        .edit_plan(
            &created.work.work_id,
            created.work.revision,
            "人工决策",
            "人工决策更新",
            false,
        )
        .unwrap();
    let stale = store
        .append_human_decision(
            &created.work.work_id,
            HumanDecisionRecord {
                decision_id: "decision-stale".to_string(),
                plan_revision: created.work.revision,
                question_id: "question-stale".to_string(),
                ..saved
            },
        )
        .unwrap();
    assert!(stale.stale);
}

#[test]
fn human_decision_rejects_non_user_actor_is_guaranteed_by_closed_enum() {
    assert!(
        serde_json::from_value::<HumanDecisionRecord>(serde_json::json!({
            "decision_id": "forged",
            "work_id": "work",
            "plan_revision": 1,
            "question_id": "question",
            "answer_summary": "answer",
            "actor": "model",
            "recorded_at": Utc::now(),
            "stale": false
        }))
        .is_err()
    );
}
