use kcoder_types::Usage;

/// Accumulated API token usage across all streaming turns.
#[derive(Debug, Clone, Default)]
pub struct UsageAccumulator {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub total_tokens: u64,
}

impl UsageAccumulator {
    pub fn add(&mut self, usage: &Usage) {
        self.total_tokens = self.total_tokens.saturating_add(Self::usage_total(usage));
        self.input_tokens += u64::from(usage.input_tokens);
        self.output_tokens += u64::from(usage.output_tokens);
        if let Some(n) = usage.cache_creation_input_tokens {
            self.cache_creation_input_tokens += u64::from(n);
        }
        if let Some(n) = usage.cache_read_input_tokens {
            self.cache_read_input_tokens += u64::from(n);
        }
        if let Some(iterations) = &usage.iterations {
            for it in iterations {
                self.input_tokens += u64::from(it.input_tokens);
                self.output_tokens += u64::from(it.output_tokens);
            }
        }
    }

    pub fn total(&self) -> u64 {
        self.total_tokens
    }

    pub fn usage_total(usage: &Usage) -> u64 {
        if let Some(total) = usage.total_tokens {
            return u64::from(total);
        }
        let mut total = u64::from(usage.input_tokens) + u64::from(usage.output_tokens);
        total = total
            .saturating_add(u64::from(
                usage.cache_creation_input_tokens.unwrap_or_default(),
            ))
            .saturating_add(u64::from(usage.cache_read_input_tokens.unwrap_or_default()));
        if let Some(iterations) = &usage.iterations {
            for it in iterations {
                total = total
                    .saturating_add(u64::from(it.input_tokens))
                    .saturating_add(u64::from(it.output_tokens));
            }
        }
        total
    }

    pub fn format(&self) -> String {
        let mut lines = vec![
            format!("Input tokens:  {}", self.input_tokens),
            format!("Output tokens: {}", self.output_tokens),
            format!("Total tokens:  {}", self.total()),
        ];
        if self.cache_creation_input_tokens > 0 {
            lines.push(format!(
                "Cache creation input tokens: {}",
                self.cache_creation_input_tokens
            ));
        }
        if self.cache_read_input_tokens > 0 {
            lines.push(format!(
                "Cache read input tokens:     {}",
                self.cache_read_input_tokens
            ));
        }
        lines.join("\n")
    }
}

pub(super) fn merge_stream_usage(current: &mut Option<Usage>, incoming: Usage) {
    let Some(usage) = current.as_mut() else {
        *current = Some(incoming);
        return;
    };

    // An Anthropic-compatible gateway may report a provisional input total in
    // `message_start`, then an authoritative cached/non-cached split in `message_delta`.
    // Taking per-field maxima would synthesize a total never reported by the provider.
    // Once a snapshot contains cache fields, including explicit zeroes, treat the full
    // input split as authoritative. Output remains cumulative.
    let incoming_has_input_breakdown = incoming.cache_creation_input_tokens.is_some()
        || incoming.cache_read_input_tokens.is_some();
    let current_has_input_breakdown =
        usage.cache_creation_input_tokens.is_some() || usage.cache_read_input_tokens.is_some();
    let incoming_total_tokens = incoming.total_tokens;
    if incoming_has_input_breakdown {
        usage.input_tokens = incoming.input_tokens;
        usage.cache_creation_input_tokens = incoming.cache_creation_input_tokens;
        usage.cache_read_input_tokens = incoming.cache_read_input_tokens;
        usage.total_tokens = incoming_total_tokens;
    } else if !current_has_input_breakdown {
        usage.input_tokens = usage.input_tokens.max(incoming.input_tokens);
    }
    usage.output_tokens = usage.output_tokens.max(incoming.output_tokens);
    if !incoming_has_input_breakdown && let Some(incoming_total_tokens) = incoming_total_tokens {
        usage.total_tokens = Some(
            usage
                .total_tokens
                .unwrap_or_default()
                .max(incoming_total_tokens),
        );
    }
    if usage.total_tokens.is_none() && (incoming_has_input_breakdown || current_has_input_breakdown)
    {
        usage.total_tokens = Some(
            usage
                .input_tokens
                .saturating_add(usage.output_tokens)
                .saturating_add(usage.cache_creation_input_tokens.unwrap_or_default())
                .saturating_add(usage.cache_read_input_tokens.unwrap_or_default()),
        );
    }
    if incoming.iterations.is_some() {
        usage.iterations = incoming.iterations;
    }
}

