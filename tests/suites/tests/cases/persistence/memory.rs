use kcoder_memory::{MemorySessionInput, StructuredMemoryStore};

#[test]
fn structured_memory_session_survives_sqlite_reopen() {
    let temporary = tempfile::tempdir().expect("temporary directory should be created");
    let database = temporary.path().join("memory").join("memory.sqlite3");

    {
        let store = StructuredMemoryStore::open(&database).expect("memory store should open");
        store
            .upsert_session(&MemorySessionInput {
                session_id: "session-contract".to_string(),
                project_key: "project-contract".to_string(),
                cwd: temporary.path().display().to_string(),
                started_at_epoch: 123,
            })
            .expect("session should persist");
        assert!(
            store
                .finish_session("session-contract", 456, "completed")
                .expect("session should finish")
        );
    }

    let reopened = StructuredMemoryStore::open(&database).expect("memory store should reopen");
    let session = reopened
        .get_session("session-contract")
        .expect("session lookup should succeed")
        .expect("session should exist after reopen");
    assert_eq!(session.project_key, "project-contract");
    assert_eq!(session.started_at_epoch, 123);
    assert_eq!(session.ended_at_epoch, Some(456));
    assert_eq!(session.status, "completed");
}
