//! A bounded live keyset over hot and immutable archived source operations.
use super::*;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use kcoder_state::durable_receipt_archive::DurableReceiptArchiveRow;
use kcoder_types::cross_session_messages::CrossSessionMessageReceiptListParams;

const SCAN_LIMIT: usize = 32;
const MAX_PAGE_BYTES: usize = 96 * 1024;
const CURSOR_DOMAIN: &[u8] = b"kcoder.peer-message.source-list-cursor.v1\0";
const CURSOR_LIFETIME_MS: u64 = 10 * 60 * 1000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    version: u32,
    namespace: String,
    identity_epoch: String,
    source: SessionAddressV1,
    filters_sha256: String,
    after_key: String,
    expires_at_ms: u64,
}

enum Candidate {
    Hot(Box<PeerRouterOperationV1>),
    Archived(DurableReceiptArchiveRow),
}

fn now_ms() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}
fn filters(query: &CrossSessionMessageReceiptListParams) -> Result<String> {
    let mut frozen = query.clone();
    frozen.cursor = None;
    frozen.limit = None;
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&frozen)?)
    ))
}
fn valid_key(key: &str) -> bool {
    key.strip_prefix("source/").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    })
}

impl NativePeerRouterStore {
    fn source_list_cursor(
        &self,
        source: &SessionAddressV1,
        filters_sha256: &str,
        after_key: &str,
        expires_at_ms: u64,
    ) -> Result<String> {
        let payload = serde_json::to_vec(&Cursor {
            version: 1,
            namespace: self.header.directory.clone(),
            identity_epoch: self.header.identity_epoch.clone(),
            source: source.clone(),
            filters_sha256: filters_sha256.into(),
            after_key: after_key.into(),
            expires_at_ms,
        })?;
        let mut bytes = CURSOR_DOMAIN.to_vec();
        bytes.extend(&payload);
        Ok(format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(&payload),
            URL_SAFE_NO_PAD.encode(self.key.sign(&bytes).as_ref())
        ))
    }

    fn source_list_after(
        &self,
        source: &SessionAddressV1,
        filters_sha256: &str,
        cursor: Option<&str>,
    ) -> Result<Option<String>> {
        let Some(cursor) = cursor else {
            return Ok(None);
        };
        let (payload, signature) = cursor
            .split_once('.')
            .context("peer_message_receipt_cursor_invalid")?;
        let payload = URL_SAFE_NO_PAD.decode(payload)?;
        let signature = URL_SAFE_NO_PAD.decode(signature)?;
        let mut bytes = CURSOR_DOMAIN.to_vec();
        bytes.extend(&payload);
        signature::UnparsedPublicKey::new(&signature::ED25519, self.key.public_key().as_ref())
            .verify(&bytes, &signature)
            .map_err(|_| anyhow::anyhow!("peer_message_receipt_cursor_invalid"))?;
        let cursor: Cursor = serde_json::from_slice(&payload)?;
        ensure!(
            cursor.version == 1
                && cursor.namespace == self.header.directory
                && cursor.identity_epoch == self.header.identity_epoch
                && cursor.source == *source
                && cursor.filters_sha256 == filters_sha256
                && valid_key(&cursor.after_key)
                && now_ms()? < cursor.expires_at_ms,
            "peer_message_receipt_cursor_invalid"
        );
        Ok(Some(cursor.after_key))
    }

    /// Source ownership is supplied by the actual caller, never by a public task ID.
    /// Status/time filters are bound to the cursor but evaluated only after a fresh
    /// destination observation. A source receipt is an old observation, not current status.
    pub fn source_operations_page(
        &self,
        source: &SessionAddressV1,
        query: &CrossSessionMessageReceiptListParams,
    ) -> Result<PeerRouterSourceListResultV1> {
        source.validate().map_err(anyhow::Error::msg)?;
        query.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            self.identity(&source.workspace_id)?.contains(source),
            "peer_router_source_changed"
        );
        let filters_sha256 = filters(query)?;
        let after = self.source_list_after(source, &filters_sha256, query.cursor.as_deref())?;
        let expires_at_ms = now_ms()?
            .checked_add(CURSOR_LIFETIME_MS)
            .context("peer_message_receipt_cursor_invalid")?;
        self.access_with_archive(false, |data, archive| {
            let mut candidates = BTreeMap::new();
            for operation in data.operations.values() {
                let key = archive::source_request_key(
                    &operation.source_address,
                    &operation.attestation.claims.client_message_id,
                )?;
                if after.as_ref().is_none_or(|after| &key > after) {
                    ensure!(
                        candidates
                            .insert(key, Candidate::Hot(Box::new(operation.clone())))
                            .is_none(),
                        "peer_message_original_operation_ambiguous"
                    );
                }
            }
            if let Some(tx) = archive.as_ref() {
                for row in tx.prefix_rows_after("source/", after.as_deref(), SCAN_LIMIT + 1)? {
                    ensure!(
                        valid_key(&row.request_key),
                        "peer_router_archived_operation_invalid"
                    );
                    ensure!(
                        candidates
                            .insert(row.request_key.clone(), Candidate::Archived(row))
                            .is_none(),
                        "peer_message_original_operation_ambiguous"
                    );
                }
            }
            let mut result = PeerRouterSourceListResultV1::default();
            let mut last_checked = None;
            let mut bytes = 2048;
            let mut more = false;
            for (checked, (key, candidate)) in candidates.into_iter().enumerate() {
                if checked == SCAN_LIMIT || result.items.len() == query.page_size() {
                    more = true;
                    break;
                }
                let operation = match candidate {
                    Candidate::Hot(operation) => *operation,
                    Candidate::Archived(row) => {
                        self.parse_archived_operation(
                            archive
                                .as_ref()
                                .context("peer_router_archive_unavailable")?,
                            row,
                        )?
                        .operation
                    }
                };
                let matching = operation.source_address == *source
                    && query
                        .target_thread_id
                        .as_ref()
                        .is_none_or(|thread| &operation.destination.thread_id == thread);
                if matching {
                    let item = PeerRouterSourceListItemV1 {
                        operation,
                        cursor: self.source_list_cursor(
                            source,
                            &filters_sha256,
                            &key,
                            expires_at_ms,
                        )?,
                    };
                    let item_bytes = serde_json::to_vec(&item)?.len() + 1;
                    if bytes + item_bytes > MAX_PAGE_BYTES {
                        ensure!(
                            !result.items.is_empty() || last_checked.is_some(),
                            "peer_message_receipt_page_limit"
                        );
                        more = true;
                        break;
                    }
                    bytes += item_bytes;
                    result.items.push(item);
                }
                last_checked = Some(key);
            }
            if more {
                result.next_cursor = Some(
                    self.source_list_cursor(
                        source,
                        &filters_sha256,
                        last_checked
                            .as_deref()
                            .context("peer_message_receipt_page_limit")?,
                        expires_at_ms,
                    )?,
                );
            }
            ensure!(
                serde_json::to_vec(&result)?.len() <= MAX_PAGE_BYTES,
                "peer_message_receipt_page_limit"
            );
            Ok((result, false))
        })
    }
}
