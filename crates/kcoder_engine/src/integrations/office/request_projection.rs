//! Apply native receipt projections to a detached Provider request, never State.

use super::{
    NativeOfficeToolProjectionAuthority, OfficeNativeProjectionStats,
    project_native_office_tool_inputs,
};
use crate::QueryEngine;
use anyhow::{Result, ensure};
use kcoder_types::{Message, SharedMessages};
use std::{sync::Arc, time::Duration};

impl QueryEngine {
    pub(crate) fn native_office_summary_projection(
        &self,
    ) -> Option<Arc<dyn crate::context::compact::CompactionMessageProjection>> {
        self.native_office_projection.as_ref().map(|authority| {
            Arc::new(OfficeSummaryProjection {
                authority: authority.clone(),
                session_id: self.state.session_id(),
            }) as Arc<dyn crate::context::compact::CompactionMessageProjection>
        })
    }
    /// Install the native Office service for this engine value. A configured
    /// authority cannot be replaced while its history is still in use.
    pub fn with_native_office_projection_authority(
        mut self,
        authority: Arc<dyn NativeOfficeToolProjectionAuthority>,
    ) -> Result<Self> {
        ensure!(
            self.native_office_projection
                .as_ref()
                .is_none_or(|current| Arc::ptr_eq(current, &authority)),
            "NATIVE_OFFICE_PROJECTION_ALREADY_BOUND"
        );
        self.native_office_projection = Some(authority);
        Ok(self)
    }

    pub(crate) async fn project_native_office_request(
        &self,
        messages: &mut SharedMessages,
    ) -> Result<OfficeNativeProjectionStats> {
        let Some(authority) = &self.native_office_projection else {
            return Ok(OfficeNativeProjectionStats::default());
        };
        let session_id = self.state.session_id();
        // Dropping this read-only resolution leaves both the request and State
        // unchanged: the projection commits its bounded replacements at the end.
        let stats = tokio::time::timeout(
            Duration::from_secs(5),
            project_native_office_tool_inputs(messages, &session_id, authority.as_ref()),
        )
        .await
        .map_err(|_| anyhow::anyhow!("NATIVE_OFFICE_PROJECTION_TIMED_OUT"))?
        .map_err(|_| anyhow::anyhow!("NATIVE_OFFICE_PROJECTION_UNAVAILABLE"))?;
        Ok(stats)
    }
}

struct OfficeSummaryProjection {
    authority: Arc<dyn NativeOfficeToolProjectionAuthority>,
    session_id: String,
}
#[async_trait::async_trait]
impl crate::context::compact::CompactionMessageProjection for OfficeSummaryProjection {
    async fn project(&self, messages: &[Message]) -> Result<Vec<Message>> {
        let mut view = SharedMessages::from(messages.to_vec());
        tokio::time::timeout(
            Duration::from_secs(5),
            project_native_office_tool_inputs(&mut view, &self.session_id, self.authority.as_ref()),
        )
        .await
        .map_err(|_| anyhow::anyhow!("NATIVE_OFFICE_PROJECTION_TIMED_OUT"))?
        .map_err(|_| anyhow::anyhow!("NATIVE_OFFICE_PROJECTION_UNAVAILABLE"))?;
        Ok(view.into_vec())
    }
}
