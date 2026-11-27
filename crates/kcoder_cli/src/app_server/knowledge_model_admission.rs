//! Actual Wiki Provider observations, without inventing an Engine turn.
use super::knowledge_model::ProviderWikiModel;
use anyhow::{Result, ensure};
use kcoder_api::native_model_request::{
    NativeModelRequestEnd, NativeModelRequestLease, NativeModelRequestSettlement,
};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_types::{MessagesRequest, StreamEvent, Usage};

/// The implementation borrows the original claimed job authority. Request JSON
/// supplies neither a task owner nor permission to spend its budget.
pub trait WikiRequestAdmission: Sync {
    fn reserve(
        &self,
        model: &ProviderWikiModel,
        request: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease + '_>>;
}

pub(super) struct ObservedWikiRequest<'a> {
    lease: Option<Box<dyn NativeModelRequestLease + 'a>>,
    usage: Option<Usage>,
    usage_from_delta: bool,
    dispatched: bool,
    end: NativeModelRequestEnd,
}

impl<'a> ObservedWikiRequest<'a> {
    pub(super) fn reserve(
        admission: Option<&'a dyn WikiRequestAdmission>,
        model: &ProviderWikiModel,
        request: &MessagesRequest,
    ) -> Result<Option<Self>> {
        let Some(admission) = admission else {
            ensure!(
                !NativeIntegrationContext::organization_launch_required()?,
                "WIKI_ORGANIZATION_MODEL_AUTHORITY_REQUIRED"
            );
            return Ok(None);
        };
        Ok(Some(Self {
            lease: Some(admission.reserve(model, request)?),
            usage: None,
            usage_from_delta: false,
            dispatched: false,
            end: NativeModelRequestEnd::Dropped,
        }))
    }

    pub(super) fn check_current(&self) -> Result<()> {
        let lease = self.lease.as_ref().expect("active Wiki observation");
        ensure!(
            lease
                .deadline()
                .is_none_or(|end| std::time::Instant::now() < end),
            "WIKI_ORGANIZATION_MODEL_DEADLINE"
        );
        lease
            .check_current()
            .map_err(|_| anyhow::anyhow!("WIKI_ORGANIZATION_MODEL_ADMISSION_CHANGED"))
    }

    pub(super) fn dispatch(&mut self) -> Result<()> {
        self.check_current()?;
        // An attempted Provider call can have sent bytes even when its return
        // is an error. Retain its reservation until an authoritative outcome.
        self.dispatched = true;
        Ok(())
    }

    pub(super) fn observe(&mut self, event: &StreamEvent) -> Result<()> {
        if matches!(event, StreamEvent::MessageStop) {
            self.end = NativeModelRequestEnd::MessageStop;
        }
        let reported = match event {
            StreamEvent::MessageStart { message } => message.usage.as_ref(),
            StreamEvent::MessageDelta { delta } => {
                self.usage_from_delta |= delta.usage.is_some();
                delta.usage.as_ref()
            }
            _ => None,
        };
        if let Some(reported) = reported {
            if let Some(current) = &mut self.usage {
                current.merge_stream_update(reported);
            } else {
                self.usage = Some(reported.clone());
            }
            self.lease
                .as_mut()
                .expect("active Wiki observation")
                .record_usage(reported)
                .map_err(|_| anyhow::anyhow!("WIKI_ORGANIZATION_MODEL_ACCOUNTING_FAILED"))?;
        }
        Ok(())
    }

    pub(super) fn finish(mut self) -> Result<()> {
        self.settle()
    }

    fn settle(&mut self) -> Result<()> {
        if let Some(lease) = self.lease.take() {
            lease
                .finish(NativeModelRequestSettlement {
                    end: self.end,
                    usage: self.usage.clone(),
                    usage_from_delta: self.usage_from_delta,
                    request_dispatched: self.dispatched,
                })
                .map_err(|_| anyhow::anyhow!("WIKI_ORGANIZATION_MODEL_ACCOUNTING_FAILED"))?;
        }
        Ok(())
    }
}

impl Drop for ObservedWikiRequest<'_> {
    fn drop(&mut self) {
        // Cancellation may drop the complete future before its next poll.
        // Observe the old call; never retry it or refund unknown usage.
        let _ = self.settle();
    }
}

#[cfg(test)]
#[path = "knowledge_model_admission_tests.rs"]
mod tests;
