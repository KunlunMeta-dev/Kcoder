//! Stable error codes that keep a sanitized root cause for diagnostics.
//!
//! Integration layers expose stable codes such as `REMOTE_DISPATCH_UNAVAILABLE`
//! to clients, persisted receipts and allowlists. Those codes are matched by
//! the top-level message or by an exact cause in the error chain. Replacing
//! `map_err(|_| anyhow!("CODE"))` with `map_err(coded("CODE"))` keeps that
//! top-level message unchanged and appends exactly one [`DiagnosticCause`].
//!
//! A [`DiagnosticCause`] carries only a classification derived from the
//! source's type: an `io::ErrorKind` with its OS error number, a JSON error
//! category with its position, a lock-poisoning marker, or a type name. It
//! never formats the source's own message, so file contents, private paths,
//! tokens, request bodies and model text cannot reach logs, traces, the model
//! or remote peers through it. The kind text always starts with a lowercase
//! category and a colon, so it never matches an uppercase stable code.
use std::borrow::Cow;
use std::error::Error;
use std::fmt;
use std::ops::Deref;

/// Sanitized classification of a dropped source error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticCause {
    kind: Cow<'static, str>,
}

impl DiagnosticCause {
    /// Classifies a source whose type knows its own sanitized kind.
    pub fn of<E: DiagnosticKind + ?Sized>(source: &E) -> Self {
        Self {
            kind: source.diagnostic_kind(),
        }
    }

    /// Classifies an error chain by the first cause with a known sanitized kind.
    pub fn of_chain(source: &(dyn Error + 'static)) -> Self {
        Self {
            kind: classify_chain(source).unwrap_or(Cow::Borrowed("unclassified:error")),
        }
    }

    /// A fixed kind chosen by the caller for a source this module cannot
    /// classify, such as an async channel state. Use a literal in the
    /// lowercase `category:detail` form; never pass source-derived text.
    pub const fn fixed(kind: &'static str) -> Self {
        Self {
            kind: Cow::Borrowed(kind),
        }
    }

    /// The sanitized kind, for example `io:NotFound:os=2` or `lock:poisoned`.
    pub fn kind(&self) -> &str {
        &self.kind
    }
}

impl fmt::Display for DiagnosticCause {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.kind)
    }
}

impl Error for DiagnosticCause {}

/// A stable code whose only source is a sanitized [`DiagnosticCause`].
///
/// `Display` renders the code alone, so `error.to_string()` and exact
/// `error.chain()` code matches behave as with `anyhow!("CODE")`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodedError {
    code: &'static str,
    cause: DiagnosticCause,
}

impl CodedError {
    pub fn new(code: &'static str, cause: DiagnosticCause) -> Self {
        Self { code, cause }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn cause(&self) -> &DiagnosticCause {
        &self.cause
    }
}

impl fmt::Display for CodedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for CodedError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.cause)
    }
}

/// Maps a source with a known sanitized kind (locks, I/O, JSON, conversions)
/// to `code`, for use as `.map_err(coded("CODE"))?`.
pub fn coded<E: DiagnosticKind>(code: &'static str) -> impl FnOnce(E) -> CodedError {
    move |source| CodedError::new(code, DiagnosticCause::of(&source))
}

/// Maps any `'static` standard error to `code`; unknown types are classified
/// by their type name only.
pub fn coded_error<E: Error + 'static>(code: &'static str) -> impl FnOnce(E) -> CodedError {
    move |source| {
        let kind = classify_chain(&source).unwrap_or_else(|| {
            Cow::Owned(format!(
                "type:{}",
                short_type_name(std::any::type_name::<E>())
            ))
        });
        CodedError::new(code, DiagnosticCause { kind })
    }
}

/// Maps a type-erased error such as `anyhow::Error` to `code`, classified by
/// the first cause in its chain with a known sanitized kind.
pub fn coded_chain<E>(code: &'static str) -> impl FnOnce(E) -> CodedError
where
    E: Deref<Target = dyn Error + Send + Sync + 'static>,
{
    move |source| {
        let source: &(dyn Error + 'static) = &*source;
        CodedError::new(code, DiagnosticCause::of_chain(source))
    }
}

/// Source errors that can describe themselves without exposing their message.
pub trait DiagnosticKind {
    fn diagnostic_kind(&self) -> Cow<'static, str>;
}

impl<T> DiagnosticKind for std::sync::PoisonError<T> {
    fn diagnostic_kind(&self) -> Cow<'static, str> {
        Cow::Borrowed("lock:poisoned")
    }
}

impl<T> DiagnosticKind for std::sync::TryLockError<T> {
    fn diagnostic_kind(&self) -> Cow<'static, str> {
        Cow::Borrowed(match self {
            std::sync::TryLockError::Poisoned(_) => "lock:poisoned",
            std::sync::TryLockError::WouldBlock => "lock:would_block",
        })
    }
}

