//! Registration-only probe. Does not send keys or operate any application.
#[cfg(windows)]
fn main() {
    use kcoder_computer_use::windows_hotkey::EmergencyStopHotkey;
    let first = match EmergencyStopHotkey::register(|| {}) {
        Ok(hotkey) => hotkey,
        Err(error) => {
            eprintln!("UNMET: interactive hotkey registration unavailable: {error}");
            std::process::exit(2);
        }
    };
    assert!(EmergencyStopHotkey::register(|| {}).is_err());
    drop(first);
    let _replacement = EmergencyStopHotkey::register(|| {}).unwrap();
    println!("PASS: hotkey registration, collision rejection, and release");
}
#[cfg(not(windows))]
fn main() {
    std::process::exit(2);
}
