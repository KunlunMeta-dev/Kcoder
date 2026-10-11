use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use kcoder_api::Provider;
use kcoder_config::Settings;
use kcoder_memory::{MemoryManager, MemoryStore};

use super::*;
use crate::test_support::engine_builder::{TestEngineBuilder, settings_using_main_summary_runtime};

use crate::test_support::providers::{EmptyProvider, SummaryCountingProvider};
use support::*;
#[path = "compaction_runtime/prefire_lifecycle.rs"]
mod prefire_lifecycle;
#[path = "compaction_runtime/reactive_recovery.rs"]
mod reactive_recovery;
#[path = "compaction_runtime/revision_commit.rs"]
mod revision_commit;
#[path = "compaction_runtime/summary_commit.rs"]
mod summary_commit;
#[path = "compaction_runtime/support.rs"]
mod support;
#[path = "compaction_runtime/tool_cleanup.rs"]
mod tool_cleanup;
