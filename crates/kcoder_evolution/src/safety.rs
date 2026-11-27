//! Copy detection between learned text and evidence (plan section 11).
//!
//! Learned content must be rewritten from patterns, never copied from the
//! user's work. Overlap is measured on character n-grams of normalized text
//! so it works for scripts without word separators (for example Chinese).

use std::collections::HashSet;

/// Character n-gram length used for overlap detection.
pub const COPY_NGRAM_CHARS: usize = 12;
/// Share of a text's n-grams found in evidence above which it is rejected.
pub const COPY_OVERLAP_MAX: f64 = 0.5;

fn normalized_chars(text: &str) -> Vec<char> {
    let mut chars = Vec::with_capacity(text.len());
    let mut space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !space && !chars.is_empty() {
                chars.push(' ');
            }
            space = true;
        } else {
            chars.extend(ch.to_lowercase());
            space = false;
        }
    }
    if chars.last() == Some(&' ') {
        chars.pop();
    }
    chars
}

fn ngrams(chars: &[char], n: usize) -> impl Iterator<Item = String> + '_ {
    chars.windows(n).map(|window| window.iter().collect())
}

/// Share of `candidate`'s character n-grams that also occur in any
/// `evidence` text. Texts shorter than one n-gram score 0.
pub fn ngram_overlap<'a>(candidate: &str, evidence: impl IntoIterator<Item = &'a str>) -> f64 {
    let candidate = normalized_chars(candidate);
    if candidate.len() < COPY_NGRAM_CHARS {
        return 0.0;
    }
    let mut known = HashSet::new();
    for text in evidence {
        let chars = normalized_chars(text);
        known.extend(ngrams(&chars, COPY_NGRAM_CHARS));
    }
    if known.is_empty() {
        return 0.0;
    }
    let mut total = 0usize;
    let mut shared = 0usize;
    for gram in ngrams(&candidate, COPY_NGRAM_CHARS) {
        total += 1;
        if known.contains(&gram) {
            shared += 1;
        }
    }
    if total == 0 {
        0.0
    } else {
        shared as f64 / total as f64
    }
}

/// Whether `candidate` copies evidence text beyond [`COPY_OVERLAP_MAX`].
pub fn copies_evidence<'a>(candidate: &str, evidence: impl IntoIterator<Item = &'a str>) -> bool {
    ngram_overlap(candidate, evidence) > COPY_OVERLAP_MAX
}
