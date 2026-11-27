use super::*;
#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::migration_cli::transfer::guide) struct Journal {
    pub offers: Vec<Offer>,
    pub preparations: std::collections::BTreeMap<String, Preparation>,
    pub selected_offer: Option<String>,
    pub controls: std::collections::BTreeMap<String, CancelIntent>,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::migration_cli::transfer::guide) struct Offer {
    pub job_id: String,
    pub original_plan_id: String,
    pub source_binding_revision: String,
    pub input: MigrationSourceCredentialRunParams,
    pub dispatched: bool,
    pub included: bool,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::migration_cli::transfer::guide) struct Preparation {
    pub original_plan_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_plan_id: Option<String>,
    pub input: MigrationSourceCredentialPrepareParams,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::migration_cli::transfer::guide) struct CancelIntent {
    pub command_id: String,
    pub expected: MigrationSourceCredentialExpectedControl,
}
impl Journal {
    pub(super) fn offer_ids(&self, job: &str) -> Vec<String> {
        let mut ids = self
            .offers
            .iter()
            .filter(|row| row.job_id == job)
            .map(|row| row.input.locator.offer_id.clone())
            .collect::<Vec<_>>();
        if let Some(preparation) = self.preparations.get(job) {
            // A canonical native intent may outlive the client offer-selection cache.
            let mut native_ids = vec![preparation.input.locator.offer_id.clone()];
            native_ids.extend(
                preparation
                    .input
                    .additional_offers
                    .clone()
                    .unwrap_or_default(),
            );
            for id in native_ids {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        ids
    }
    pub(in crate::migration_cli::transfer::guide) fn validate(&self, draft: &Draft) -> Result<()> {
        ensure!(
            self.offers.len() <= 64 && self.preparations.len() <= 4 && self.controls.len() <= 256,
            "migration_transfer_record_invalid"
        );
        let mut ids = std::collections::BTreeSet::new();
        for offer in &self.offers {
            let input: MigrationSourceCredentialRunParams =
                serde_json::from_value(serde_json::to_value(&offer.input)?)
                    .map_err(|_| anyhow::anyhow!("migration_transfer_record_invalid"))?;
            ensure!(
                ids.insert(input.locator.offer_id.clone())
                    && input.locator.request_id == draft.request_id
                    && draft.manifest_sha256.as_ref() == Some(&input.manifest_sha256)
                    && same_route(&input.source, &draft.source)
                    && same_route(&input.locator.target, &draft.target)
                    && input.source.purpose == MigrationSourceSessionPurpose::Source
                    && input.locator.target.purpose == MigrationSourceSessionPurpose::Target
                    && job_id(&offer.job_id)
                    && validation::atom(&offer.original_plan_id)
                    && validation::sha(&offer.source_binding_revision),
                "migration_transfer_record_invalid"
            );
        }
        let mut canonical_jobs = std::collections::BTreeMap::new();
        for (job, preparation) in &self.preparations {
            let input: MigrationSourceCredentialPrepareParams =
                serde_json::from_value(serde_json::to_value(&preparation.input)?)
                    .map_err(|_| anyhow::anyhow!("migration_transfer_record_invalid"))?;
            ensure!(
                job_id(job)
                    && job == &input.job_id
                    && input.locator.request_id == draft.request_id
                    && same_route(&input.locator.target, &draft.target)
                    && input.locator.target.purpose
                        == MigrationSourceSessionPurpose::TargetRecovery
                    && validation::atom(&preparation.original_plan_id)
                    && preparation
                        .canonical_plan_id
                        .as_ref()
                        .is_none_or(|id| validation::atom(id)),
                "migration_transfer_record_invalid"
            );
            for id in validation::offer_set(&input)? {
                ensure!(
                    canonical_jobs.insert(id.clone(), job).is_none(),
                    "migration_transfer_record_invalid"
                );
                ensure!(
                    self.offers
                        .iter()
                        .all(|offer| offer.input.locator.offer_id != id || &offer.job_id == job),
                    "migration_transfer_record_invalid"
                );
                ids.insert(id);
            }
        }
        ensure!(
            self.selected_offer
                .as_ref()
                .is_none_or(|id| ids.contains(id)),
            "migration_transfer_record_invalid"
        );
        for (key, intent) in &self.controls {
            let Some((offer, side)) = key.rsplit_once(':') else {
                anyhow::bail!("migration_transfer_record_invalid")
            };
            ensure!(
                ids.contains(offer)
                    && matches!(side, "source" | "target")
                    && uuid::Uuid::parse_str(&intent.command_id).is_ok(),
                "migration_transfer_record_invalid"
            );
        }
        Ok(())
    }
}
fn same_route(left: &MigrationSourceSessionParams, right: &MigrationSourceSessionParams) -> bool {
    left.target_id == right.target_id && left.workspace_path == right.workspace_path
}

fn job_id(value: &str) -> bool {
    value.len() == 36
        && value.starts_with("mig-")
        && value[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
