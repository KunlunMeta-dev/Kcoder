//! Shared offline lexical retrieval: one tokenizer and one BM25F ranker.
//!
//! DiscoverSkills ranks installed skills and `tool_search` ranks deferred tools with the
//! same mechanism, so both catalogs agree on stemming, stopwords, CJK segmentation,
//! synonym folding, saturation, length normalization and deterministic ordering. Callers
//! choose only their fields and weights.

use std::collections::{BTreeMap, BTreeSet};

/// Common English stopwords filtered out so verbose descriptions do not rack
/// up score on filler words like "a", "to", "use", "when".
const STOPWORDS: &[&str] = &[
    "a", "an", "the", "in", "on", "at", "by", "to", "of", "for", "with", "from", "into", "and",
    "or", "is", "are", "be", "been", "as", "it", "its", "this", "that", "use", "when", "how",
    "what", "which", "you", "your", "i", "we", "they", "them", "do", "does", "can", "will", "if",
    "then", "than", "so", "not", "no",
];

/// BM25 term-frequency saturation: repeated matches add progressively less.
const BM25_K1: f64 = 1.2;
/// BM25 length normalization: matches in a long field count less than the same
/// matches in a short one, so verbose descriptions do not win by length alone.
const BM25_B: f64 = 0.75;

/// Lowercased, stemmed, stopword-free terms; CJK runs become lexicon words plus bigrams.
pub(crate) fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut ideographs = Vec::new();
    for c in text.to_lowercase().chars() {
        if is_ideograph(c) {
            flush_word(&mut word, &mut tokens);
            ideographs.push(c);
        } else if c.is_alphanumeric() {
            flush_ideographs(&mut ideographs, &mut tokens);
            word.push(c);
        } else {
            flush_word(&mut word, &mut tokens);
            flush_ideographs(&mut ideographs, &mut tokens);
        }
    }
    flush_word(&mut word, &mut tokens);
    flush_ideographs(&mut ideographs, &mut tokens);
    tokens
}

fn flush_word(word: &mut String, tokens: &mut Vec<String>) {
    if word.is_empty() {
        return;
    }
    let token = stem(word);
    word.clear();
    if !token.is_empty() && !STOPWORDS.contains(&token.as_str()) {
        tokens.push(canonical(&token).unwrap_or(&token).to_string());
    }
}

/// CJK text has no word separators, so a whole clause would otherwise become one
/// token that no query matches. Known [`CJK_LEXICON`] words are cut out first by
/// forward maximum matching; the remaining segments become overlapping character
/// bigrams, so a four-character "Feishu approval" query yields the lexicon term
/// for "Feishu" plus the "approval" bigram without a full segmentation
/// dictionary or spurious pairs spanning a known word boundary.
fn flush_ideographs(run: &mut Vec<char>, tokens: &mut Vec<String>) {
    // A lone character is kept only when it is the whole run, not a leftover.
    let whole_single = run.len() == 1;
    let mut start = 0;
    let mut index = 0;
    while index < run.len() {
        match lexicon_word_at(&run[index..]) {
            Some((length, canonical)) => {
                push_segment(&run[start..index], whole_single, tokens);
                if let Some(canonical) = canonical {
                    tokens.push(canonical.to_string());
                }
                index += length;
                start = index;
            }
            None => index += 1,
        }
    }
    push_segment(&run[start..], whole_single, tokens);
    run.clear();
}

/// The longest [`CJK_LEXICON`] word starting the slice, as (chars, canonical term).
fn lexicon_word_at(chars: &[char]) -> Option<(usize, Option<&'static str>)> {
    CJK_LEXICON
        .iter()
        .filter_map(|(word, canonical)| {
            let length = word.chars().count();
            (length <= chars.len() && word.chars().eq(chars[..length].iter().copied()))
                .then_some((length, *canonical))
        })
        .max_by_key(|(length, _)| *length)
}

fn push_segment(segment: &[char], whole_single: bool, tokens: &mut Vec<String>) {
    match segment.len() {
        0 => {}
        1 if whole_single => tokens.push(segment[0].to_string()),
        1 => {}
        _ => tokens.extend(
            segment
                .windows(2)
                .map(|pair| pair.iter().collect::<String>()),
        ),
    }
}

