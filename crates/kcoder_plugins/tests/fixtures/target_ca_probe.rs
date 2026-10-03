// Invoked only by the owned local-TLS E2E fixture, never installed as a CLI.
use anyhow::{Context, Result};
use kcoder_plugins::{PluginCancellationToken, PluginManager};
use std::path::PathBuf;
fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().context("mode")?;
    let root = PathBuf::from(args.next().context("private fixture root")?);
    let source = args.next().context("fixture source")?;
    let manager = PluginManager::open(&root.join("plugin_store"))?;
    match mode.as_str() {
        "git" => {
            manager.marketplace_add_git_with_cancellation(
                &source,
                Some("tls-market"),
                &root,
                true,
                &PluginCancellationToken::default(),
            )?;
        }
        "npm" => {
            manager.marketplace_add("tls-npm", &PathBuf::from(&source))?;
        }
        _ => anyhow::bail!("unsupported fixture mode"),
    }
    let (market, plugin) = if mode == "git" {
        ("tls-market", "git-demo")
    } else {
        ("tls-npm", "fixture-plugin")
    };
    let installed = manager.install_from_marketplace(&root, true, market, plugin)?;
    assert!(
        installed
            .root(manager.store().root())
            .join(".codex-plugin/plugin.json")
            .is_file()
    );
    if mode == "git" {
        let market = manager
            .marketplace_list(&root, true)?
            .marketplaces
            .into_iter()
            .find(|market| market.id == "tls-market")
            .context("imported marketplace")?;
        assert_eq!(market.source_url.as_deref(), Some(source.as_str()));
    }
    println!("{}", serde_json::to_string(&installed)?);
    Ok(())
}
