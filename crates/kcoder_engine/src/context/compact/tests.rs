use super::history::{
    COMPACT_CONTINUATION_MARKER, COMPACT_SUMMARY_PREFIX, LEGACY_COMPACT_SUMMARY_PREFIX,
    PTL_RETRY_MARKER, TAIL_SPLIT_PRESERVE_MESSAGES, compact_summary_text,
    is_tool_result_only_content,
};
use super::protocol::{
    contains_pseudo_tool_wrapper, is_tool_syntax_default_ignorable,
    validate_compact_response_with_metadata,
};
use super::*;
use kcoder_api::Provider;
use kcoder_types::ApiError as StreamApiError;
use kcoder_types::{Message, MessageDeltaFields};
use std::sync::{Arc, Mutex};

use support::*;

#[path = "tests/history.rs"]
mod history;
#[path = "tests/prefire.rs"]
mod prefire;
#[path = "tests/protocol.rs"]
mod protocol;
#[path = "tests/retries.rs"]
mod retries;
#[path = "tests/stream.rs"]
mod stream;
#[path = "tests/support.rs"]
mod support;
#[path = "tests/usage_tests.rs"]
mod usage_tests;