impl<T> DiagnosticKind for std::sync::mpsc::SendError<T> {
    fn diagnostic_kind(&self) -> Cow<'static, str> {
        Cow::Borrowed("channel:closed")
    }
}

impl<T> DiagnosticKind for std::sync::mpsc::TrySendError<T> {
    fn diagnostic_kind(&self) -> Cow<'static, str> {
        Cow::Borrowed(match self {
            std::sync::mpsc::TrySendError::Full(_) => "channel:full",
            std::sync::mpsc::TrySendError::Disconnected(_) => "channel:closed",
        })
    }
}

macro_rules! classified_kind {
    ($($source:ty),* $(,)?) => {$(
        impl DiagnosticKind for $source {
            fn diagnostic_kind(&self) -> Cow<'static, str> {
                classify_chain(self).unwrap_or(Cow::Borrowed("unclassified:error"))
            }
        }
    )*};
}

classified_kind!(
    std::io::Error,
    serde_json::Error,
    std::str::Utf8Error,
    std::string::FromUtf8Error,
    std::num::TryFromIntError,
    std::num::ParseIntError,
    std::array::TryFromSliceError,
    std::time::SystemTimeError,
    std::sync::mpsc::RecvError,
    std::sync::mpsc::RecvTimeoutError,
    std::sync::mpsc::TryRecvError,
);

