//! Fixed typed failures that keep only a sanitized cause in host diagnostics.
//!
//! Native authorization and model-request ports return fieldless errors to
//! Engine. Their source text may include private paths, account details or
//! request data, so it is never forwarded; only a [`DiagnosticCause`] kind is
//! logged next to a fixed stage name.
use kcoder_engine::integrations::core::NativeToolAuthorizationError;
use kcoder_engine::native_model_requests::NativeModelRequestError;
use kcoder_types::diagnostic_cause::DiagnosticCause;
use std::error::Error;
use std::ops::Deref;

/// Maps a type-erased failure to `NativeToolAuthorizationError::Unavailable`.
pub(in crate::app_server) fn authorization_unavailable<E>(
    stage: &'static str,
) -> impl FnOnce(E) -> NativeToolAuthorizationError
where
    E: Deref<Target = dyn Error + Send + Sync + 'static>,
{
    move |error| {
        let cause = DiagnosticCause::of_chain(&*error);
        tracing::warn!(stage, %cause, "Native tool authorization unavailable");
        NativeToolAuthorizationError::Unavailable
    }
}

/// Maps a type-erased failure to `NativeModelRequestError::Unavailable`.
pub(in crate::app_server) fn model_request_unavailable<E>(
    stage: &'static str,
) -> impl FnOnce(E) -> NativeModelRequestError
where
    E: Deref<Target = dyn Error + Send + Sync + 'static>,
{
    move |error| {
        let cause = DiagnosticCause::of_chain(&*error);
        tracing::warn!(stage, %cause, "Native model request unavailable");
        NativeModelRequestError::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::integrations::core::remote_delegations::receiver_acp_binding::admission_code;
    use anyhow::Context;
    use kcoder_types::diagnostic_cause::{coded, coded_chain};
    use std::sync::{Arc, Mutex};

    fn poisoned() -> Arc<Mutex<()>> {
        let mutex = Arc::new(Mutex::new(()));
        let poisoner = Arc::clone(&mutex);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().unwrap();
            panic!("poison fixture");
        })
        .join();
        mutex
    }

    #[test]
    fn preserved_cause_keeps_stable_code_extraction() {
        let mutex = poisoned();
        let error: anyhow::Error = mutex
            .lock()
            .map(|_| ())
            .map_err(coded("REMOTE_RECEIVER_CONTROL_UNAVAILABLE"))
            .unwrap_err()
            .into();
        assert_eq!(error.to_string(), "REMOTE_RECEIVER_CONTROL_UNAVAILABLE");
        assert_eq!(
            admission_code(&error),
            "REMOTE_RECEIVER_CONTROL_UNAVAILABLE"
        );
        assert_eq!(
            format!("{error:#}"),
            "REMOTE_RECEIVER_CONTROL_UNAVAILABLE: lock:poisoned"
        );
        let outer = error.context("REMOTE_DISPATCH_UNAVAILABLE");
        assert_eq!(admission_code(&outer), "REMOTE_DISPATCH_UNAVAILABLE");
        assert!(
            outer
                .chain()
                .any(|cause| cause.to_string() == "REMOTE_RECEIVER_CONTROL_UNAVAILABLE")
        );
    }

    #[test]
    fn preserved_cause_never_exposes_inner_messages_or_codes() {
        let inner = anyhow::Error::new(std::io::Error::other("/home/private-user/token"))
            .context("REMOTE_INNER_PRIVATE_CODE")
            .context("private request body");
        let error: anyhow::Error = Err::<(), _>(inner)
            .map_err(coded_chain("REMOTE_SESSION_UNAVAILABLE"))
            .unwrap_err()
            .into();
        let rendered = format!("{error:?}");
        assert!(!rendered.contains("private"));
        assert!(!rendered.contains("REMOTE_INNER_PRIVATE_CODE"));
        assert_eq!(admission_code(&error), "REMOTE_SESSION_UNAVAILABLE");
        assert_eq!(
            error.chain().map(ToString::to_string).collect::<Vec<_>>(),
            ["REMOTE_SESSION_UNAVAILABLE", "io:Other"]
        );
    }

    #[test]
    fn typed_failures_stay_fieldless() {
        let error = anyhow::anyhow!("private provider text").context("OFFICE_SETTINGS_UNAVAILABLE");
        assert_eq!(
            authorization_unavailable("fixture")(error),
            NativeToolAuthorizationError::Unavailable
        );
        let error = Err::<(), _>(std::io::Error::from(std::io::ErrorKind::NotFound))
            .context("private path")
            .unwrap_err();
        assert!(matches!(
            model_request_unavailable("fixture")(error),
            NativeModelRequestError::Unavailable
        ));
    }
}
