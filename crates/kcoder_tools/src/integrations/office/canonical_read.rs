//! Explicit source pages retain native revision and byte-coverage semantics.
use super::*;
pub(super) const MODEL_SOURCE_PAGE_BYTES: usize = 16 * 1024;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CanonicalSourceReadOptions {
    /// Omitted or true reads metadata only. False requires SHA, offset and limit.
    #[serde(default = "metadata_default")]
    pub metadata_only: bool,
    /// source.specificationSha256 from metadata, not artifact/output/input SHA.
    pub expected_sha256: Option<String>,
    /// UTF-8 byte offset from the previous page's nextOffset; not a character count.
    pub offset: Option<u64>,
    /// Maximum body bytes, 1..65536. Model pages are <=16384 bytes and may be smaller; follow nextOffset.
    pub limit: Option<usize>,
}
fn metadata_default() -> bool {
    true
}
impl Default for CanonicalSourceReadOptions {
    fn default() -> Self {
        Self {
            metadata_only: true,
            expected_sha256: None,
            offset: None,
            limit: None,
        }
    }
}
impl CanonicalSourceReadOptions {
    pub(super) fn metadata() -> Self {
        Self::default()
    }
    pub(super) fn parameters(
        self,
        reference: OfficeArtifactRef,
    ) -> Result<OfficeCanonicalSourceReadParams, ToolError> {
        if self.metadata_only {
            if self.expected_sha256.is_some() || self.offset.is_some() || self.limit.is_some() {
                return Err(ToolError::InvalidInput(
                    "OfficeData: metadata-only canonical_source reads omit expectedSha256, offset and limit; body reads require sourceRead.metadataOnly=false".into(),
                ));
            }
        } else if self
            .expected_sha256
            .as_deref()
            .is_none_or(|sha| sha.len() != 64 || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()))
            || self.offset.is_none()
            || self
                .limit
                .is_none_or(|limit| !(1..=OFFICE_CANONICAL_SOURCE_CHUNK_BYTES).contains(&limit))
        {
            return Err(ToolError::InvalidInput(
                "OfficeData: /sourceRead body reads require metadataOnly=false, exact source.specificationSha256 (64 hex digits), explicit UTF-8 byte offset, and limit=1..65536; reuse nextOffset for continuation".into(),
            ));
        }
        Ok(OfficeCanonicalSourceReadParams {
            reference,
            metadata_only: self.metadata_only,
            expected_sha256: self.expected_sha256,
            offset: self.offset.unwrap_or(0),
            limit: self.limit.unwrap_or(OFFICE_CANONICAL_SOURCE_CHUNK_BYTES),
        })
    }
}

pub(super) fn source_output(
    value: Value,
    parameters: &OfficeCanonicalSourceReadParams,
    ctx: &ToolContext,
) -> Result<ToolOutput, ToolError> {
    let result: OfficeCanonicalSourceReadResult = serde_json::from_value(value)
        .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?;
    let mut covers_entire_source = false;
    let bytes = result.chunk.as_ref().map_or(0, String::len);
    let valid = match result.availability {
        OfficeCanonicalSourceAvailability::NotRecorded => {
            result.source.is_none()
                && result.chunk.is_none()
                && result.offset == 0
                && result.next_offset.is_none()
                && !result.complete
        }
        OfficeCanonicalSourceAvailability::Available => {
            let source = result
                .source
                .as_ref()
                .ok_or_else(|| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?;
            source
                .validate()
                .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?;
            if source.artifact != parameters.reference {
                return Err(ToolError::Execution("OFFICE_RESULT_INVALID".into()));
            }
            if parameters.metadata_only {
                result.chunk.is_none()
                    && result.offset == 0
                    && result.next_offset.is_none()
                    && !result.complete
            } else {
                let end = result.offset.checked_add(bytes as u64);
                covers_entire_source = result.offset == 0
                    && result.complete
                    && end == Some(source.specification_bytes);
                parameters.expected_sha256.as_deref() == Some(source.specification_sha256.as_str())
                    && result.offset == parameters.offset
                    && result.chunk.is_some()
                    && bytes <= parameters.limit
                    && end.is_some_and(|end| {
                        end <= source.specification_bytes
                            && if result.complete {
                                end == source.specification_bytes && result.next_offset.is_none()
                            } else {
                                bytes > 0
                                    && end < source.specification_bytes
                                    && result.next_offset == Some(end)
                            }
                    })
            }
        }
    };
    if !valid {
        return Err(ToolError::Execution("OFFICE_RESULT_INVALID".into()));
    }
    let mut value = serde_json::to_value(result)
        .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?;
    value["returnedBytes"] = json!(bytes);
    value["pageLimit"] = if parameters.metadata_only {
        Value::Null
    } else {
        json!(parameters.limit)
    };
    value["coversEntireSource"] = json!(covers_entire_source);
    value["completeMeaning"] = json!(
        "complete means this page reaches the source's end, not that earlier pages were read; only coversEntireSource=true means this one response contains the complete source. Join exact chunks from offset 0 and follow nextOffset under the same artifact revision and specificationSha256 before treating paged JSON as complete."
    );
    let text = serde_json::to_string(&value)
        .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?;
    let budget = if ctx.max_output_bytes == 0 {
        32 * 1024
    } else {
        ctx.max_output_bytes.min(32 * 1024)
    };
    if text.len() > budget {
        return Err(ToolError::InvalidInput(
            "OfficeData: canonical source page exceeds this call's output budget; request a smaller sourceRead.limit under the same revision/SHA/offset. No truncated JSON chunk was emitted.".into(),
        ));
    }
    Ok(ToolOutput::text(text))
}

#[cfg(test)]
#[path = "canonical_read_tests.rs"]
mod tests;
