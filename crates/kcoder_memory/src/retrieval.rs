use crate::Memory;
use std::collections::HashSet;

/// A memory together with a relevance score.
#[derive(Debug, Clone)]
pub struct MemoryMatch {
    pub memory: Memory,
    pub score: f32,
}

/// Simple keyword-based ranker for memories.
pub struct SearchRanker;

impl SearchRanker {
    pub fn rank(memories: &[Memory], query: &str, recent_tools: &[String]) -> Vec<MemoryMatch> {
        let query_lower = query.to_lowercase();
        let query_terms: Vec<&str> = query_lower
            .split_whitespace()
            .filter(|t| t.len() > 2)
            .collect();
        let recent_set: HashSet<&str> = recent_tools.iter().map(|s| s.as_str()).collect();

        let mut scored: Vec<MemoryMatch> = memories
            .iter()
            .map(|m| {
                let text = format!("{} {} {}", m.category, m.fact, m.source).to_lowercase();
                let mut score = 0.0f32;

                // Exact query match is strongly weighted.
                if text.contains(&query_lower) {
                    score += 10.0;
                }

                // Term frequency.
                for term in &query_terms {
                    if text.contains(term) {
                        score += 1.0;
                    }
                }

                // Category match.
                if m.category.to_lowercase().contains(&query_lower) {
                    score += 2.0;
                }

                // Only keep memories that matched the query somehow.
                let matched = score > 0.0;

                if matched {
                    // Penalize reference-style memories for tools already in use.
                    if recent_set.contains(m.category.as_str()) {
                        score *= 0.7;
                    }

                    // Recency boost (newer memories score slightly higher).
                    score += (m.created_at as f32 / 1_000_000_000.0).min(1.0);
                }

                MemoryMatch {
                    memory: m.clone(),
                    score,
                }
            })
            .filter(|m| m.score > 0.0)
            .collect();

        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        scored
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem(fact: &str, category: &str) -> Memory {
        Memory {
            fact: fact.to_string(),
            category: category.to_string(),
            created_at: 0,
            source: "test".to_string(),
        }
    }

    #[test]
    fn ranks_exact_matches_higher() {
        let memories = vec![
            mem("I love Rust", "user"),
            mem("use Python for scripts", "project"),
            mem("Rust is fast", "reference"),
        ];
        let ranked = SearchRanker::rank(&memories, "Rust", &[]);
        assert!(!ranked.is_empty());
        assert!(ranked[0].memory.fact.contains("Rust"));
    }

    #[test]
    fn filters_irrelevant_memories() {
        let memories = vec![mem("use anyhow", "project")];
        let ranked = SearchRanker::rank(&memories, "Rust", &[]);
        assert!(ranked.is_empty());
    }

    #[test]
    #[ignore = "manual performance benchmark"]
    fn memory_retrieval_benchmark() {
        let memories = (0..50_000)
            .map(|idx| {
                let category = if idx % 5 == 0 { "project" } else { "user" };
                Memory {
                    fact: format!(
                        "memory {idx}: use Rust async tools for provider routing and terminal state"
                    ),
                    category: category.to_string(),
                    created_at: idx as u64,
                    source: "bench".to_string(),
                }
            })
            .collect::<Vec<_>>();
        let recent_tools = vec!["project".to_string(), "bash".to_string()];

        let started = std::time::Instant::now();
        let ranked = SearchRanker::rank(&memories, "Rust provider terminal", &recent_tools);
        let elapsed = started.elapsed();

        eprintln!(
            "memory_retrieval_benchmark: {} memories, {} matches, elapsed={elapsed:?}",
            memories.len(),
            ranked.len()
        );
        assert!(!ranked.is_empty());
    }
}
