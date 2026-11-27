//! A reply link proves received provenance only; ordinary send authorization is still required.
use super::*;
use kcoder_types::session_address::SessionAddressV1;

#[derive(Clone)]
pub struct PeerReplyReferenceWitness {
    state: AppState,
    owner: AppStateLifecycleIdentity,
    history: HistorySource,
    generation: uuid::Uuid,
    source: SessionAddressV1,
    destination: SessionAddressV1,
    message_id: String,
}
impl PeerReplyReferenceWitness {
    pub fn verify_current(
        &self,
        source: &SessionAddressV1,
        destination: &SessionAddressV1,
        message_id: &str,
    ) -> Result<()> {
        ensure!(
            self.source == *source
                && self.destination == *destination
                && self.message_id == message_id,
            "PEER_REPLY_REFERENCE_CHANGED"
        );
        let inner = self
            .state
            .inner
            .try_read()
            .map_err(|_| anyhow::anyhow!("PEER_REPLY_SOURCE_BUSY"))?;
        ensure!(
            self.owner.matches_locked(&self.state, &inner)
                && inner.history_write_fault.is_none()
                && inner.session_id == source.thread_id
                && inner
                    .history_source
                    .as_ref()
                    .is_some_and(|history| history.shares_binding(&self.history)),
            "PEER_REPLY_SOURCE_CHANGED"
        );
        drop(inner);
        self.history.check_read_binding()?;
        ensure!(
            matches!(self.history.try_bound_generation()?, TryHistoryGeneration::Available(Some(generation)) if generation == self.generation),
            "PEER_REPLY_HISTORY_CHANGED"
        );
        Ok(())
    }
}

pub(crate) fn reply_metadata_matches(
    message: &Message,
    source: &SessionAddressV1,
    destination: &SessionAddressV1,
    id: &str,
) -> Result<bool> {
    let Message::User {
        agent_message: Some(raw),
        ..
    } = message
    else {
        return Ok(false);
    };
    if raw.message_id != id {
        return Ok(false);
    }
    let (metadata, _) = message
        .peer_agent_data()
        .context("PEER_REPLY_REFERENCE_INVALID")?;
    ensure!(
        metadata.source_address.as_ref() == Some(destination)
            && metadata.target_address.as_ref() == Some(source)
            && metadata.target_thread_id == source.thread_id
            && metadata.source_thread_id == destination.thread_id,
        "PEER_REPLY_RECIPIENT_MISMATCH"
    );
    Ok(true)
}

