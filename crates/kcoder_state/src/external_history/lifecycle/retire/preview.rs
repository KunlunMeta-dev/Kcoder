//! Metadata-only retirement inspection. No producer is retired or repaired here.
use super::*;

pub struct ArchiveRetirementPreview {
    pub archive_id: String,
    pub owns_archive: bool,
    pub retained_references: u64,
    pub readers_idle: bool,
}

impl Catalog<'_> {
    pub fn retirement_preview(&self, source: &str) -> Result<ArchiveRetirementPreview> {
        operation_id(source)?;
        let request = self
            .document
            .requests
            .get(&hash(&source)?)
            .context("external_history_lifecycle_legacy_retained")?;
        let archive = self
            .document
            .archives
            .get(&request.archive)
            .context("external_history_lifecycle_changed")?;
        let observation = self.observation(&archive.id)?;
        let retained = self
            .document
            .references
            .values()
            .filter(|reference| {
                !reference.released
                    && reference.receipt.reference_id != request.reference_id
                    && reference.receipt.archives.contains(&archive.id)
            })
            .count() as u64;
        Ok(ArchiveRetirementPreview {
            archive_id: archive.id.clone(),
            owns_archive: archive.creator == source,
            retained_references: retained,
            readers_idle: observation.read_leases_idle,
        })
    }

    pub fn retirement_page(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<ArchiveRetirementView>, Option<String>)> {
        if let Some(after) = after {
            operation_id(after)?;
        }
        let mut records = self
            .document
            .retirements
            .keys()
            .filter(|id| after.is_none_or(|after| id.as_str() > after));
        let ids = records.by_ref().take(10).collect::<Vec<_>>();
        let next = if records.next().is_some() {
            ids.last().map(|id| (*id).clone())
        } else {
            None
        };
        Ok((
            ids.into_iter()
                .map(|id| self.retirement_view(id))
                .collect::<Result<_>>()?,
            next,
        ))
    }
}
