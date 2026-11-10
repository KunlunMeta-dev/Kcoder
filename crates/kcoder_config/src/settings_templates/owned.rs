//! Explicit import receipts distinguish owned templates from identical or subsequently edited data.
use super::transaction::Stamp;
use super::*;
use std::collections::BTreeMap;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateImportRef {
    pub operation_id: String,
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub profile_identity: String,
    pub content_digest: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateImportState {
    Staged,
    Committed,
    Undone,
    Superseded,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    reference: TemplateImportRef,
    state: TemplateImportState,
    entry: Option<TemplateIndexEntry>,
    stamp: Option<Stamp>,
}
impl std::fmt::Debug for Receipt {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("TemplateReceipt")
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn check(reference: &TemplateImportRef) -> Result<()> {
    validate_id(&reference.id)?;
    anyhow::ensure!(
        reference.operation_id.len() == 37
            && reference.operation_id.starts_with("tmpl-")
            && reference.operation_id[5..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            && !reference.name.trim().is_empty()
            && reference.name.len() <= 512
            && reference
                .description
                .as_ref()
                .is_none_or(|value| value.len() <= 4096)
            && !reference.profile_identity.is_empty()
            && reference.profile_identity.len() <= 256
            && digest(&reference.content_digest),
        "settings_template_invalid_import"
    );
    Ok(())
}
pub(super) fn validate(receipts: &BTreeMap<String, Receipt>) -> Result<()> {
    anyhow::ensure!(
        receipts.len() <= 4096,
        "settings_template_import_budget_exceeded"
    );
    for (id, receipt) in receipts {
        check(&receipt.reference)?;
        anyhow::ensure!(
            id == &receipt.reference.operation_id,
            "settings_template_invalid_import"
        );
        if matches!(
            receipt.state,
            TemplateImportState::Committed | TemplateImportState::Superseded
        ) {
            anyhow::ensure!(
                receipt
                    .entry
                    .as_ref()
                    .is_some_and(|entry| entry.id == receipt.reference.id)
                    && receipt.stamp.is_some(),
                "settings_template_invalid_import"
            );
        }
    }
    Ok(())
}
pub(super) fn is_reserved(receipt: &Receipt, id: &str) -> bool {
    receipt.reference.id == id && receipt.state == TemplateImportState::Staged
}
pub(super) fn reserve(index: &TemplateIndex, id: &str) -> Result<()> {
    anyhow::ensure!(
        !index
            .imports
            .values()
            .any(|receipt| receipt.reference.id == id
                && receipt.state == TemplateImportState::Staged),
        "settings_template_import_pending"
    );
    Ok(())
}
pub(super) fn supersede(index: &mut TemplateIndex, id: &str) {
    for receipt in index.imports.values_mut() {
        if receipt.reference.id == id && receipt.state == TemplateImportState::Committed {
            receipt.state = TemplateImportState::Superseded;
        }
    }
}
impl SettingsTemplateStore {
    fn check_import(&self, reference: &TemplateImportRef) -> Result<()> {
        check(reference)?;
        anyhow::ensure!(
            reference.profile_identity == self.directory.directory_identity()?,
            "settings_template_wrong_profile"
        );
        Ok(())
    }
    fn empty_import_slot(
        &self,
        index: &TemplateIndex,
        reference: &TemplateImportRef,
    ) -> Result<()> {
        anyhow::ensure!(
            !index.templates.iter().any(|entry| entry.id == reference.id)
                && self
                    .read_file(
                        &format!("{}.jsonc", reference.id),
                        MAX_TEMPLATE_BYTES as u64
                    )?
                    .is_none()
                && index.default_id.as_deref() != Some(&reference.id),
            "settings_template_import_target_exists"
        );
        Ok(())
    }
    /// Allocate metadata only. Full target-dependent validation still runs before publication.
    pub fn prepare_owned(
        &self,
        id: &str,
        name: &str,
        description: Option<&str>,
        content: &str,
    ) -> Result<TemplateImportRef> {
        let _guard = self.guard()?;
        checked_content(content)?;
        let mut entropy = [0; 16];
        getrandom::fill(&mut entropy)
            .map_err(|_| anyhow::anyhow!("settings_template_entropy_unavailable"))?;
        let reference = TemplateImportRef {
            operation_id: format!(
                "tmpl-{}",
                entropy
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            ),
            id: id.into(),
            name: name.into(),
            description: description.map(str::to_owned),
            profile_identity: self.directory.directory_identity()?,
            content_digest: hex_sha256(content.as_bytes()),
        };
        self.check_import(&reference)?;
        let index = self.read_index()?;
        self.empty_import_slot(&index, &reference)?;
        anyhow::ensure!(
            !index
                .imports
                .values()
                .any(|receipt| receipt.reference.id == id
                    && matches!(
                        receipt.state,
                        TemplateImportState::Staged | TemplateImportState::Committed
                    )),
            "settings_template_import_target_exists"
        );
        Ok(reference)
    }
    pub fn import_state(
        &self,
        reference: &TemplateImportRef,
    ) -> Result<Option<TemplateImportState>> {
        let _guard = self.guard()?;
        self.import_state_unlocked(reference)
    }

    /// Observe ownership and its exact Provider in the same template-before-settings boundary.
    pub fn import_state_with_provider(
        &self,
        reference: &TemplateImportRef,
        provider_name: &str,
        expected: &crate::ProviderConfig,
    ) -> Result<Option<TemplateImportState>> {
        let _guard = self.guard()?;
        crate::ProfileSettingsFile::new(self.directory.try_clone()?)?.inspect_locked(|current| {
            anyhow::ensure!(
                current
                    .get("providers")
                    .and_then(|providers| providers.get(provider_name))
                    == Some(&serde_json::to_value(expected)?),
                "settings_template_provider_changed"
            );
            self.import_state_unlocked(reference)
        })
    }

    fn import_state_unlocked(
        &self,
        reference: &TemplateImportRef,
    ) -> Result<Option<TemplateImportState>> {
        self.check_import(reference)?;
        let index = self.read_index()?;
        let Some(receipt) = index.imports.get(&reference.operation_id) else {
            return Ok(None);
        };
        anyhow::ensure!(
            receipt.reference == *reference,
            "settings_template_import_receipt_conflict"
        );
        if receipt.state == TemplateImportState::Committed {
            self.verify_owned(&index, receipt)?;
        }
        Ok(Some(receipt.state))
    }
    pub fn install_owned(
        &self,
        reference: &TemplateImportRef,
        content: &str,
    ) -> Result<TemplateImportState> {
        let _guard = self.guard()?;
        self.install_owned_unlocked(reference, content, None)
    }

    /// Bind an imported template to the exact Provider checked under the shared settings lock.
    pub fn install_owned_with_provider(
        &self,
        reference: &TemplateImportRef,
        content: &str,
        provider_name: &str,
        expected: &crate::ProviderConfig,
    ) -> Result<TemplateImportState> {
        let _guard = self.guard()?;
        crate::ProfileSettingsFile::new(self.directory.try_clone()?)?.inspect_locked(|current| {
            anyhow::ensure!(
                current
                    .get("providers")
                    .and_then(|providers| providers.get(provider_name))
                    == Some(&serde_json::to_value(expected)?),
                "settings_template_provider_changed"
            );
            self.install_owned_unlocked(reference, content, Some(current))
        })
    }

    fn install_owned_unlocked(
        &self,
        reference: &TemplateImportRef,
        content: &str,
        current: Option<&Value>,
    ) -> Result<TemplateImportState> {
        self.check_import(reference)?;
        anyhow::ensure!(
            hex_sha256(content.as_bytes()) == reference.content_digest,
            "settings_template_import_content_changed"
        );
        let mut index = self.read_index()?;
        if let Some(receipt) = index.imports.get(&reference.operation_id) {
            anyhow::ensure!(
                receipt.reference == *reference,
                "settings_template_import_receipt_conflict"
            );
            match receipt.state {
                TemplateImportState::Committed => {
                    self.verify_owned(&index, receipt)?;
                    return Ok(receipt.state);
                }
                TemplateImportState::Staged => {}
                _ => anyhow::bail!("settings_template_import_not_publishable"),
            }
        } else {
            self.empty_import_slot(&index, reference)?;
            anyhow::ensure!(
                !index
                    .imports
                    .values()
                    .any(|receipt| receipt.reference.id == reference.id
                        && matches!(
                            receipt.state,
                            TemplateImportState::Staged | TemplateImportState::Committed
                        )),
                "settings_template_import_target_exists"
            );
            match current {
                Some(current) => Self::validate_content_against(content, current)?,
                None => self.validate_content(content)?,
            }
            index.imports.insert(
                reference.operation_id.clone(),
                Receipt {
                    reference: reference.clone(),
                    state: TemplateImportState::Staged,
                    entry: None,
                    stamp: None,
                },
            );
            self.write_index(&index)?;
        }
        self.empty_import_slot(&index, reference)?;
        anyhow::ensure!(
            hex_sha256(content.as_bytes()) == reference.content_digest,
            "settings_template_import_content_changed"
        );
        match current {
            Some(current) => Self::validate_content_against(content, current)?,
            None => self.validate_content(content)?,
        }
        let now = now_rfc3339();
        let entry = TemplateIndexEntry {
            id: reference.id.clone(),
            name: reference.name.clone(),
            description: reference.description.clone(),
            created_at: now.clone(),
            updated_at: now,
            revision_sha256: reference.content_digest.clone(),
            size_bytes: content.len() as u64,
            owner: Some(reference.operation_id.clone()),
        };
        index.templates.push(entry.clone());
        self.publish_with(&reference.id, Some(content.as_bytes()), |stamp| {
            let receipt = index.imports.get_mut(&reference.operation_id).unwrap();
            receipt.state = TemplateImportState::Committed;
            receipt.entry = Some(entry);
            receipt.stamp = stamp;
            Ok(index)
        })?;
        Ok(TemplateImportState::Committed)
    }
    pub fn undo_owned(&self, reference: &TemplateImportRef) -> Result<TemplateImportState> {
        let _guard = self.guard()?;
        self.check_import(reference)?;
        let mut index = self.read_index()?;
        let receipt = index
            .imports
            .get(&reference.operation_id)
            .ok_or_else(|| anyhow::anyhow!("settings_template_import_receipt_required"))?
            .clone();
        anyhow::ensure!(
            receipt.reference == *reference,
            "settings_template_import_receipt_conflict"
        );
        match receipt.state {
            TemplateImportState::Undone => return Ok(receipt.state),
            TemplateImportState::Superseded => {
                anyhow::bail!("settings_template_import_target_changed")
            }
            TemplateImportState::Staged => {
                self.empty_import_slot(&index, reference)?;
                index
                    .imports
                    .get_mut(&reference.operation_id)
                    .unwrap()
                    .state = TemplateImportState::Undone;
                self.write_index(&index)?;
            }
            TemplateImportState::Committed => {
                self.verify_owned(&index, &receipt)?;
                anyhow::ensure!(
                    index.default_id.as_deref() != Some(&reference.id),
                    "settings_template_import_referenced"
                );
                index.templates.retain(|entry| entry.id != reference.id);
                index
                    .imports
                    .get_mut(&reference.operation_id)
                    .unwrap()
                    .state = TemplateImportState::Undone;
                self.publish(&reference.id, None, &index)?;
            }
        }
        Ok(TemplateImportState::Undone)
    }
    fn verify_owned(&self, index: &TemplateIndex, receipt: &Receipt) -> Result<()> {
        self.check_import(&receipt.reference)?;
        anyhow::ensure!(
            index
                .templates
                .iter()
                .find(|entry| entry.id == receipt.reference.id)
                == receipt.entry.as_ref(),
            "settings_template_import_target_changed"
        );
        let Some(directory) = self.directory(false)? else {
            anyhow::bail!("settings_template_import_target_changed")
        };
        anyhow::ensure!(
            super::transaction::stamp(
                &directory,
                &format!("{}.jsonc", receipt.reference.id),
                MAX_TEMPLATE_BYTES as u64
            )? == receipt.stamp,
            "settings_template_import_target_changed"
        );
        Ok(())
    }
}