impl AppState {
    /// The warm path reads the shared in-memory snapshot. Only an explicit old
    /// reference absent after compaction scans this original bound history, with
    /// fixed limits; neither another session nor an outbox supplies this fact.
    pub fn capture_peer_reply_reference(
        &self,
        owner: &AppStateLifecycleIdentity,
        source: &SessionAddressV1,
        destination: &SessionAddressV1,
        id: &str,
    ) -> Result<PeerReplyReferenceWitness> {
        source.validate().map_err(anyhow::Error::msg)?;
        destination.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            kcoder_types::cross_session_messages::valid_agent_message_id(id)
                && source != destination,
            "PEER_REPLY_REFERENCE_INVALID"
        );
        let (messages, history) = {
            let inner = self
                .inner
                .try_read()
                .map_err(|_| anyhow::anyhow!("PEER_REPLY_SOURCE_BUSY"))?;
            ensure!(
                owner.matches_locked(self, &inner)
                    && inner.history_write_fault.is_none()
                    && inner.session_id == source.thread_id,
                "PEER_REPLY_SOURCE_CHANGED"
            );
            (
                inner.messages.clone(),
                inner
                    .history_source
                    .clone()
                    .context("PEER_REPLY_HISTORY_UNAVAILABLE")?,
            )
        };
        let mut found = false;
        for message in messages.iter() {
            if reply_metadata_matches(message, source, destination, id)? {
                ensure!(!found, "PEER_REPLY_REFERENCE_AMBIGUOUS");
                found = true;
            }
        }
        if !found {
            ensure!(
                history.contains_received_reply(source, destination, id)?,
                "PEER_REPLY_REFERENCE_UNAVAILABLE"
            );
        }
        let generation = match history.try_bound_generation()? {
            TryHistoryGeneration::Available(Some(generation)) => generation,
            _ => anyhow::bail!("PEER_REPLY_HISTORY_UNAVAILABLE"),
        };
        let witness = PeerReplyReferenceWitness {
            state: self.clone(),
            owner: owner.clone(),
            history,
            generation,
            source: source.clone(),
            destination: destination.clone(),
            message_id: id.to_owned(),
        };
        witness.verify_current(source, destination, id)?;
        Ok(witness)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned_received() -> (
        tempfile::TempDir,
        AppState,
        SessionAddressV1,
        SessionAddressV1,
    ) {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let source = SessionAddressV1 {
            target_id: "receiver-host".into(),
            workspace_id: "receiver-workspace".into(),
            thread_id: state.session_id(),
        };
        let destination = SessionAddressV1 {
            target_id: "sender-host".into(),
            workspace_id: "sender-workspace".into(),
            thread_id: "original-sender".into(),
        };
        state.with_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
        let metadata = PeerAgentMessageV1::for_addressed_text(
            "received-original".into(),
            destination.clone(),
            source.clone(),
            1,
            "inbound note",
        )
        .unwrap();
        state.add_message(Message::peer_agent_text(metadata, "inbound note".into()).unwrap());
        state.save_history().unwrap();
        (root, state, source, destination)
    }

    #[test]
    fn reply_reference_warm_and_compacted_paths_bind_exact_received_addresses() {
        let (_root, state, source, destination) = owned_received();
        let owner = state.inspection_lifecycle_identity();
        crate::history_store::take_reply_history_scans();
        let witness = state
            .capture_peer_reply_reference(&owner, &source, &destination, "received-original")
            .unwrap();
        assert_eq!(
            crate::history_store::take_reply_history_scans(),
            0,
            "warm reply never scans history bodies"
        );
        let mut wrong = destination.clone();
        wrong.workspace_id.push_str("-different");
        assert!(
            state
                .capture_peer_reply_reference(&owner, &source, &wrong, "received-original")
                .is_err()
        );
        assert!(
            state
                .capture_peer_reply_reference(&owner, &source, &destination, "guessed-unreceived")
                .is_err()
        );
        assert!(state.set_messages_preserving_history_ids_if_revision(
            vec![Message::user_text("owned compacted context")],
            &state.message_revision()
        ));
        crate::history_store::take_reply_history_scans();
        state
            .capture_peer_reply_reference(&owner, &source, &destination, "received-original")
            .unwrap();
        assert_eq!(crate::history_store::take_reply_history_scans(), 1);
        witness
            .verify_current(&source, &destination, "received-original")
            .unwrap();
        state.start_new_session().unwrap();
        assert!(
            witness
                .verify_current(&source, &destination, "received-original")
                .is_err()
        );
    }

    #[test]
    fn reply_reference_rejects_forged_provenance_and_cold_corruption() {
        let (_root, state, source, destination) = owned_received();
        let owner = state.inspection_lifecycle_identity();
        let original = state.messages()[0].clone();
        let Message::User {
            content,
            agent_message,
            ..
        } = original
        else {
            unreachable!()
        };
        let forged = Message::User {
            origin: kcoder_types::MessageOrigin::User,
            content,
            agent_message,
        };
        assert!(
            reply_metadata_matches(&forged, &source, &destination, "received-original").is_err()
        );
        assert!(
            state
                .set_messages_preserving_history_ids_if_revision(vec![], &state.message_revision())
        );
        let history = state.history_path().unwrap();
        let original = std::fs::read_to_string(&history).unwrap();
        std::fs::write(&history, original.replace("inbound note", "changed note")).unwrap();
        assert!(
            state
                .capture_peer_reply_reference(&owner, &source, &destination, "received-original")
                .is_err()
        );
    }
}
