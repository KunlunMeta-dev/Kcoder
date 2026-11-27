use super::*;
#[test]
fn desktop_binding_is_absent_by_default_and_bound_to_real_session() {
    let state = AppState::new(std::env::temp_dir());
    let owner = kcoder_types::computer_use::DesktopOwner {
        client_instance: "client".into(),
        thread_id: state.session_id(),
        turn_id: "turn".into(),
    };
    assert!(!ToolContext::new(state.clone()).authorizes_desktop_owner(&owner));
    let context = ToolContext::new(state.clone()).with_desktop_owner(owner.clone());
    assert!(context.authorizes_desktop_owner(&owner));
    let mut different_turn = owner.clone();
    different_turn.turn_id = "next".into();
    assert!(!context.authorizes_desktop_owner(&different_turn));
    let mut wrong_thread = owner.clone();
    wrong_thread.thread_id = "another".into();
    assert!(
        !ToolContext::new(state)
            .with_desktop_owner(wrong_thread.clone())
            .authorizes_desktop_owner(&wrong_thread)
    );
}
