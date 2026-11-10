//! Current root metadata proof plus publisher-owned read pages. Nothing is persisted here.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Snapshot {
    pub(super) stat_fingerprint: String,
    pub(super) fingerprint: String,
    pub(super) groups: Vec<Group>,
    pub(super) next_transition_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Group {
    pub(super) handle: String,
    pub(super) owner: KnowledgeOwner,
    pub(super) source: Value,
}
impl Snapshot {
    pub(super) fn capture(
        host: &NativeKnowledgeHost,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        ensure!(host.policy.is_none(), "KNOWLEDGE_POLICY_UNAVAILABLE");
        let (metadata, body) = host.native.shared_publication_directory_request(
            "sharedPublication.directory.inspect",
            &request.request_id,
            serde_json::Map::new(),
        )?;
        ensure!(
            metadata["format"] == "kcoder-shared-directory-manifest/1",
            "KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"
        );
        let raw = read_sealed(
            body.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?,
            &metadata,
            0,
            4 * 1024 * 1024,
            cancel,
        )?;
        let snapshot: Self = serde_json::from_slice(&raw)?;
        ensure!(
            snapshot.groups.len() <= 1000 && metadata["fingerprint"] == snapshot.fingerprint,
            "KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"
        );
        for group in &snapshot.groups {
            ensure!(
                (group.owner.account_id != host.scope().account_id
                    || legacy::same_account_other_workspace(&group.owner, host.scope()))
                    && group.owner.organization_id == host.scope().organization_id
                    && group.source["owner"] == serde_json::to_value(&group.owner)?
                    && group.source["format"] == "kcoder-shared-directory/1"
                    && group.source["hasItems"].is_boolean(),
                "KNOWLEDGE_RESOURCE_DENIED"
            );
        }
        snapshot.verify(host, request)?;
        Ok(snapshot)
    }
    pub(super) fn verify(
        &self,
        host: &NativeKnowledgeHost,
        request: &IntegrationRequest,
    ) -> Result<()> {
        let (metadata,body)=host.native.shared_publication_directory_request("sharedPublication.directory.check",&request.request_id,
            json!({"statFingerprint":self.stat_fingerprint,"nextTransitionMs":self.next_transition_ms}).as_object().unwrap().clone())?;
        ensure!(
            body.is_none()
                && metadata["statFingerprint"] == self.stat_fingerprint
                && self
                    .next_transition_ms
                    .is_none_or(|time| u64::try_from(chrono::Utc::now().timestamp_millis())
                        .is_ok_and(|now| now < time)),
            "KNOWLEDGE_INVALID_CURSOR"
        );
        Ok(())
    }
    pub(super) fn page(
        &self,
        host: &NativeKnowledgeHost,
        request: &IntegrationRequest,
        group: &Group,
        after: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<KnowledgePage<KnowledgePublication>> {
        ensure!(!cancel.is_cancelled(), "KNOWLEDGE_POLICY_UNAVAILABLE");
        let fields=json!({"handle":group.handle,"statFingerprint":self.stat_fingerprint,"after":after,"expectedSha256":null}).as_object().unwrap().clone();
        let (before, body) = host.native.shared_publication_directory_request(
            "sharedPublication.directory.list",
            &request.request_id,
            fields,
        )?;
        verify_source(group, &before)?;
        let uid = before["publisherUid"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?;
        ensure!(uid >= 1000, "KNOWLEDGE_RESOURCE_DENIED");
        let raw = read_sealed(
            body.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?,
            &before,
            uid,
            768 * 1024,
            cancel,
        )?;
        let page: KnowledgePage<KnowledgePublication> = serde_json::from_slice(&raw)?;
        ensure!(
            page.items.len() <= 10
                && page.items.iter().all(|item| item.owner == group.owner
                    && item.draft.visibility != KnowledgeVisibility::Personal
                    && item.draft.audience_id.is_some()
                    && !item.revoked),
            "KNOWLEDGE_RESOURCE_DENIED"
        );
        let fields=json!({"handle":group.handle,"statFingerprint":self.stat_fingerprint,"after":after,"expectedSha256":before["bodySha256"]}).as_object().unwrap().clone();
        let (after, extra) = host.native.shared_publication_directory_request(
            "sharedPublication.directory.verify",
            &request.request_id,
            fields,
        )?;
        verify_source(group, &after)?;
        ensure!(
            extra.is_none()
                && before["bodySha256"] == after["bodySha256"]
                && before["bodyBytes"] == after["bodyBytes"],
            "KNOWLEDGE_INVALID_CURSOR"
        );
        self.verify(host, request)?;
        Ok(page)
    }
}
fn verify_source(group: &Group, observed: &Value) -> Result<()> {
    for name in [
        "owner",
        "publisherUid",
        "identityGeneration",
        "identityRevision",
        "sourceIdentitySha256",
        "timeEpoch",
        "nextTransitionMs",
        "policyRevision",
        "readerIdentityRevision",
        "publisherAccountRevision",
    ] {
        ensure!(
            observed[name] == group.source[name],
            "KNOWLEDGE_INVALID_CURSOR"
        );
    }
    Ok(())
}
pub(super) fn group_key(owner: &KnowledgeOwner) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(owner)?)))
}
#[cfg(target_os = "linux")]
fn read_sealed(
    mut file: File,
    metadata: &Value,
    uid: u64,
    maximum: u64,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    let size = metadata["bodyBytes"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?;
    let info = file.metadata()?;
    let required = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    let seals = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) };
    ensure!(
        size > 0
            && size <= maximum
            && info.is_file()
            && info.nlink() == 0
            && info.len() == size
            && u64::from(info.uid()) == uid
            && seals >= 0
            && seals & required == required
            && (uid != 0 || info.mode() & 0o777 == 0o600),
        "KNOWLEDGE_DIRECTORY_METADATA_INVALID"
    );
    let mut raw = Vec::with_capacity(size as usize);
    let mut block = [0u8; 32768];
    loop {
        ensure!(!cancel.is_cancelled(), "KNOWLEDGE_POLICY_UNAVAILABLE");
        let count = file.read(&mut block)?;
        if count == 0 {
            break;
        }
        ensure!(
            raw.len().saturating_add(count) <= size as usize,
            "KNOWLEDGE_DIRECTORY_METADATA_INVALID"
        );
        raw.extend_from_slice(&block[..count]);
    }
    ensure!(
        raw.len() == size as usize
            && metadata["bodySha256"] == format!("{:x}", Sha256::digest(&raw)),
        "KNOWLEDGE_DIRECTORY_METADATA_INVALID"
    );
    Ok(raw)
}
#[cfg(not(target_os = "linux"))]
fn read_sealed(
    _file: File,
    _metadata: &Value,
    _uid: u64,
    _maximum: u64,
    _cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    anyhow::bail!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE")
}
