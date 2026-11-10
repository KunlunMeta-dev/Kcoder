//! An authenticated member may deny only its own original signed channel grant.
use super::*;

/// No Serde constructor. Hosts must additionally hold the actual SDK/member/source.
pub struct NativeMemberSelfRevocation {
    issuer: String,
    directory: String,
    scope: IntegrationScope,
    reference: IntegrationRevisionRef,
    subject: AuthenticatedDelegationSubject,
    operation: String,
}

impl std::fmt::Debug for NativeMemberSelfRevocation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeMemberSelfRevocation { original_self_grant: verified }")
    }
}
impl NativeDelegationAuthority {
    fn member_self_grant<'a>(
        &self,
        journal: &'a Journal,
        scope: &IntegrationScope,
        reference: &IntegrationRevisionRef,
        subject: &AuthenticatedDelegationSubject,
    ) -> Result<&'a Grant> {
        scope.validate()?;
        reference.validate()?;
        subject.validate()?;
        let grant = journal
            .grants
            .get(&reference.id)
            .context("DELEGATION_NOT_FOUND")?;
        grant.proof.verify(&self.key)?;
        let claims = &grant.proof.claims;
        ensure!(IntegrationOwner::from(scope)==self.binding.owner
            &&claims.issuer_id==self.binding.issuer_id&&claims.owner==self.binding.owner
            &&claims.delegation_id==reference.id
            &&claims.purpose==kcoder_types::integrations::core::IntegrationDelegationPurpose::ChannelBinding
            &&claims.service_lease.is_none()&&claims.audience==scope.target_id
            &&claims.identity_generation==scope.identity_generation&&claims.target_revision==scope.target_revision
            &&claims.subject.same_principal(subject),"DELEGATION_SELF_MEMBER_MISMATCH");
        Ok(grant)
    }
    pub fn prepare_member_self_revocation(
        &self,
        scope: &IntegrationScope,
        reference: &IntegrationRevisionRef,
        subject: &AuthenticatedDelegationSubject,
        operation: &str,
        now_ms: u64,
    ) -> Result<NativeMemberSelfRevocation> {
        label(operation)?;
        let _lock = self.lock(PrivateLeaseMode::Shared)?;
        let journal = self.read_journal()?;
        let grant = self.member_self_grant(&journal, scope, reference, subject)?;
        ensure!(
            journal.identity_enabled
                && !grant.revoked
                && grant.revision.to_string() == reference.revision
                && grant.proof.claims.identity_epoch == journal.epoch
                && grant.proof.claims.issued_at_ms <= now_ms
                && grant.proof.claims.expires_at_ms.active_at(now_ms),
            "DELEGATION_SELF_MEMBER_UNAVAILABLE"
        );
        Ok(NativeMemberSelfRevocation {
            issuer: self.binding.issuer_id.clone(),
            directory: self.directory.directory_identity()?,
            scope: scope.clone(),
            reference: reference.clone(),
            subject: subject.clone(),
            operation: operation.into(),
        })
    }
    pub fn revoke_member_self(
        &self,
        permit: &NativeMemberSelfRevocation,
        now_ms: u64,
    ) -> Result<IntegrationDelegationView> {
        ensure!(
            permit.issuer == self.binding.issuer_id
                && permit.directory == self.directory.directory_identity()?,
            "DELEGATION_SELF_ISSUER_CHANGED"
        );
        let expected = permit
            .reference
            .revision
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .context("DELEGATION_REVISION_INVALID")?;
        let intent = digest(&serde_json::to_vec(&(
            "revoke",
            &permit.reference.id,
            expected,
        ))?);
        let _lock = self.lock(PrivateLeaseMode::Exclusive)?;
        let mut journal = self.read_journal()?;
        let grant =
            self.member_self_grant(&journal, &permit.scope, &permit.reference, &permit.subject)?;
        if let Some((prior, id)) = journal.operations.get(&permit.operation) {
            ensure!(
                prior == &intent && id == &permit.reference.id,
                "DELEGATION_INTENT_CONFLICT"
            );
            return Ok(view(grant, &journal.epoch, now_ms));
        }
        ensure!(
            journal.identity_enabled
                && !grant.revoked
                && grant.revision == expected
                && grant.proof.claims.identity_epoch == journal.epoch
                && grant.proof.claims.issued_at_ms <= now_ms
                && grant.proof.claims.expires_at_ms.active_at(now_ms),
            "DELEGATION_SELF_MEMBER_UNAVAILABLE"
        );
        self.commit(
            &mut journal,
            Event::Revoked {
                operation_id: permit.operation.clone(),
                intent,
                delegation_id: permit.reference.id.clone(),
                expected_revision: expected,
                revoked_at_ms: now_ms,
            },
        )?;
        let journal = self.read_journal()?;
        Ok(view(
            journal
                .grants
                .get(&permit.reference.id)
                .context("DELEGATION_NOT_FOUND")?,
            &journal.epoch,
            now_ms,
        ))
    }
    /// Reconciliation reads only this exact original operation; it cannot create a permit.
    pub fn read_member_self_revocation(
        &self,
        scope: &IntegrationScope,
        reference: &IntegrationRevisionRef,
        subject: &AuthenticatedDelegationSubject,
        operation: &str,
        now_ms: u64,
    ) -> Result<Option<IntegrationDelegationView>> {
        label(operation)?;
        let expected = reference
            .revision
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .context("DELEGATION_REVISION_INVALID")?;
        let intent = digest(&serde_json::to_vec(&("revoke", &reference.id, expected))?);
        let _lock = self.lock(PrivateLeaseMode::Shared)?;
        let journal = self.read_journal()?;
        let grant = self.member_self_grant(&journal, scope, reference, subject)?;
        let Some((prior, id)) = journal.operations.get(operation) else {
            return Ok(None);
        };
        ensure!(
            prior == &intent && id == &reference.id && grant.revoked,
            "DELEGATION_INTENT_CONFLICT"
        );
        Ok(Some(view(grant, &journal.epoch, now_ms)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::integrations::core::{IntegrationDelegationPurpose, IntegrationEntityKind};
    fn scope() -> IntegrationScope {
        IntegrationScope {
            account_id: "account".into(),
            target_id: "target".into(),
            workspace_id: kcoder_types::integrations::core::IntegrationNullable::Value(
                "workspace".into(),
            ),
            organization_id: None,
            identity_generation: "identity-1".into(),
            target_revision: "target-1".into(),
        }
    }
    fn subject(member: &str) -> AuthenticatedDelegationSubject {
        AuthenticatedDelegationSubject {
            connection_ref: IntegrationRevisionRef {
                id: "connection".into(),
                revision: "1".into(),
            },
            observed_subject_ref: IntegrationRevisionRef {
                id: member.into(),
                revision: "1".into(),
            },
            source_revision: "source".into(),
            channel_instance_id: "actual-owned-sdk".into(),
        }
    }
    fn issue(authority: &NativeDelegationAuthority, member: &str) -> IntegrationRevisionRef {
        let subject = subject(member);
        let resource = IntegrationEntityRef {
            kind: IntegrationEntityKind::Connection,
            id: "connection".into(),
            revision: Some("source".into()),
        };
        let policy = AuthenticatedDelegationPolicy {
            scope: scope(),
            revision: "policy".into(),
            allowed_actions: [IntegrationDelegationAction::ReadTask]
                .into_iter()
                .collect(),
            resource_refs: vec![resource],
        };
        let params = IntegrationDelegationPrepareParams {
            purpose: IntegrationDelegationPurpose::ChannelBinding,
            connection_id: "connection".into(),
            observed_subject_ref: subject.observed_subject_ref.clone(),
            actions: policy.allowed_actions.clone(),
            resource_refs: policy.resource_refs.clone(),
            expires_in_ms: 60000.into(),
        };
        authority
            .issue(&format!("issue-{member}"), &params, &subject, &policy, 100)
            .unwrap()
            .0
            .delegation_ref
    }
    #[test]
    fn signed_member_self_revocation_is_exact_atomic_and_preserves_peer_and_original_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let root = PrivateDirectory::open_or_create(temp.path()).unwrap();
        let issuer =
            NativeDelegationAuthority::create_in(&root, OsStr::new("issuer"), &scope()).unwrap();
        let own = issue(&issuer, "self");
        let peer = issue(&issuer, "peer");
        assert!(
            issuer
                .prepare_member_self_revocation(&scope(), &own, &subject("peer"), "self-op", 200)
                .is_err()
        );
        assert!(
            issuer
                .read_member_self_revocation(&scope(), &own, &subject("self"), "self-op", 200)
                .unwrap()
                .is_none()
        );
        let permit = issuer
            .prepare_member_self_revocation(&scope(), &own, &subject("self"), "self-op", 200)
            .unwrap();
        let revoked = issuer.revoke_member_self(&permit, 201).unwrap();
        assert_eq!(revoked.status, IntegrationDelegationStatus::Revoked);
        assert_eq!(issuer.revoke_member_self(&permit, 202).unwrap(), revoked);
        let reopened =
            NativeDelegationAuthority::open_in(&root, OsStr::new("issuer"), &scope()).unwrap();
        assert_eq!(
            reopened
                .read_member_self_revocation(&scope(), &own, &subject("self"), "self-op", 203)
                .unwrap(),
            Some(revoked)
        );
        assert!(
            reopened
                .read_member_self_revocation(&scope(), &own, &subject("self"), "absent-op", 203)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            reopened.read(&peer.id, 203).unwrap().unwrap().status,
            IntegrationDelegationStatus::Active
        );
        assert!(
            reopened
                .read_member_self_revocation(&scope(), &peer, &subject("self"), "self-op", 203)
                .is_err()
        );
    }
    #[test]
    fn self_revocation_does_not_borrow_issuer_epoch_scope_expiry_or_another_revocation_operation() {
        let temp = tempfile::tempdir().unwrap();
        let root = PrivateDirectory::open_or_create(temp.path()).unwrap();
        let issuer =
            NativeDelegationAuthority::create_in(&root, OsStr::new("issuer"), &scope()).unwrap();
        let own = issue(&issuer, "self");
        let mut foreign = scope();
        foreign.target_id = "foreign".into();
        assert!(
            issuer
                .prepare_member_self_revocation(&foreign, &own, &subject("self"), "self-op", 200)
                .is_err()
        );
        assert!(
            issuer
                .prepare_member_self_revocation(&scope(), &own, &subject("self"), "self-op", 60200)
                .is_err()
        );
        let permit = issuer
            .prepare_member_self_revocation(&scope(), &own, &subject("self"), "self-op", 200)
            .unwrap();
        let another =
            NativeDelegationAuthority::create_in(&root, OsStr::new("another-issuer"), &scope())
                .unwrap();
        assert!(another.revoke_member_self(&permit, 201).is_err());
        issuer
            .revoke("other-native-operation", &own.id, &own.revision, 201)
            .unwrap();
        assert!(
            issuer
                .read_member_self_revocation(&scope(), &own, &subject("self"), "self-op", 202)
                .unwrap()
                .is_none()
        );
        assert!(
            issuer
                .prepare_member_self_revocation(&scope(), &own, &subject("self"), "self-op", 202)
                .is_err()
        );
        let second = issue(&issuer, "second");
        let permit = issuer
            .prepare_member_self_revocation(&scope(), &second, &subject("second"), "second-op", 202)
            .unwrap();
        issuer
            .revoke_identity("disable-current-identity", 203)
            .unwrap();
        assert!(issuer.revoke_member_self(&permit, 204).is_err());
    }
}
