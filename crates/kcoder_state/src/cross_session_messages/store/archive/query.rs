use super::*;

/// An exact immutable request selector from an already authorized host.
/// These fields are provenance constraints, not an authorization credential.
pub struct OriginalReceiptQuery<'a> {
    pub source: &'a CrossSessionMessageSource,
    pub client_message_id: &'a str,
    pub message_id: Option<&'a str>,
    pub destination: &'a kcoder_types::session_address::SessionAddressV1,
    pub mode: AgentMessageMode,
    pub expected_turn_id: Option<&'a str>,
    pub reply_to_message_id: Option<&'a str>,
    pub body_sha256: &'a str,
}

impl CrossSessionMessageStore {
    /// Read authoritative status and original times from one queue snapshot,
    /// including tombstones whose retained payload has already expired.
    pub fn original_receipt_summary(
        &self,
        query: &OriginalReceiptQuery<'_>,
    ) -> Result<Option<CrossSessionReceiptBinding>> {
        let binding =
            self.get_receipt_binding_by_client_id(query.source, query.client_message_id)?;
        let Some(binding) = binding else {
            return Ok(None);
        };
        ensure!(
            binding.source == *query.source
                && binding.receipt.client_message_id == query.client_message_id
                && query
                    .message_id
                    .is_none_or(|id| binding.receipt.message_id == id)
                && binding.target_address.as_ref() == Some(query.destination)
                && binding.target_thread_id == query.destination.thread_id
                && binding.receipt.target_address.as_ref() == Some(query.destination)
                && binding.receipt.source_address == query.source.address
                && binding.mode == query.mode
                && binding.expected_turn_id.as_deref() == query.expected_turn_id
                && binding.reply_to_message_id.as_deref() == query.reply_to_message_id
                && binding.receipt.reply_to_message_id.as_deref() == query.reply_to_message_id
                && binding.body_sha256 == query.body_sha256,
            "AGENT_MESSAGE_ORIGINAL_PROVENANCE_CHANGED"
        );
        Ok(Some(binding))
    }

    /// Read the receipt and its immutable provenance in one locked snapshot.
    pub fn get_receipt_binding_by_client_id(
        &self,
        source: &CrossSessionMessageSource,
        client_message_id: &str,
    ) -> Result<Option<CrossSessionReceiptBinding>> {
        source.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            valid_agent_message_id(client_message_id),
            "AGENT_MESSAGE_INVALID_ID"
        );
        let key = request_key(source, client_message_id)?;
        self.access_with_archive(false, |data, archive| {
            let binding = if let Some(value) = data.messages.get(&key) {
                Some(Terminal::from_value(value, crate::now_millis())?.binding())
            } else {
                archive
                    .map(|tx| self.terminal_by_key(tx, &key))
                    .transpose()?
                    .flatten()
                    .map(|terminal| terminal.binding())
            };
            Ok((binding, false))
        })
    }
}
