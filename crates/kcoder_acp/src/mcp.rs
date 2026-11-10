//! Validate the client's stdio descriptions without echoing private launch data.
use agent_client_protocol::schema::v1::McpServer;
use anyhow::{Result, ensure};
use kcoder_app_protocol::{THREAD_MCP_SERVER_LIMIT, ThreadMcpServerV1};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn stdio_servers(servers: Vec<McpServer>) -> Result<Vec<ThreadMcpServerV1>> {
    ensure!(
        servers.len() <= THREAD_MCP_SERVER_LIMIT,
        "session/new.mcpServers limit is 16"
    );
    let mut names = BTreeSet::new();
    servers
        .into_iter()
        .map(|server| {
            let McpServer::Stdio(server) = server else {
                anyhow::bail!("Only stdio client MCP servers are supported");
            };
            ensure!(
                server.command.is_absolute(),
                "mcpServers.command must be an absolute executable path"
            );
            let command = server
                .command
                .into_os_string()
                .into_string()
                .map_err(|_| anyhow::anyhow!("mcpServers.command must be valid Unicode"))?;
            ensure!(server.env.len() <= 32, "mcpServers.env limit is 32");
            let mut env = BTreeMap::new();
            let mut env_names = BTreeSet::new();
            for entry in server.env {
                let name = if cfg!(windows) {
                    entry.name.to_ascii_lowercase()
                } else {
                    entry.name.clone()
                };
                ensure!(env_names.insert(name), "Duplicate mcpServers.env name");
                env.insert(entry.name, entry.value);
            }
            let server = ThreadMcpServerV1 {
                name: server.name,
                command,
                args: server.args,
                env,
            };
            server.validate().map_err(anyhow::Error::msg)?;
            ensure!(
                names.insert(server.name.clone()),
                "Duplicate mcpServers.name"
            );
            Ok(server)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{EnvVariable, McpServerStdio};
    #[test]
    fn private_environment_is_preserved_and_duplicate_values_are_never_overwritten() {
        let executable = std::env::current_exe().unwrap();
        let value = McpServerStdio::new("editor", &executable)
            .env(vec![EnvVariable::new("TOKEN", "private-value")]);
        let servers = stdio_servers(vec![McpServer::Stdio(value.clone())]).unwrap();
        assert_eq!(servers[0].env["TOKEN"], "private-value");
        assert!(!format!("{:?}", servers).contains("private-value"));
        assert!(
            stdio_servers(vec![
                McpServer::Stdio(value.clone()),
                McpServer::Stdio(value.clone())
            ])
            .is_err()
        );
        let repeated = value.env(vec![
            EnvVariable::new("TOKEN", "first"),
            EnvVariable::new("TOKEN", "second"),
        ]);
        let error = stdio_servers(vec![McpServer::Stdio(repeated)])
            .unwrap_err()
            .to_string();
        assert!(!error.contains("first"));
        assert!(!error.contains("second"));
    }
}
