use super::*;

#[test]
fn every_released_schema_upgrades_and_preserves_library_data() {
    for version in 0..=SCHEMA_VERSION {
        let mut db = Connection::open_in_memory().unwrap();
        for sql in STEPS.iter().take(version as usize) {
            db.execute_batch(sql).unwrap();
        }
        db.pragma_update(None, "user_version", version).unwrap();
        if version > 0 {
            db.execute("INSERT INTO libraries(id,principal,target,name,purpose,request_key) VALUES('kept','owner','target','name','purpose','request')", []).unwrap();
        }
        upgrade(&mut db).unwrap();
        let actual: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(actual, SCHEMA_VERSION);
        if version > 0 {
            let name: String = db
                .query_row("SELECT name FROM libraries WHERE id='kept'", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(name, "name");
        }
        let schema: String = db
            .query_row(
                "SELECT group_concat(sql) FROM (SELECT sql FROM sqlite_schema ORDER BY name)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        upgrade(&mut db).unwrap();
        let reopened: String = db
            .query_row(
                "SELECT group_concat(sql) FROM (SELECT sql FROM sqlite_schema ORDER BY name)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reopened, schema);
    }
}

#[test]
fn failed_upgrade_rolls_back_all_steps_and_can_be_retried() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(STEPS[0]).unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
    // Fail after v2 has created its virtual table, exercising multi-step rollback.
    db.execute_batch("CREATE TABLE knowledge_sources(block_upgrade INTEGER)")
        .unwrap();
    assert!(upgrade(&mut db).is_err());
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    let fts_count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='knowledge_fts'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(fts_count, 0);
    db.execute_batch("DROP TABLE knowledge_sources").unwrap();
    upgrade(&mut db).unwrap();
}

#[test]
fn future_version_is_not_changed() {
    let mut db = Connection::open_in_memory().unwrap();
    db.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    assert!(upgrade(&mut db).is_err());
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION + 1);
}
