#[test]
fn stream_usage_merge_keeps_cache_metrics_from_message_start() {
    let mut usage = Some(Usage {
        input_tokens: 64,
        output_tokens: 1,
        cache_creation_input_tokens: Some(256),
        cache_read_input_tokens: Some(4096),
        total_tokens: None,
        iterations: None,
    });

    merge_stream_usage(
        &mut usage,
        Usage {
            input_tokens: 0,
            output_tokens: 32,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            total_tokens: None,
            iterations: None,
        },
    );

    let usage = usage.unwrap();
    assert_eq!(usage.input_tokens, 64);
    assert_eq!(usage.output_tokens, 32);
    assert_eq!(usage.cache_creation_input_tokens, Some(256));
    assert_eq!(usage.cache_read_input_tokens, Some(4096));
}

#[test]
fn stream_usage_merge_prefers_final_input_breakdown_over_provisional_start_total() {
    let mut usage = Some(Usage {
        input_tokens: 65_174,
        output_tokens: 0,
        cache_creation_input_tokens: None,
        cache_read_input_tokens: None,
        total_tokens: None,
        iterations: None,
    });

    merge_stream_usage(
        &mut usage,
        Usage {
            input_tokens: 5_825,
            output_tokens: 1_518,
            cache_creation_input_tokens: Some(0),
            cache_read_input_tokens: Some(33_792),
            total_tokens: None,
            iterations: None,
        },
    );

    let usage = usage.unwrap();
    assert_eq!(usage.input_tokens, 5_825);
    assert_eq!(usage.output_tokens, 1_518);
    assert_eq!(usage.cache_creation_input_tokens, Some(0));
    assert_eq!(usage.cache_read_input_tokens, Some(33_792));
    assert_eq!(usage.total_tokens, Some(41_135));
}