fn classify_chain(source: &(dyn Error + 'static)) -> Option<Cow<'static, str>> {
    let mut current = Some(source);
    // Bound the walk so a cyclic or very deep chain cannot stall diagnostics.
    for _ in 0..16 {
        let error = current?;
        if let Some(kind) = classify_one(error) {
            return Some(kind);
        }
        current = error.source();
    }
    None
}

fn classify_one(error: &(dyn Error + 'static)) -> Option<Cow<'static, str>> {
    if let Some(cause) = error.downcast_ref::<DiagnosticCause>() {
        return Some(cause.kind.clone());
    }
    if let Some(error) = error.downcast_ref::<std::io::Error>() {
        // Custom I/O payloads may carry arbitrary text, so only the kind and
        // OS error number are reported.
        return Some(Cow::Owned(match error.raw_os_error() {
            Some(code) => format!("io:{:?}:os={code}", error.kind()),
            None => format!("io:{:?}", error.kind()),
        }));
    }
    if let Some(error) = error.downcast_ref::<serde_json::Error>() {
        // Data errors can echo decoded values, so only the category and the
        // position are reported.
        let category = match error.classify() {
            serde_json::error::Category::Io => "io",
            serde_json::error::Category::Syntax => "syntax",
            serde_json::error::Category::Data => "data",
            serde_json::error::Category::Eof => "eof",
        };
        return Some(Cow::Owned(format!(
            "json:{category}@{}:{}",
            error.line(),
            error.column()
        )));
    }
    if error.is::<std::str::Utf8Error>() || error.is::<std::string::FromUtf8Error>() {
        return Some(Cow::Borrowed("utf8:invalid"));
    }
    if error.is::<std::num::TryFromIntError>() {
        return Some(Cow::Borrowed("int:out_of_range"));
    }
    if let Some(error) = error.downcast_ref::<std::num::ParseIntError>() {
        return Some(Cow::Owned(format!("int:{:?}", error.kind())));
    }
    if error.is::<std::array::TryFromSliceError>() {
        return Some(Cow::Borrowed("slice:length"));
    }
    if error.is::<std::time::SystemTimeError>() {
        return Some(Cow::Borrowed("clock:before_epoch"));
    }
    if error.is::<std::sync::mpsc::RecvError>() {
        return Some(Cow::Borrowed("channel:closed"));
    }
    if let Some(error) = error.downcast_ref::<std::sync::mpsc::RecvTimeoutError>() {
        return Some(Cow::Borrowed(match error {
            std::sync::mpsc::RecvTimeoutError::Timeout => "channel:timeout",
            std::sync::mpsc::RecvTimeoutError::Disconnected => "channel:closed",
        }));
    }
    if let Some(error) = error.downcast_ref::<std::sync::mpsc::TryRecvError>() {
        return Some(Cow::Borrowed(match error {
            std::sync::mpsc::TryRecvError::Empty => "channel:empty",
            std::sync::mpsc::TryRecvError::Disconnected => "channel:closed",
        }));
    }
    None
}

fn short_type_name(name: &'static str) -> &'static str {
    // Keep the last path segment of the outer type; generic parameters are
    // dropped because they may name unrelated caller types.
    let outer = name.split('<').next().unwrap_or(name);
    outer.rsplit("::").next().unwrap_or(outer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn chain(error: &(dyn Error + 'static)) -> Vec<String> {
        let mut texts = Vec::new();
        let mut current = Some(error);
        while let Some(error) = current {
            texts.push(error.to_string());
            current = error.source();
        }
        texts
    }

    #[test]
    fn poisoned_lock_keeps_code_and_sanitized_cause() {
        let mutex = Arc::new(Mutex::new(0_u8));
        let poisoner = Arc::clone(&mutex);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().unwrap();
            panic!("poison fixture");
        })
        .join();
        let error = mutex
            .lock()
            .map(|_| ())
            .map_err(coded("FIXTURE_UNAVAILABLE"))
            .unwrap_err();
        assert_eq!(error.to_string(), "FIXTURE_UNAVAILABLE");
        assert_eq!(chain(&error), ["FIXTURE_UNAVAILABLE", "lock:poisoned"]);
    }

    #[test]
    fn io_cause_reports_kind_without_custom_payload() {
        let source = std::io::Error::other("/home/private-user/secret-token");
        let error = coded::<std::io::Error>("FIXTURE_IO")(source);
        assert_eq!(error.cause().kind(), "io:Other");
        assert!(!format!("{error:?}").contains("private-user"));
        let os = coded::<std::io::Error>("FIXTURE_IO")(std::io::Error::from_raw_os_error(2));
        assert_eq!(os.cause().kind(), "io:NotFound:os=2");
    }

    #[test]
    fn json_cause_reports_category_without_values() {
        let source = serde_json::from_str::<u8>("\"private-sentinel\"").unwrap_err();
        let error = coded::<serde_json::Error>("FIXTURE_JSON")(source);
        assert_eq!(error.cause().kind(), "json:data@1:18");
        assert!(!format!("{error:?}").contains("private-sentinel"));
    }

    #[test]
    fn type_erased_chain_reports_first_known_cause_only() {
        #[derive(Debug)]
        struct Wrapper(std::io::Error);
        impl fmt::Display for Wrapper {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("private-wrapper-message")
            }
        }
        impl Error for Wrapper {
            fn source(&self) -> Option<&(dyn Error + 'static)> {
                Some(&self.0)
            }
        }
        let source: Box<dyn Error + Send + Sync> = Box::new(Wrapper(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        )));
        let error = coded_chain::<Box<dyn Error + Send + Sync>>("FIXTURE_CHAIN")(source);
        assert_eq!(chain(&error), ["FIXTURE_CHAIN", "io:PermissionDenied"]);
        let opaque: Box<dyn Error + Send + Sync> = "private-opaque-message".into();
        let error = coded_chain::<Box<dyn Error + Send + Sync>>("FIXTURE_CHAIN")(opaque);
        assert_eq!(chain(&error), ["FIXTURE_CHAIN", "unclassified:error"]);
    }

    #[test]
    fn unknown_static_error_reports_type_name_only() {
        #[derive(Debug)]
        struct FixtureFailure;
        impl fmt::Display for FixtureFailure {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("private-fixture-message")
            }
        }
        impl Error for FixtureFailure {}
        let error = coded_error::<FixtureFailure>("FIXTURE_TYPE")(FixtureFailure);
        assert_eq!(error.cause().kind(), "type:FixtureFailure");
    }

    #[test]
    fn kind_text_never_looks_like_a_stable_code() {
        for kind in [
            "lock:poisoned",
            "io:NotFound:os=2",
            "json:data@1:18",
            "type:X",
        ] {
            assert!(
                !kind
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            );
        }
    }
}
