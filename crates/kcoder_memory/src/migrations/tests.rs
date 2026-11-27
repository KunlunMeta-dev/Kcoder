use super::*;

#[test]
fn unversioned_database_preserves_rows_and_adds_visibility_columns() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(&BASELINE.replace("    hidden_at_epoch INTEGER,\n", ""))
        .unwrap();
    db.execute("INSERT INTO memory_sessions(session_id,project_key,cwd,started_at_epoch) VALUES('kept','project','/fixture',1)", []).unwrap();
    upgrade(&db).unwrap();
    assert_eq!(validate_version(&db).unwrap(), 1);
    for table in ["memory_observations", "memory_summaries"] {
        db.prepare(&format!("SELECT hidden_at_epoch FROM {table}"))
            .unwrap();
    }
    upgrade(&db).unwrap();
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM memory_sessions WHERE session_id='kept'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn failed_migration_rolls_back_schema_and_version() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE memory_sources(unrecognized INTEGER)")
        .unwrap();
    assert!(upgrade(&db).is_err());
    assert_eq!(validate_version(&db).unwrap(), 0);
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='memory_sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    db.execute_batch("DROP TABLE memory_sources").unwrap();
    upgrade(&db).unwrap();
}

#[test]
fn unsupported_future_version_is_preserved() {
    let db = Connection::open_in_memory().unwrap();
    db.pragma_update(None, "user_version", 2).unwrap();
    assert!(upgrade(&db).is_err());
    assert_eq!(
        db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
}
