//! Private credentials travel through the original Native lane; this journal stores metadata only.
use super::*;
#[path = "private/control.rs"]
mod control;
#[path = "private/prepare.rs"]
mod prepare;
#[path = "private/selection.rs"]
mod selection;
#[path = "private/validation.rs"]
mod validation;

pub(super) fn is_error_code(code: &str) -> bool {
    serde_json::from_value::<MigrationSourceCredentialError>(serde_json::Value::String(code.into()))
        .is_ok()
        || matches!(
            code,
            "private_credentials_restore_original_preparation_required"
                | "private_credentials_undo_required"
        )
}

#[path = "private/journal.rs"]
mod journal;
pub(super) use journal::Journal;
use journal::{CancelIntent, Offer, Preparation};
impl Guide {
    async fn private_post<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        operation: &str,
        input: &P,
    ) -> Result<R> {
        self.scope(false).await?;
        let result = self
            .post("source-transfer/private", operation, input)
            .await?;
        self.scope(false).await?;
        Ok(result)
    }
    fn private_selected(&self, job: &str) -> Result<Offer> {
        let journal = self
            .draft
            .private_credentials
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("private_credentials_invalid_selection"))?;
        journal
            .offers
            .iter()
            .find(|row| {
                row.job_id == job
                    && Some(&row.input.locator.offer_id) == journal.selected_offer.as_ref()
            })
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("private_credentials_invalid_selection"))
    }
    fn private_locator(&self, job: &str) -> Result<MigrationSourceCredentialLocator> {
        let journal = self
            .draft
            .private_credentials
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("private_credentials_invalid_selection"))?;
        let id = journal
            .selected_offer
            .as_ref()
            .filter(|id| journal.offer_ids(job).contains(id))
            .ok_or_else(|| anyhow::anyhow!("private_credentials_invalid_selection"))?;
        Ok(MigrationSourceCredentialLocator {
            request_id: self.draft.request_id.clone(),
            offer_id: id.clone(),
            target: self.draft.recovery.clone(),
        })
    }
    pub(super) async fn private_menu(
        &mut self,
        client: &mut runtime::Client,
        job: &str,
    ) -> Result<()> {
        // Dedicated transfer capabilities are checked by the authenticated HTTP owner.
        // The ordinary shared runtime intentionally omits them.
        client.require(MIGRATION_SOURCE_CREDENTIAL_SOURCES_CAPABILITY)?;
        let mut record_page = 0usize;
        loop {
            let mut rows = Vec::new();
            if let Some(journal) = &self.draft.private_credentials {
                for id in journal
                    .offer_ids(job)
                    .iter()
                    .skip(record_page * 10)
                    .take(10)
                {
                    let local = journal
                        .offers
                        .iter()
                        .find(|row| row.job_id == job && &row.input.locator.offer_id == id);
                    rows.push(json!({"number":rows.len()+1,"offerId":id,"entryId":local.map(|row| &row.input.entry_id),"included":local.is_some_and(|row| row.included),"dispatched":local.is_some_and(|row| row.dispatched),"nativeOnly":local.is_none()}));
                }
            }
            let command=self.io.ask("transfer_private_menu","receive selects private fields from original job sources by page; select N selects the original record; read checks only the target; source-read observes only the original source; next/prev shows 10 records per page; continue explicitly reconciles the original receipt; include/exclude explicitly selects original bundles; prepare fixes the complete set; status reads original intent; restore explicitly restores pending state; cancel-source/cancel-target; resume-source/resume-target; release releases the unused or undone original key; back returns. Credential values are not displayed or entered.",json!({"jobId":job,"records":rows}),None)?;
            let mut words = command.split_whitespace();
            let result = match words.next().unwrap_or("") {
                "back" => return Ok(()),
                "receive" => self.private_receive(client, job).await,
                "next" => {
                    let count = self
                        .draft
                        .private_credentials
                        .as_ref()
                        .map(|journal| journal.offer_ids(job).len())
                        .unwrap_or(0);
                    if (record_page + 1) * 10 < count {
                        record_page += 1;
                    }
                    Ok(())
                }
                "prev" if record_page > 0 => {
                    record_page -= 1;
                    Ok(())
                }
                "select" => {
                    let visible = self
                        .draft
                        .private_credentials
                        .as_ref()
                        .map(|journal| journal.offer_ids(job))
                        .unwrap_or_default();
                    let id = words
                        .next()
                        .and_then(|n| n.parse::<usize>().ok())
                        .filter(|n| (1..=10).contains(n))
                        .map(|n| record_page * 10 + n - 1)
                        .and_then(|n| visible.get(n))
                        .cloned();
                    if let Some(id) = id {
                        self.draft
                            .private_credentials
                            .as_mut()
                            .unwrap()
                            .selected_offer = Some(id);
                        self.save()
                    } else {
                        Err(anyhow::anyhow!("private_credentials_invalid_selection"))
                    }
                }
                "read" => self.private_read(job, false).await.map(|_| ()),
                "source-read" => self.private_read(job, true).await.map(|_| ()),
                "continue" => self.private_continue(job).await,
                "include" => self.private_include(job, true).await,
                "exclude" => self.private_include(job, false).await,
                "prepare" => self.private_prepare(client, job, false).await,
                "status" => self.private_status(job).await.map(|_| ()),
                "restore" => self.private_prepare(client, job, true).await,
                "cancel-source" => {
                    self.private_control(job, MigrationSourceCredentialSide::Source, false)
                        .await
                }
                "cancel-target" => {
                    self.private_control(job, MigrationSourceCredentialSide::Target, false)
                        .await
                }
                "resume-source" => {
                    self.private_control(job, MigrationSourceCredentialSide::Source, true)
                        .await
                }
                "resume-target" => {
                    self.private_control(job, MigrationSourceCredentialSide::Target, true)
                        .await
                }
                "release" => self.private_release(client, job).await,
                _ => Err(anyhow::anyhow!("migration_transfer_invalid_selection")),
            };
            if let Err(error) = result {
                self.io.notice(&safe_error(&error),"Private operation completion is unconfirmed. Keep the original offer/set/CAS; check read/status first, without automatic replay or a new identity.")?;
            }
        }
    }
}
