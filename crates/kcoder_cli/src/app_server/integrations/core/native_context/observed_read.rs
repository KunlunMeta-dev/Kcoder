//! Live host read ownership without creating an integration identity or another authority ledger.
use super::*;

pub struct ObservedReadScope {
    profile: PrivateDirectory,
    profile_path: PathBuf,
    profile_canonical: PathBuf,
    profile_identity: String,
    workspace: PrivateDirectory,
    workspace_path: PathBuf,
    workspace_identity: String,
    organization: Option<Arc<OrganizationAuthority>>,
    owner: IntegrationOwner,
    principal: String,
}

impl ObservedReadScope {
    /// Only the actual Engine's profile/cwd may reach this constructor.
    /// Ordinary ungoverned non-account readers retain their existing path.
    pub fn capture(profile_path: &Path, workspace_path: &Path) -> Result<Option<Self>> {
        let organization = OrganizationAuthority::capture()?;
        if organization.is_none() && std::env::var_os("KCODER_ACCOUNT_PRINCIPAL_ID").is_none() {
            return Ok(None);
        }
        ensure!(
            profile_path.is_absolute() && workspace_path.is_absolute(),
            "knowledge host paths must be absolute"
        );
        let principal =
            uuid::Uuid::parse_str(&std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID")?)?.to_string();
        let profile_canonical = profile_path.canonicalize()?;
        let profile = PrivateDirectory::open_existing(&profile_canonical)?;
        profile.verify_private_directory()?;
        let workspace = PrivateDirectory::open_existing(&workspace_path.canonicalize()?)?;
        if organization.is_some() {
            workspace.verify_private_directory()?;
        }
        let profile_identity = profile.directory_identity()?;
        let workspace_identity = workspace.directory_identity()?;
        let owner = IntegrationOwner {
            account_id: identity("account-profile", &profile_identity),
            target_id: identity("native-target", &profile_identity),
            workspace_id: IntegrationNullable::Value(identity(
                "native-workspace",
                &format!("{profile_identity}\0{workspace_identity}"),
            )),
            organization_id: organization
                .as_ref()
                .map(|authority| IntegrationNullable::Value(authority.organization_id.clone())),
        };
        if let Some(authority) = &organization {
            ensure!(
                principal == authority.principal_id,
                "ORGANIZATION_PROFILE_PRINCIPAL_CHANGED"
            );
        }
        let observed = Self {
            profile,
            profile_path: profile_path.to_path_buf(),
            profile_canonical,
            profile_identity,
            workspace,
            workspace_path: workspace_path.to_path_buf(),
            workspace_identity,
            organization,
            owner,
            principal,
        };
        observed.verify()?;
        Ok(Some(observed))
    }

    pub fn owner(&self) -> &IntegrationOwner {
        &self.owner
    }

    pub fn profile(&self) -> Result<&PrivateDirectory> {
        self.verify()?;
        Ok(&self.profile)
    }
    pub fn canonical_profile_path(&self) -> &Path {
        &self.profile_canonical
    }
    pub fn principal(&self) -> &str {
        &self.principal
    }

    pub fn verify(&self) -> Result<()> {
        self.profile.verify_private_directory()?;
        ensure!(
            self.profile.directory_identity()? == self.profile_identity
                && PrivateDirectory::open_existing(&self.profile_path)?.directory_identity()?
                    == self.profile_identity
                && self.workspace.directory_identity()? == self.workspace_identity
                && PrivateDirectory::open_existing(&self.workspace_path)?.directory_identity()?
                    == self.workspace_identity,
            "KNOWLEDGE_OBSERVED_HOST_CHANGED"
        );
        if let Some(authority) = &self.organization {
            self.workspace.verify_private_directory()?;
            authority.verify()?;
        } else {
            OrganizationAuthority::verify_personal_launch()?;
        }
        Ok(())
    }

    pub fn authorize_read(&self, resource: &str) -> Result<()> {
        self.verify()?;
        if let Some(authority) = &self.organization {
            authority.authorize("read", resource, &uuid::Uuid::new_v4().to_string())?;
        }
        self.verify()
    }
    pub fn authorize_write(&self, resource: &str) -> Result<()> {
        self.verify()?;
        if let Some(authority) = &self.organization {
            authority.authorize("write", resource, &uuid::Uuid::new_v4().to_string())?;
        }
        self.verify()
    }
}
