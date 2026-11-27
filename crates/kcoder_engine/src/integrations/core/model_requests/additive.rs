//! Additional Native meters retain all existing admissions, deadlines and settlement duties.
use super::*;
use crate::QueryEngine;
use kcoder_types::{MessagesRequest, Usage};
use std::{sync::Arc, time::Instant};

struct AdditionalObserver {
    original: Arc<dyn NativeModelRequestObserver>,
    additional: Arc<dyn NativeModelRequestObserver>,
}
pub(super) fn intersect(
    original: Arc<dyn NativeModelRequestObserver>,
    additional: Arc<dyn NativeModelRequestObserver>,
) -> Arc<dyn NativeModelRequestObserver> {
    Arc::new(AdditionalObserver {
        original,
        additional,
    })
}
impl NativeModelRequestObserver for AdditionalObserver {
    fn observe_workflow_accepted(
        &self,
        request: &NativeWorkflowRootRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        self.original.observe_workflow_accepted(request)?;
        self.additional.observe_workflow_accepted(request)
    }
    fn retain_auxiliary(
        &self,
        request: &NativeAuxiliaryModelRequest<'_>,
    ) -> Result<Option<Arc<dyn Send + Sync>>, NativeModelRequestError> {
        let original = self.original.retain_auxiliary(request)?;
        let additional = self.additional.retain_auxiliary(request)?;
        Ok(Some(Arc::new((original, additional))))
    }
    fn observe_child_scheduled(
        &self,
        request: &crate::integrations::core::NativeScheduledChildRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        self.original.observe_child_scheduled(request)?;
        self.additional.observe_child_scheduled(request)
    }
    fn observe_execution_terminal(&self) -> Result<(), NativeModelRequestError> {
        let original = self.original.observe_execution_terminal();
        let additional = self.additional.observe_execution_terminal();
        original.and(additional)
    }
    fn prepare_child(
        &self,
        request: &crate::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        self.original.prepare_child(request)?;
        self.additional.prepare_child(request)
    }
    fn observe_child_accepted(
        &self,
        request: &crate::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        self.original.observe_child_accepted(request)?;
        self.additional.observe_child_accepted(request)
    }
    fn reserve(
        &self,
        context: &NativeModelRequestContext,
        request: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        let original = self.original.reserve(context, request)?;
        let additional = match self.additional.reserve(context, request) {
            Ok(lease) => lease,
            Err(error) => {
                // The actual inner Provider has not been called: only this
                // invocation's held original reservation can be settled here.
                let _ = original.finish(NativeModelRequestSettlement {
                    end: NativeModelRequestEnd::AdmissionChanged,
                    usage: None,
                    usage_from_delta: false,
                    request_dispatched: false,
                });
                return Err(error);
            }
        };
        Ok(Box::new(AdditionalLease {
            original,
            additional,
        }))
    }
    fn authorize_transition(
        &self,
        request: &NativeModelTransitionRequest<'_>,
    ) -> Result<Arc<dyn NativeModelRequestObserver>, NativeModelRequestError> {
        let original = self.original.authorize_transition(request);
        let additional = self.additional.authorize_transition(request);
        Ok(Arc::new(Self {
            original: original?,
            additional: additional?,
        }))
    }
}
struct AdditionalLease {
    original: Box<dyn NativeModelRequestLease>,
    additional: Box<dyn NativeModelRequestLease>,
}
impl NativeModelRequestLease for AdditionalLease {
    fn record_usage(&mut self, usage: &Usage) -> Result<(), NativeModelRequestError> {
        let original = self.original.record_usage(usage);
        let additional = self.additional.record_usage(usage);
        original.and(additional)
    }
    fn check_current(&self) -> Result<(), NativeModelRequestError> {
        let original = self.original.check_current();
        let additional = self.additional.check_current();
        original.and(additional)
    }
    fn deadline(&self) -> Option<Instant> {
        match (self.original.deadline(), self.additional.deadline()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) | (None, Some(a)) => Some(a),
            (None, None) => None,
        }
    }
    fn finish(
        self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> Result<(), NativeModelRequestError> {
        let copy = NativeModelRequestSettlement {
            end: settlement.end,
            usage: settlement.usage.clone(),
            usage_from_delta: settlement.usage_from_delta,
            request_dispatched: settlement.request_dispatched,
        };
        let original = self.original.finish(settlement);
        let additional = self.additional.finish(copy);
        original.and(additional)
    }
}
impl QueryEngine {
    /// Host-wide admission survives later source-specific observer replacement.
    /// Adding a guard grants no execution authority and never removes an existing guard.
    pub fn with_mandatory_native_model_request_observer(
        mut self,
        guard: Arc<dyn NativeModelRequestObserver>,
    ) -> anyhow::Result<Self> {
        if self.model_request_binding.as_ref().is_some_and(|binding| {
            binding
                .mandatory
                .iter()
                .any(|current| Arc::ptr_eq(current, &guard))
        }) {
            return Ok(self);
        }
        self = self.with_additional_native_model_request_observer(guard.clone())?;
        let binding = self
            .model_request_binding
            .as_ref()
            .expect("installed Native observer");
        let mut next = binding.with_mandatory_guard(&self, guard);
        next.mandatory.dedup_by(|a, b| Arc::ptr_eq(a, b));
        self.model_request_binding = Some(Arc::new(next));
        self.background_jobs.register_terminal_observer(
            self.model_request_binding
                .as_ref()
                .unwrap()
                .mandatory
                .last()
                .unwrap(),
        )?;
        Ok(self)
    }
    /// Intersect this extra meter with the original Native observer. A new
    /// feature cannot replace an earlier task's model budget or policy.
    pub fn with_additional_native_model_request_observer(
        mut self,
        additional: Arc<dyn NativeModelRequestObserver>,
    ) -> anyhow::Result<Self> {
        let Some(original) = &self.model_request_binding else {
            return self.with_native_model_request_observer(additional);
        };
        if original
            .observer_chain
            .iter()
            .any(|observer| Arc::ptr_eq(observer, &additional))
        {
            return Ok(self);
        }
        anyhow::ensure!(
            original.observer_chain.len() < 64,
            "Native model observer capacity exceeded"
        );
        let observer: Arc<dyn NativeModelRequestObserver> = Arc::new(AdditionalObserver {
            original: original.observer.clone(),
            additional: additional.clone(),
        });
        // Retain original inheritance fences and the sealed failed-attempt
        // tracker. Adding a guard never rebases authority onto a sibling State.
        self.model_request_binding = Some(Arc::new(
            original.with_additional(&self, observer, additional),
        ));
        Ok(self)
    }
}
#[cfg(test)]
#[path = "additive_tests.rs"]
mod tests;
