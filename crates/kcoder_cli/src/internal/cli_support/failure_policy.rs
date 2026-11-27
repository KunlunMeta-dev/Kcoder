pub fn is_retryable_failure(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    [
        "stream idle",
        "timeout",
        "timed out",
        "rate limit",
        "overload",
        "429",
        "529",
        "500",
        "502",
        "503",
        "504",
        "connection",
        "network",
        "temporarily",
        "unavailable",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

pub fn recommended_retry_after_ms(error: &str) -> Option<u64> {
    if !is_retryable_failure(error) {
        return None;
    }
    let lower = error.to_ascii_lowercase();
    if lower.contains("429") || lower.contains("rate limit") || lower.contains("too many requests")
    {
        Some(30_000)
    } else if lower.contains("529") || lower.contains("overload") {
        Some(5_000)
    } else {
        Some(1_000)
    }
}
