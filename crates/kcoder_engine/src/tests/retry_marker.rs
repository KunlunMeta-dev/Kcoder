#[test]
fn anthropic_overload_errors_are_retryable() {
    assert!(super::is_retryable_error(&"529"));
    assert!(super::is_retryable_error(
        &"API error (overloaded_error): Overloaded"
    ));
    assert!(super::is_retryable_error(&"rate limit exceeded"));
    assert!(!super::is_retryable_error(&"invalid_request_error"));
}

#[test]
fn rate_limit_errors_are_detected() {
    assert!(super::is_rate_limit_error(&"429"));
    assert!(super::is_rate_limit_error(
        &"API error (429 Too Many Requests): request_id=abc"
    ));
    assert!(super::is_rate_limit_error(&"rate limit exceeded"));
    assert!(super::is_rate_limit_error(&"rate_limit_error"));
    assert!(!super::is_rate_limit_error(&"529 overloaded"));
    assert!(!super::is_rate_limit_error(&"invalid_request_error"));
}

#[test]
fn server_retry_after_parses_seconds_hint() {
    assert_eq!(
        super::server_retry_after(&"request_id=abc; retry_after=30"),
        Some(std::time::Duration::from_secs(30))
    );
    assert_eq!(
        super::server_retry_after(&"retry-after: 2.5"),
        Some(std::time::Duration::from_millis(2500))
    );
    assert_eq!(
        super::server_retry_after(&"Retry After 10 seconds"),
        Some(std::time::Duration::from_secs(10))
    );
    assert_eq!(super::server_retry_after(&"no hint here"), None);
    // Missing digits, zero, and absurd values are rejected.
    assert_eq!(super::server_retry_after(&"retry_after="), None);
    assert_eq!(super::server_retry_after(&"retry_after=0"), None);
    assert_eq!(super::server_retry_after(&"retry_after=99999"), None);
}
