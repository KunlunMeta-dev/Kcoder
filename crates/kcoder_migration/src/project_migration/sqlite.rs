//! Bounded projection of actual project tables. Other source data never enters the snapshot.
use super::*;
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use rusqlite::{
    Connection, OpenFlags,
    config::DbConfig,
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
};
use std::{collections::BTreeSet, ffi::OsStr};
mod vfs;

fn text(value: String, max: usize) -> Result<String> {
    ensure!(
        !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control),
        "migration_project_source_invalid_record"
    );
    Ok(value)
}
fn columns(connection: &Connection, name: &str, expected: &[(&str, &str)]) -> Result<()> {
    let sql: String = connection.query_row(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",
        [name],
        |row| row.get(0),
    )?;
    ensure!(
        sql.trim_start()
            .to_ascii_uppercase()
            .starts_with("CREATE TABLE"),
        "migration_project_source_schema_unsupported"
    );
    let statement = match name {
        "projects" => "PRAGMA main.table_xinfo('projects')",
        "project_roots" => "PRAGMA main.table_xinfo('project_roots')",
        _ => anyhow::bail!("migration_project_source_schema_unsupported"),
    };
    let mut query = connection.prepare(statement)?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (name, kind) in expected {
        ensure!(
            rows.iter()
                .any(|(column, column_type, hidden)| column == name
                    && column_type.eq_ignore_ascii_case(kind)
                    && *hidden == 0),
            "migration_project_source_schema_unsupported"
        );
    }
    Ok(())
}
fn authorize(context: AuthContext<'_>) -> Authorization {
    if context.accessor.is_some() || context.database_name.is_some_and(|name| name != "main") {
        return Authorization::Deny;
    }
    let permitted = match context.action {
        AuthAction::Select => true,
        AuthAction::Read {
            table_name: "sqlite_master" | "sqlite_schema",
            column_name: "sql" | "name" | "type",
        } => true,
        AuthAction::Read {
            table_name: "projects",
            column_name: "id" | "name" | "position" | "created_at_ms" | "updated_at_ms",
        } => true,
        AuthAction::Read {
            table_name: "project_roots",
            column_name: "project_id" | "path" | "position",
        } => true,
        AuthAction::Pragma {
            pragma_name,
            pragma_value: Some("projects" | "project_roots"),
        } => pragma_name.eq_ignore_ascii_case("table_xinfo"),
        _ => false,
    };
    if permitted {
        Authorization::Allow
    } else {
        Authorization::Deny
    }
}
fn configure(connection: &Connection, context: Arc<vfs::Context>) -> Result<()> {
    connection.busy_timeout(Duration::ZERO)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, 64 * 1024);
    connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 64 * 1024);
    connection.set_limit(Limit::SQLITE_LIMIT_COLUMN, 64);
    connection.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
    connection.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 64);
    connection.set_limit(Limit::SQLITE_LIMIT_COMPOUND_SELECT, 4);
    connection.execute_batch(
        "PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048;",
    )?;
    // Only fixed project SELECTs and their schema checks are accepted. Extensions remain
    // disabled, and neither arbitrary source SQL nor other table contents are executed.
    connection.authorizer(Some(authorize));
    connection.progress_handler(100, Some(move || context.check(0).is_err()));
    Ok(())
}
fn project_rows(
    connection: &Connection,
    limits: ProjectReadLimits,
    selected: Option<&str>,
) -> Result<Vec<ProjectRecord>> {
    columns(
        connection,
        "projects",
        &[
            ("id", "TEXT"),
            ("name", "TEXT"),
            ("position", "INTEGER"),
            ("created_at_ms", "INTEGER"),
            ("updated_at_ms", "INTEGER"),
        ],
    )?;
    columns(
        connection,
        "project_roots",
        &[
            ("project_id", "TEXT"),
            ("position", "INTEGER"),
            ("path", "TEXT"),
        ],
    )?;
    let mut statement = connection.prepare(if selected.is_some() {
        "SELECT id,name,position,created_at_ms,updated_at_ms FROM projects WHERE id=? ORDER BY position,id LIMIT ?"
    } else { "SELECT id,name,position,created_at_ms,updated_at_ms FROM projects ORDER BY position,id LIMIT ?" })?;
    let mut rows = match selected {
        Some(id) => statement.query(rusqlite::params![id, 2])?,
        None => statement.query(rusqlite::params![limits.projects + 1])?,
    };
    let mut projects = Vec::new();
    let mut size = 0usize;
    let mut ids = BTreeSet::new();
    let mut root_query = connection
        .prepare("SELECT path FROM project_roots WHERE project_id=? ORDER BY position LIMIT ?")?;
    while let Some(row) = rows.next()? {
        ensure!(
            projects.len() < limits.projects,
            "migration_project_source_budget_exceeded"
        );
        let id = text(row.get(0)?, 256)?;
        let name: String = row.get(1)?;
        ensure!(
            name.len() <= 4096 && !name.chars().any(char::is_control),
            "migration_project_source_invalid_record"
        );
        ensure!(
            ids.insert(id.clone()),
            "migration_project_source_invalid_record"
        );
        let position = row.get(2)?;
        let created: Option<i64> = row.get(3)?;
        let updated: Option<i64> = row.get(4)?;
        let roots = root_query
            .query_map(rusqlite::params![id, limits.roots_per_project + 1], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            roots.len() <= limits.roots_per_project,
            "migration_project_source_invalid_roots"
        );
        let roots = roots
            .into_iter()
            .map(|root| text(root, 4096))
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            roots.iter().collect::<BTreeSet<_>>().len() == roots.len(),
            "migration_project_source_invalid_roots"
        );
        let record = ProjectRecord {
            id,
            name,
            roots,
            position,
            created_at_ms: created
                .map(u64::try_from)
                .transpose()
                .map_err(|_| anyhow::anyhow!("migration_project_source_invalid_record"))?,
            updated_at_ms: updated
                .map(u64::try_from)
                .transpose()
                .map_err(|_| anyhow::anyhow!("migration_project_source_invalid_record"))?,
        };
        size = size
            .checked_add(serde_json::to_vec(&record)?.len())
            .ok_or_else(|| anyhow::anyhow!("migration_project_source_budget_exceeded"))?;
        ensure!(
            size <= limits.metadata_bytes,
            "migration_project_source_budget_exceeded"
        );
        projects.push(record);
    }
    Ok(projects)
}

