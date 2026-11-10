//! Numbered terminal choices consume the same opaque Native project catalogs as Web clients.
use super::guide::GuideIo;
use anyhow::{Result, ensure};
use kcoder_app_protocol::*;
use kcoder_types::migration::MigrationSourceKind;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
#[path = "projects/mapping.rs"]
mod mapping;
#[path = "projects/selection.rs"]
mod selection;
pub(super) use mapping::{mapping, report};
pub(super) use selection::sources;

pub(super) trait Client {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value>;
}
pub(super) async fn read<R: DeserializeOwned>(
    client: &mut impl Client,
    method: &str,
    params: &impl Serialize,
) -> Result<R> {
    serde_json::from_value(client.call(method, serde_json::to_value(params)?).await?)
        .map_err(|_| anyhow::anyhow!("migration_project_invalid_response"))
}
fn atom(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn page(index: u32, next: Option<u32>, count: usize, total: u32) -> Result<()> {
    ensure!(
        count <= 10 && total <= 4096,
        "migration_project_invalid_response"
    );
    ensure!(
        next.is_none_or(|n| index.checked_add(1) == Some(n)),
        "migration_project_invalid_response"
    );
    Ok(())
}
fn source_page(
    value: &MigrationProjectSourcesResult,
    source: MigrationSourceKind,
    catalog: Option<&str>,
    index: u32,
) -> Result<()> {
    page(index, value.next_page, value.items.len(), value.total_items)?;
    ensure!(
        value.page_index == index
            && value.source == source
            && atom(&value.catalog_id)
            && catalog.is_none_or(|id| id == value.catalog_id),
        "migration_project_invalid_response"
    );
    let ids = value
        .items
        .iter()
        .map(|row| &row.source_handle)
        .collect::<std::collections::BTreeSet<_>>();
    ensure!(
        ids.len() == value.items.len() && value.items.iter().all(|row| atom(&row.source_handle)),
        "migration_project_invalid_response"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn original_catalog_source_pages_and_opaque_ids_remain_bound() {
        let value = json!({"catalogId":"original","source":"codex","pageIndex":0,"items":[],"totalItems":13,"nextPage":1,"knownRowsComplete":true,"formatRevision":"codex-state-projects/sqlite/1","unobserved":[],"problems":[]});
        let mut result: MigrationProjectSourcesResult = serde_json::from_value(value).unwrap();
        assert!(source_page(&result, MigrationSourceKind::Codex, Some("original"), 0).is_ok());
        assert!(source_page(&result, MigrationSourceKind::Codex, Some("other"), 0).is_err());
        assert!(
            source_page(
                &result,
                MigrationSourceKind::ClaudeCode,
                Some("original"),
                0
            )
            .is_err()
        );
        result.next_page = Some(2);
        assert!(source_page(&result, MigrationSourceKind::Codex, None, 0).is_err());
        assert!(page(u32::MAX, Some(0), 0, 0).is_err());
        assert!(!atom("unknown\nhandle"));
    }
}
