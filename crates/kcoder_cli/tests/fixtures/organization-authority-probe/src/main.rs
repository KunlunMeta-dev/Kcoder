//! Host acceptance driver importing the production authority implementation.
#[path = "../../../../src/app_server/integrations/core/native_context/organization.rs"]
mod organization;

fn main() -> anyhow::Result<()> {
    match organization::OrganizationAuthority::capture()? {
        Some(authority) => {
            authority.verify()?;
            if std::env::var_os("KCODER_ORGANIZATION_PROBE_MODEL").is_some() {
                use std::io::{BufRead, Write};
                let resource = std::env::var("KCODER_ORGANIZATION_PROBE_MODEL_RESOURCE")?;
                let model = || organization::OrganizationModelIdentity {
                    provider: "CaseProvider",
                    model: "ExactModel",
                    origin: "https://internal-model.example",
                    revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    resource: &resource,
                    workspace: "workspace:owned-model-probe",
                };
                authority.authorize_model(model(), "model-first")?;
                println!("organization-model-authority-verified");
                std::io::stdout().flush()?;
                let mut line = String::new();
                std::io::stdin().lock().read_line(&mut line)?;
                anyhow::ensure!(line == "check-original\n", "owned control required");
                authority.authorize_model(model(), "model-after-revocation")?;
                anyhow::bail!("revoked model unexpectedly authorized");
            }
            authority.authorize("read", "knowledge:owned", "native-probe-read")?;
            println!("organization-authority-verified");
            if std::env::var_os("KCODER_ORGANIZATION_PROBE_REPEAT").is_some() {
                authority.authorize("read", "knowledge:owned", "native-probe-read-again")?;
            }
        }
        None => {
            organization::OrganizationAuthority::verify_personal_launch()?;
            println!("personal-authority");
        }
    }
    Ok(())
}
