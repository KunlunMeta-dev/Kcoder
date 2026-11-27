//! The public target runtime reviews one original Agent; no source grant is borrowed for writes.
use super::*;
use crate::migration_cli::agent_adaptation as flow;
use base64::{Engine as _, engine::general_purpose::STANDARD};

impl Guide {
    pub(super) async fn agent_adaptation(
        &self,
        client: &mut runtime::Client,
        job: &str,
        item: &str,
    ) -> Result<Option<MigrationAgentAdaptation>> {
        if !flow::requested(&self.io)? {
            return Ok(None);
        }
        client.require(CAPABILITY_MIGRATION_AGENT_ADAPTATION_V1)?;
        let result: MigrationAgentPreviewResult = self
            .rpc(
                client,
                method::MIGRATION_AGENT_PREVIEW,
                &MigrationAgentPreviewParams {
                    job_id: job.into(),
                    item_id: item.into(),
                },
            )
            .await?;
        ensure!(
            result.job_id == job && result.item_id == item,
            "migration_remote_invalid_response"
        );
        if !flow::inspect(&self.io, &result.compatibility)? {
            return Ok(None);
        }
        if self.io.yes("agent_original_body", "Explicitly read original Agent text? Sections are at most 16 KiB, checked against the original job/item and SHA. Source content is not executed.")? {
            self.agent_body(client, job, item, &result.compatibility.source_sha256).await?;
        }
        let choice = flow::choose(&self.io, &result.compatibility)?;
        self.scope(false).await?;
        Ok(Some(choice))
    }

    async fn agent_body(
        &self,
        client: &mut runtime::Client,
        job: &str,
        item: &str,
        sha256: &str,
    ) -> Result<()> {
        client.require(CAPABILITY_MIGRATION_DEFINITIONS_V1)?;
        let mut offset = 0;
        loop {
            let result: MigrationDefinitionBodyResult = self
                .rpc(
                    client,
                    method::MIGRATION_DEFINITION_BODY,
                    &MigrationDefinitionBodyParams {
                        job_id: job.into(),
                        item_id: item.into(),
                        offset,
                    },
                )
                .await?;
            ensure!(
                result.bytes_base64.len() <= 21848,
                "migration_remote_invalid_response"
            );
            let bytes = STANDARD
                .decode(&result.bytes_base64)
                .map_err(|_| anyhow::anyhow!("migration_remote_invalid_response"))?;
            let end = offset
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| anyhow::anyhow!("migration_remote_invalid_response"))?;
            ensure!(
                result.job_id == job
                    && result.item_id == item
                    && result.offset == offset
                    && result.sha256 == sha256
                    && bytes.len() <= 16 * 1024
                    && !bytes.is_empty()
                    && result.total_bytes <= 256 * 1024
                    && end <= result.total_bytes
                    && result.next_offset == (end < result.total_bytes).then_some(end)
                    && result.encoding == MigrationDefinitionBodyEncoding::Utf8
                    && result.text.as_deref() == std::str::from_utf8(&bytes).ok(),
                "migration_remote_invalid_response"
            );
            self.io.state("definition_body", &json!({"jobId":job,"itemId":item,"offset":offset,"text":result.text,"sha256":sha256,"totalBytes":result.total_bytes,"executionAllowed":false}))?;
            let Some(next) = result.next_offset else {
                return Ok(());
            };
            if !self.io.yes(
                "definition_next_body",
                "Explicitly read the next section of the original definition?",
            )? {
                return Ok(());
            }
            offset = next;
        }
    }
}
