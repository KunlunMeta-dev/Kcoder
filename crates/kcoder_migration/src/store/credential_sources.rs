//! Read-only original-job provenance supplies locators, never authority to transfer private values.
use super::*;
use crate::batch::BatchSource;
use kcoder_types::migration_credential_sources::MigrationSourceCredentialSourcesResult;

impl MigrationStore {
    pub fn credential_sources(
        &self,
        job_id: &str,
        page_index: u32,
    ) -> Result<MigrationSourceCredentialSourcesResult> {
        ensure!(page_index <= 1024, "private_credentials_invalid_page");
        let job = self.read(job_id)?;
        ensure!(
            job.sequence <= 9_007_199_254_740_991,
            "migration_invalid_sequence"
        );
        let mut seen = BTreeSet::new();
        let mut sources = Vec::new();
        if let Some(batch) = &job.batch {
            for source in &batch.sources {
                if let BatchSource::TransferredConfiguration(binding) = source
                    && seen.insert(binding.credential_source_key())
                {
                    sources.push(binding.as_ref());
                }
            }
        }
        let offset = page_index as usize * 10;
        ensure!(
            offset == 0 || offset < sources.len(),
            "private_credentials_invalid_page"
        );
        let items = sources
            .iter()
            .skip(offset)
            .take(10)
            .map(|binding| binding.credential_source_metadata(&self.profile))
            .collect::<Result<Vec<_>>>()?;
        Ok(MigrationSourceCredentialSourcesResult {
            job_id: job.job_id.clone(),
            sequence: job.sequence,
            plan_id: job.batch.as_ref().and_then(|batch| batch.plan_id.clone()),
            total_items: u32::try_from(sources.len())?,
            next_page: (offset + 10 < sources.len()).then_some(page_index + 1),
            items,
        })
    }
}
