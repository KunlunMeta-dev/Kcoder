//! Cross-process reservation probe. Does not start a desktop worker.
#[cfg(windows)]
fn main() {
    use kcoder_computer_use::windows_exclusive::DesktopReservation;
    if std::env::args().nth(1).as_deref() == Some("contender") {
        assert!(DesktopReservation::acquire().is_err());
        println!("PASS: concurrent process rejected");
        return;
    }
    let reservation = DesktopReservation::acquire().unwrap();
    assert!(DesktopReservation::acquire().is_err());
    assert!(
        std::process::Command::new(std::env::current_exe().unwrap())
            .arg("contender")
            .status()
            .unwrap()
            .success()
    );
    drop(reservation);
    let _next = DesktopReservation::acquire().unwrap();
    println!("PASS: reservation reusable after owner releases");
}
#[cfg(not(windows))]
fn main() {
    std::process::exit(2);
}
