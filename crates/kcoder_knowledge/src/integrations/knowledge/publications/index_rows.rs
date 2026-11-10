//! Optional derived row lookup, populated only by explicit publication/index writers.
use super::*;

const TABLE: &str = "integration_publication_index_rows";

pub(super) fn exists(connection: &rusqlite::Connection) -> Result<bool> {
    let kind: Option<String> = connection
        .query_row(
            "SELECT type FROM sqlite_master WHERE name=?1",
            [TABLE],
            |row| row.get(0),
        )
        .optional()?;
    ensure!(
        kind.as_deref().is_none_or(|kind| kind == "table"),
        "KNOWLEDGE_INDEX_STALE"
    );
    Ok(kind.is_some())
}

pub(super) fn initialize_writer(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    if exists(tx)? {
        return Ok(());
    }
    tx.execute_batch(
        "CREATE TABLE integration_publication_index_rows(
           owner_key TEXT NOT NULL, publication_id TEXT NOT NULL, version INTEGER NOT NULL,
           page_index INTEGER NOT NULL, fts_rowid INTEGER NOT NULL UNIQUE,
           PRIMARY KEY(owner_key,publication_id,version,page_index));
         INSERT INTO integration_publication_index_rows(owner_key,publication_id,version,page_index,fts_rowid)
           SELECT owner_key,publication_id,version,page_index,rowid FROM integration_publication_fts;",
    )?;
    Ok(())
}

pub(super) fn insert(
    tx: &rusqlite::Transaction<'_>,
    owner: &str,
    publication: &str,
    version: u64,
    page: usize,
) -> Result<()> {
    let rowid = tx.last_insert_rowid();
    tx.execute("INSERT INTO integration_publication_index_rows(owner_key,publication_id,version,page_index,fts_rowid) VALUES(?1,?2,?3,?4,?5)",
        params![owner,publication,version,page as i64,rowid])?;
    Ok(())
}

pub(super) fn clear(
    tx: &rusqlite::Transaction<'_>,
    owner: &str,
    publication: &str,
    version: u64,
) -> Result<()> {
    tx.execute("DELETE FROM integration_publication_index_rows WHERE owner_key=?1 AND publication_id=?2 AND version=?3", params![owner,publication,version])?;
    Ok(())
}

pub(super) fn rows(
    connection: &rusqlite::Connection,
    publication: &KnowledgePublication,
) -> Result<Vec<(usize, String, String)>> {
    let key = serde_json::to_string(&publication.owner)?;
    let mut statement = connection.prepare(
        "SELECT m.page_index,f.page_index,f.title_terms,f.body_terms,f.owner_key,f.publication_id,f.version
         FROM integration_publication_index_rows m LEFT JOIN integration_publication_fts f ON f.rowid=m.fts_rowid
         WHERE m.owner_key=?1 AND m.publication_id=?2 AND m.version=?3 ORDER BY m.page_index",
    )?;
    let records = statement
        .query_map(
            params![key, publication.draft.publication_id, publication.version],
            |row| {
                Ok((
                    row.get::<_, usize>(0)?,
                    row.get::<_, Option<usize>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<u64>>(6)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    records
        .into_iter()
        .map(|(index, fts_index, title, body, owner, id, version)| {
            ensure!(
                fts_index == Some(index)
                    && owner.as_deref() == Some(key.as_str())
                    && id.as_deref() == Some(publication.draft.publication_id.as_str())
                    && version == Some(publication.version),
                "KNOWLEDGE_INDEX_STALE"
            );
            Ok((
                index,
                title.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INDEX_STALE"))?,
                body.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INDEX_STALE"))?,
            ))
        })
        .collect()
}