/// CJK words recognized before bigramming. `Some` folds a synonym into one
/// canonical term on both the query and the document side, like stemming; `None`
/// marks a function word that only separates content and is never indexed,
/// mirroring [`STOPWORDS`].
///
/// Folding here rewrites document tokens too, so an entry changes every catalog's
/// scores. Query-only expansions (such as `tool_search`'s Chinese-to-English
/// capability words) belong to the caller instead.
const CJK_LEXICON: &[(&str, Option<&str>)] = &[
    ("飞书", Some("lark")),
    ("一个", None),
    ("一下", None),
    ("一些", None),
    ("一条", None),
    ("一篇", None),
    ("一份", None),
    ("帮我", None),
    ("请帮", None),
    ("给我", None),
    ("我们", None),
    ("我在", None),
    ("我的", None),
    ("你的", None),
    ("这个", None),
    ("那个", None),
    ("这些", None),
    ("那些", None),
    ("这篇", None),
    ("什么", None),
    ("怎么", None),
    ("如何", None),
    ("可以", None),
    ("的", None),
    ("了", None),
    ("吗", None),
    ("呢", None),
    ("吧", None),
];

/// Latin-script synonyms folded the same way. Lark and Feishu are two names of
/// one platform; the bundled `lark-*` skills mostly describe it as 飞书.
fn canonical(token: &str) -> Option<&'static str> {
    match token {
        "feishu" => Some("lark"),
        _ => None,
    }
}

fn is_ideograph(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF // Hiragana and Katakana
        | 0x3400..=0x4DBF // CJK Extension A
        | 0x4E00..=0x9FFF // CJK Unified Ideographs
        | 0xAC00..=0xD7AF // Hangul syllables
        | 0xF900..=0xFAFF // CJK Compatibility Ideographs
        | 0x20000..=0x2FFFF) // CJK Extensions B and later
}

/// Very small suffix stemmer: strips a few common English suffixes so that
/// "testing" -> "test", "patterns" -> "pattern", "runs" -> "run", "running"
/// -> "run". This is not a full Porter stemmer; it only collapses the most
/// frequent inflections that break exact term matching.
pub(crate) fn stem(word: &str) -> String {
    // Order matters: try longer suffixes first.
    for suffix in ["ingly", "edly", "ing", "ed", "es", "s"] {
        if let Some(stripped) = word.strip_suffix(suffix) {
            // Keep at least 3 chars so we don't reduce "is" -> "" etc.
            if stripped.len() >= 3 {
                // Collapse a doubled final consonant left by stripping "ing"/"ed"
                // (e.g. "running" -> "runn" -> "run", "stopped" -> "stopp" -> "stop").
                let collapsed = strip_doubled_final_consonant(stripped);
                return collapsed;
            }
        }
    }
    word.to_string()
}

/// If `word` ends with the same consonant twice, drop one copy. Used to tidy
/// up after suffix stripping (running->runn->run). Only applies when the
/// result stays at least 3 chars.
fn strip_doubled_final_consonant(word: &str) -> String {
    let chars: Vec<char> = word.chars().collect();
    if chars.len() >= 4 {
        let last = chars[chars.len() - 1];
        let prev = chars[chars.len() - 2];
        // Only collapse actual letter doubles, and only consonants (vowels like
        // "ee"/"oo" are usually meaningful, e.g. "feed" -> "fee" would be wrong).
        if last == prev && !is_vowel(last) {
            let trimmed: String = chars[..chars.len() - 1].iter().collect();
            return trimmed;
        }
    }
    word.to_string()
}

fn is_vowel(c: char) -> bool {
    matches!(c, 'a' | 'e' | 'i' | 'o' | 'u')
}