/// Compute the per-response usage increment carried by an incoming usage
/// snapshot. Providers report usage cumulatively within a response (Gemini
/// sends running totals in every chunk; Anthropic/OpenAI send one final
/// snapshot), so charging each raw snapshot would multiply-count cumulative
/// values. Only the increment over the largest snapshot already merged for
/// this response may be charged.
pub(super) fn usage_increment(previous: Option<&Usage>, incoming: &Usage) -> Usage {
    let subtract = |new: u32, old: u32| new.saturating_sub(old);
    let subtract_opt = |new: Option<u32>, old: Option<u32>| {
        new.map(|value| value.saturating_sub(old.unwrap_or(0)))
    };
    Usage {
        input_tokens: subtract(
            incoming.input_tokens,
            previous.map(|p| p.input_tokens).unwrap_or(0),
        ),
        output_tokens: subtract(
            incoming.output_tokens,
            previous.map(|p| p.output_tokens).unwrap_or(0),
        ),
        total_tokens: incoming.total_tokens.map(|value| {
            value.saturating_sub(previous.and_then(|p| p.total_tokens).unwrap_or_default())
        }),
        cache_creation_input_tokens: subtract_opt(
            incoming.cache_creation_input_tokens,
            previous.and_then(|p| p.cache_creation_input_tokens),
        ),
        cache_read_input_tokens: subtract_opt(
            incoming.cache_read_input_tokens,
            previous.and_then(|p| p.cache_read_input_tokens),
        ),
        // Iteration breakdowns are set-once snapshots, not running totals.
        iterations: if previous.and_then(|p| p.iterations.as_ref()).is_some() {
            None
        } else {
            incoming.iterations.clone()
        },
    }
}

#[cfg(test)]
mod usage_increment_tests {
    use kcoder_types::Usage;

    fn usage(input: u32, output: u32) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
            total_tokens: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            iterations: None,
        }
    }

    #[test]
    fn increment_charges_only_new_tokens_for_cumulative_snapshots() {
        // Gemini-style running totals: each chunk reports the total so far.
        let first = super::usage_increment(None, &usage(100, 10));
        assert_eq!((first.input_tokens, first.output_tokens), (100, 10));

        let second = super::usage_increment(Some(&usage(100, 10)), &usage(100, 25));
        assert_eq!(
            (second.input_tokens, second.output_tokens),
            (0, 15),
            "cumulative snapshots must only charge the delta"
        );

        // Final snapshot equal to the previous one: nothing new to charge.
        let third = super::usage_increment(Some(&usage(100, 25)), &usage(100, 25));
        assert_eq!((third.input_tokens, third.output_tokens), (0, 0));
    }

    #[test]
    fn increment_never_goes_negative_on_out_of_order_snapshots() {
        let increment = super::usage_increment(Some(&usage(200, 50)), &usage(100, 10));
        assert_eq!((increment.input_tokens, increment.output_tokens), (0, 0));
    }

    #[test]
    fn increment_prefers_provider_total_when_available() {
        let mut previous = usage(1_000, 100);
        previous.total_tokens = Some(1_100);
        let mut incoming = usage(1_200, 150);
        incoming.total_tokens = Some(1_350);

        let increment = super::usage_increment(Some(&previous), &incoming);

        assert_eq!(increment.total_tokens, Some(250));
        assert_eq!(super::UsageAccumulator::usage_total(&increment), 250);
    }

    #[test]
    fn usage_total_derives_anthropic_cache_components_without_provider_total() {
        let mut snapshot = usage(5_825, 1_518);
        snapshot.cache_creation_input_tokens = Some(0);
        snapshot.cache_read_input_tokens = Some(33_792);

        assert_eq!(super::UsageAccumulator::usage_total(&snapshot), 41_135);
    }
}