/// The Native caller authorizes this source directory and known basename. Row paths grant no IO.
/// No vendor runtime/migrator is initialized. The VFS has no source write or namespace API.
pub fn read_codex_registry(
    directory: &PrivateDirectory,
    name: &OsStr,
    cancellation: &ProjectReadCancellation,
    limits: ProjectReadLimits,
) -> Result<ProjectRegistrySnapshot> {
    read_inner_selected(directory, name, cancellation, limits, None, || {})
}

pub(super) fn read_codex_project(
    directory: &PrivateDirectory,
    name: &OsStr,
    project_id: &str,
    cancellation: &ProjectReadCancellation,
    limits: ProjectReadLimits,
) -> Result<ProjectRegistrySnapshot> {
    read_inner_selected(
        directory,
        name,
        cancellation,
        limits,
        Some(project_id),
        || {},
    )
}

#[cfg(test)]
fn read_inner(
    directory: &PrivateDirectory,
    name: &OsStr,
    cancellation: &ProjectReadCancellation,
    limits: ProjectReadLimits,
    after_gate: impl FnOnce(),
) -> Result<ProjectRegistrySnapshot> {
    read_inner_selected(directory, name, cancellation, limits, None, after_gate)
}
fn read_inner_selected(
    directory: &PrivateDirectory,
    name: &OsStr,
    cancellation: &ProjectReadCancellation,
    limits: ProjectReadLimits,
    selected: Option<&str>,
    after_gate: impl FnOnce(),
) -> Result<ProjectRegistrySnapshot> {
    ensure!(
        (1..=4096).contains(&limits.projects)
            && (1..=16).contains(&limits.roots_per_project)
            && limits.read_bytes > 0
            && limits.read_bytes <= 1024 * 1024 * 1024
            && limits.elapsed > Duration::ZERO
            && limits.elapsed <= Duration::from_secs(1)
            && (1..=4 * 1024 * 1024).contains(&limits.metadata_bytes),
        "migration_project_source_invalid_budget"
    );
    ensure!(
        !cancellation.is_cancelled(),
        "migration_project_source_cancelled"
    );
    let source = directory
        .try_sqlite_source_read_lease(name, 64 * 1024 * 1024 * 1024)?
        .ok_or_else(|| anyhow::anyhow!("migration_project_source_busy"))?;
    let registration = vfs::acquire(source, cancellation.clone(), limits)?;
    after_gate();
    // SQLite may rebuild the private, in-memory WAL index. READ_WRITE is virtual:
    // the VFS rejects every write to an existing source DB/WAL and never creates a sidecar.
    let connection = Connection::open_with_flags_and_vfs(
        "registry.sqlite",
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        registration.name(),
    )
    .map_err(|_| {
        anyhow::anyhow!(
            registration
                .context
                .failure()
                .unwrap_or("migration_project_source_invalid_database")
        )
    })?;
    let rows = configure(&connection, Arc::clone(&registration.context))
        .and_then(|_| project_rows(&connection, limits, selected));
    let closed = connection.close();
    if let Some(code) = registration.context.failure() {
        anyhow::bail!(code)
    }
    ensure!(closed.is_ok(), "migration_project_source_read_failed");
    let projects = rows.map_err(|error| {
        if error.downcast_ref::<rusqlite::Error>().is_some() {
            return anyhow::anyhow!("migration_project_source_schema_unsupported");
        }
        // Operational errors above are fixed domain codes, never parser diagnostics or rows.
        error
    })?;
    let proof = registration.context.proof()?;
    Ok(ProjectRegistrySnapshot {
        format_revision: "codex-project-registry/sqlite/1".into(),
        projects,
        unobserved: vec![
            "project_metadata_not_imported".into(),
            "source_trust_not_imported".into(),
            "worktrees_not_copied".into(),
        ],
        proof,
    })
}

#[cfg(test)]
mod tests;