/// Ranks documents with BM25F: each of the `F` token fields is length-normalized
/// against its average over `documents`, weighted, and summed before one
/// saturation per query term. IDF is computed over `documents` only. Query terms
/// are deduplicated and visited in sorted order, so equal inputs always produce
/// identical scores regardless of document order.
///
/// Returns `(document index, score)` for every positive score, best first; equal
/// scores fall back to ascending `key` order.
pub(crate) fn bm25f_rank<const F: usize, K: Ord>(
    documents: &[[Vec<String>; F]],
    weights: [f64; F],
    query_terms: &[String],
    key: impl Fn(usize) -> K,
) -> Vec<(usize, f64)> {
    let query_set = query_terms
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if query_set.is_empty() || documents.is_empty() {
        return Vec::new();
    }
    let n = documents.len() as f64;
    // Integer totals keep the averages independent of document order.
    let mut total_lengths = [0usize; F];
    for fields in documents {
        for (total, field) in total_lengths.iter_mut().zip(fields) {
            *total += field.len();
        }
    }
    let average_lengths = total_lengths.map(|total| total as f64 / n);
    // One pass per field counts only query terms, so long catalogs stay linear.
    let term_counts = documents
        .iter()
        .map(|fields| {
            fields.each_ref().map(|field| {
                let mut counts = BTreeMap::<&str, usize>::new();
                for token in field {
                    if let Some(term) = query_set.get(token.as_str()) {
                        *counts.entry(*term).or_default() += 1;
                    }
                }
                counts
            })
        })
        .collect::<Vec<_>>();
    let document_frequency = query_set
        .iter()
        .map(|term| {
            let count = term_counts
                .iter()
                .filter(|fields| fields.iter().any(|counts| counts.contains_key(term)))
                .count();
            (*term, count as f64)
        })
        .collect::<BTreeMap<_, _>>();

    let mut scored = documents
        .iter()
        .zip(&term_counts)
        .enumerate()
        .map(|(index, (fields, counts))| {
            let mut score = 0.0;
            for term in &query_set {
                let mut frequency = 0.0;
                for (((field, counts), weight), average) in
                    fields.iter().zip(counts).zip(weights).zip(average_lengths)
                {
                    let matches = counts.get(term).copied().unwrap_or(0);
                    if matches > 0 {
                        let relative = field.len() as f64 / average.max(f64::MIN_POSITIVE);
                        frequency += weight * matches as f64 / (1.0 - BM25_B + BM25_B * relative);
                    }
                }
                if frequency == 0.0 {
                    continue;
                }
                let df = document_frequency[term];
                let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
                score += idf * frequency * (BM25_K1 + 1.0) / (frequency + BM25_K1);
            }
            (index, score)
        })
        .filter(|(_, score)| *score > 0.0)
        .collect::<Vec<_>>();

    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| key(a.0).cmp(&key(b.0)))
    });
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(name: &str, prose: &str) -> [Vec<String>; 2] {
        [tokenize(name), tokenize(prose)]
    }

    #[test]
    fn search_rank_breaks_ties_by_key_and_ignores_document_order() {
        let names = ["beta", "alpha", "gamma"];
        let forward = names.map(|name| document(name, "export calendar events"));
        let ranked = bm25f_rank(&forward, [3.0, 1.0], &tokenize("calendar"), |index| {
            names[index]
        });
        let order = ranked
            .iter()
            .map(|(index, _)| names[*index])
            .collect::<Vec<_>>();
        assert_eq!(order, ["alpha", "beta", "gamma"]);
        assert!(ranked.windows(2).all(|pair| pair[0].1 == pair[1].1));
    }

    #[test]
    fn search_rank_weights_fields_and_skips_unmatched_documents() {
        let documents = [
            document("calendar", "Manage events"),
            document("notes", "Mentions calendar once"),
            document("deploy", "Ship services"),
        ];
        let ranked = bm25f_rank(&documents, [3.0, 1.0], &tokenize("calendar"), |index| index);
        assert_eq!(
            ranked.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
            [0, 1]
        );
        assert!(ranked[0].1 > ranked[1].1);
        assert!(bm25f_rank(&documents, [3.0, 1.0], &[], |index| index).is_empty());
        let empty: [[Vec<String>; 2]; 0] = [];
        assert!(bm25f_rank(&empty, [3.0, 1.0], &tokenize("calendar"), |index| index).is_empty());
    }
}
