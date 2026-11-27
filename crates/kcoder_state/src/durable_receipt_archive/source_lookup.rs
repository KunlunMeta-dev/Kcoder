//! Bounded B-tree prefix seeks for immutable receipt versions and aliases.
use super::*;

impl DurableReceiptArchiveTransaction<'_> {
    /// Continue an indexed, ascending prefix walk without reading earlier rows.
    /// A page may inspect other sources; this primitive does not grant access to any row.
    pub fn prefix_rows_after(
        &self,
        prefix: &str,
        after_key: Option<&str>,
        limit: usize,
    ) -> Result<Vec<DurableReceiptArchiveRow>> {
        check_key(prefix)?;
        ensure!(
            prefix.is_ascii() && (1..=33).contains(&limit),
            "RECEIPT_ARCHIVE_PREFIX_INVALID"
        );
        if let Some(after) = after_key {
            check_key(after)?;
            ensure!(after.starts_with(prefix), "RECEIPT_ARCHIVE_CURSOR_INVALID");
        }
        let mut upper = prefix.as_bytes().to_vec();
        let last = upper.last_mut().context("RECEIPT_ARCHIVE_PREFIX_INVALID")?;
        ensure!(*last < 0x7f, "RECEIPT_ARCHIVE_PREFIX_INVALID");
        *last += 1;
        let upper = String::from_utf8(upper)?;
        let (sql, lower) = if let Some(after) = after_key {
            (
                "SELECT request_key FROM receipt_archive_rows WHERE request_key>?1 AND request_key<?2 ORDER BY request_key LIMIT ?3",
                after,
            )
        } else {
            (
                "SELECT request_key FROM receipt_archive_rows WHERE request_key>=?1 AND request_key<?2 ORDER BY request_key LIMIT ?3",
                prefix,
            )
        };
        let keys = self
            .connection
            .prepare(sql)?
            .query_map(params![lower, upper, limit], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        keys.into_iter()
            .map(|key| self.get(&key)?.context("RECEIPT_ARCHIVE_INDEX_CHANGED"))
            .collect()
    }

    /// A bounded primary-key range seek, not a table enumeration. Consumers
    /// use at most two rows to detect ambiguity or one descending row to read
    /// their latest immutable version. ASCII prefixes have an exact upper key.
    pub fn prefix_rows(
        &self,
        prefix: &str,
        limit: usize,
        descending: bool,
    ) -> Result<Vec<DurableReceiptArchiveRow>> {
        check_key(prefix)?;
        ensure!(
            prefix.is_ascii() && (1..=8).contains(&limit),
            "RECEIPT_ARCHIVE_PREFIX_INVALID"
        );
        let mut upper = prefix.as_bytes().to_vec();
        let last = upper.last_mut().context("RECEIPT_ARCHIVE_PREFIX_INVALID")?;
        ensure!(*last < 0x7f, "RECEIPT_ARCHIVE_PREFIX_INVALID");
        *last += 1;
        let upper = String::from_utf8(upper)?;
        let sql = if descending {
            "SELECT request_key FROM receipt_archive_rows WHERE request_key>=?1 AND request_key<?2 ORDER BY request_key DESC LIMIT ?3"
        } else {
            "SELECT request_key FROM receipt_archive_rows WHERE request_key>=?1 AND request_key<?2 ORDER BY request_key LIMIT ?3"
        };
        let keys = self
            .connection
            .prepare(sql)?
            .query_map(params![prefix, upper, limit], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        keys.into_iter()
            .map(|key| self.get(&key)?.context("RECEIPT_ARCHIVE_INDEX_CHANGED"))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_keyset_seeks_after_the_original_key_with_bounded_io_and_no_writes() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("receipt-source-page")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let binding =
            DurableReceiptArchiveBinding::reserve(&parent, "owned-source-page", b"checkpoint")?;
        DurableReceiptArchive::initialize(&parent, &binding, b"checkpoint")?;
        let mut archive = DurableReceiptArchive::open(&parent, &binding, true)?;
        archive.access(|tx| {
            for n in 0..2000 {
                let key = format!("source/{n:064x}");
                tx.insert(&DurableReceiptArchiveRow {
                    request_key: key.clone(),
                    message_id: key,
                    body: vec![b'x'; 512],
                })?;
            }
            Ok(())
        })?;
        drop(archive);
        files::READ_BYTES.with(|bytes| bytes.set(0));
        let mut archive = DurableReceiptArchive::open(&parent, &binding, false)?;
        archive.access(|tx| {
            let after = format!("source/{:064x}", 1980);
            let page = tx.prefix_rows_after("source/", Some(&after), 3)?;
            assert_eq!(page.len(), 3);
            assert_eq!(page[0].request_key, format!("source/{:064x}", 1981));
            assert_eq!(
                tx.prefix_rows_after("source/", Some(&page[2].request_key), 3)?[0].request_key,
                format!("source/{:064x}", 1984)
            );
            assert!(
                tx.prefix_rows_after("source/", Some("another/invalid"), 3)
                    .is_err()
            );
            assert!(tx.prefix_rows_after("source/", None, 34).is_err());
            Ok(())
        })?;
        assert!(
            files::READ_BYTES.with(|bytes| bytes.get()) < 128 * 1024,
            "a late page must not scan earlier rows"
        );
        Ok(())
    }

    #[test]
    fn immutable_version_seek_is_bounded_latest_and_does_not_read_the_whole_archive() -> Result<()>
    {
        let root = kcoder_config::create_private_temp_dir("receipt-archive-prefix")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let binding =
            DurableReceiptArchiveBinding::reserve(&parent, "owned-source-prefix", b"checkpoint")?;
        DurableReceiptArchive::initialize(&parent, &binding, b"checkpoint")?;
        let mut archive = DurableReceiptArchive::open(&parent, &binding, true)?;
        archive.access(|tx| {
            for n in 0..600 {
                let key = format!("receipt-version/op/{n:020}");
                tx.insert(&DurableReceiptArchiveRow {
                    request_key: key.clone(),
                    message_id: key,
                    body: vec![b'v'; 4096],
                })?;
            }
            Ok(())
        })?;
        drop(archive);
        files::READ_BYTES.with(|bytes| bytes.set(0));
        let mut archive = DurableReceiptArchive::open(&parent, &binding, false)?;
        archive.access(|tx| {
            let latest = tx.prefix_rows("receipt-version/op/", 1, true)?;
            assert_eq!(latest.len(), 1);
            assert!(latest[0].request_key.ends_with("00000000000000000599"));
            let first = tx.prefix_rows("receipt-version/op/", 2, false)?;
            assert_eq!(first.len(), 2);
            assert!(first[0].request_key.ends_with("00000000000000000000"));
            assert!(
                tx.prefix_rows("receipt-version/missing/", 2, false)?
                    .is_empty()
            );
            assert!(tx.prefix_rows("receipt-version/op/", 9, true).is_err());
            assert!(tx.prefix_rows("非ASCII/", 1, false).is_err());
            Ok(())
        })?;
        let bytes = files::READ_BYTES.with(|bytes| bytes.get());
        assert!(
            bytes < 256 * 1024,
            "bounded range seeks read {bytes} SQLite bytes"
        );
        Ok(())
    }
}
