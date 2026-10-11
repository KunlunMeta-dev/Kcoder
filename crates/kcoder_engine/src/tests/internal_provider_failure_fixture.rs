use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug)]
pub struct FailureProvider {
    pub boundary: u8,
    pub calls: AtomicUsize,
}

impl FailureProvider {
    pub fn new(boundary: u8) -> Self {
        Self {
            boundary,
            calls: AtomicUsize::new(0),
        }
    }
}

impl kcoder_api::Provider for FailureProvider {
    fn name(&self) -> &'static str {
        "internal-failure"
    }

    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let error = kcoder_api::ApiErrorKind::Http {
            error_type: "provider_error".into(),
            message: "opaque diagnostic".into(),
            metadata: kcoder_api::HttpErrorMetadata {
                status: 503,
                provider_code: Some("private-provider-code".into()),
                provider_type: None,
                rejected_reasoning_parameter: None,
                retry_after: Some(std::time::Duration::from_millis(37)),
            },
        };
        match self.boundary {
            0 => Err(error),
            1 => Ok(Box::pin(futures::stream::iter([Err(error)]))),
            _ => Ok(Box::pin(futures::stream::iter([Ok(
                kcoder_types::StreamEvent::Error {
                    error: kcoder_types::ApiError {
                        error_type: "model_protocol_error".into(),
                        message: "opaque protocol diagnostic".into(),
                    },
                },
            )]))),
        }
    }
}

#[allow(dead_code)]
pub fn assert_source(error: &anyhow::Error, boundary: u8) {
    let source = error
        .downcast_ref::<kcoder_api::ApiErrorKind>()
        .expect("internal failure must retain ApiErrorKind source");
    if boundary < 2 {
        let kcoder_api::ApiErrorKind::Http { metadata, .. } = source else {
            panic!("HTTP source changed: {source:?}")
        };
        assert_eq!(metadata.status, 503);
        assert_eq!(
            metadata.provider_code.as_deref(),
            Some("private-provider-code")
        );
        assert_eq!(
            metadata.retry_after,
            Some(std::time::Duration::from_millis(37))
        );
    } else {
        assert!(
            matches!(source, kcoder_api::ApiErrorKind::Api { error_type, .. } if error_type == "model_protocol_error")
        );
    }
}
