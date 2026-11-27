//! Stable provider-facing names for MCP tool registration and migration.

pub fn mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    let server = sanitize_tool_name_part(server_name, "server");
    let tool = sanitize_tool_name_part(tool_name, "tool");
    let name = format!("mcp__{}__{}", server, tool);
    // Strict providers (Anthropic) cap tool names at 64 characters; an
    // overlong name rejects the whole request. Truncate with a stable hash
    // suffix so two tools that only differ past the cut point don't collapse
    // into the same registry entry.
    const MAX_LEN: usize = 64;
    if name.len() <= MAX_LEN {
        return name;
    }
    let hash = stable_name_hash(&name);
    // Fixed syntax and hash consume 24 bytes:
    // `mcp__` (5) + `__` (2) + `_` (1) + 16 hex digits. The sanitized
    // components are ASCII, so an 18/22 split uses the remaining 40 bytes
    // exactly and can never exceed MAX_LEN.
    let server_part: String = server.chars().take(18).collect();
    let tool_part: String = tool.chars().take(22).collect();
    format!("mcp__{}__{}_{:016x}", server_part, tool_part, hash)
}

/// FNV-1a 64-bit: stable across runs, no extra dependencies.
fn stable_name_hash(name: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in name.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn sanitize_tool_name_part(value: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut previous_was_separator = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            ch
        } else {
            '_'
        };
        if next == '_' {
            if previous_was_separator {
                continue;
            }
            previous_was_separator = true;
        } else {
            previous_was_separator = false;
        }
        out.push(next);
    }
    let out = out.trim_matches('_');
    if out.is_empty() {
        fallback.to_string()
    } else {
        out.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_tool_name_is_namespaced_to_avoid_builtin_collisions() {
        assert_eq!(mcp_tool_name("files", "read"), "mcp__files__read");
    }

    #[test]
    fn mcp_tool_name_sanitizes_invalid_characters() {
        assert_eq!(
            mcp_tool_name("local server", "shell/run"),
            "mcp__local_server__shell_run"
        );
        assert_eq!(mcp_tool_name("!!!", "???"), "mcp__server__tool");
    }

    #[test]
    fn mcp_tool_name_stays_within_provider_limit_and_avoids_collisions() {
        let long_server = "a".repeat(60);
        let long_tool_a = format!("{}one", "read_file_version_".repeat(5));
        let long_tool_b = format!("{}two", "read_file_version_".repeat(5));
        let name_a = mcp_tool_name(&long_server, &long_tool_a);
        let name_b = mcp_tool_name(&long_server, &long_tool_b);
        assert!(
            name_a.len() <= 64,
            "name exceeds the Anthropic tool name limit: {name_a}"
        );
        assert_eq!(name_a.len(), 64, "the truncation budget should be exact");
        assert!(
            name_a.starts_with("mcp__") && name_b.starts_with("mcp__"),
            "namespace prefix must be preserved"
        );
        assert_ne!(name_a, name_b, "truncated names must keep a unique suffix");
    }

    #[test]
    fn mcp_tool_name_hashes_the_full_sanitized_name() {
        let prefix = "a".repeat(48);
        let name_a = mcp_tool_name("server", &format!("{prefix}x"));
        let name_b = mcp_tool_name("server", &format!("{prefix}y"));

        assert_ne!(
            name_a, name_b,
            "differences after the display prefix must survive in the hash"
        );
        assert!(name_a.len() <= 64 && name_b.len() <= 64);
    }

    #[test]
    fn mcp_tool_name_avoids_known_32_bit_hash_collision() {
        let shared = "x".repeat(40);
        let name_a = mcp_tool_name("server", &format!("{shared}xvUzwImeobPC"));
        let name_b = mcp_tool_name("server", &format!("{shared}hBQDcdtkeIlp"));

        assert_ne!(name_a, name_b, "known FNV-1a 32-bit collision");
        assert!(name_a.len() <= 64 && name_b.len() <= 64);
    }
}
