//! Short, best-effort startup terminal probes.
//!
//! Crossterm's cursor-position helper can wait long enough to make startup feel
//! broken on PTYs that do not answer CPR. This module bounds the one startup
//! probe KCoder currently needs.

use std::time::Duration;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(100);

/// Default terminal foreground and background colors reported by OSC 10/11.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DefaultColors {
    pub(crate) fg: (u8, u8, u8),
    pub(crate) bg: (u8, u8, u8),
}

/// Results from KCoder's one-shot startup terminal probe.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct StartupProbe {
    pub(crate) cursor_position: Option<ratatui::layout::Position>,
    pub(crate) default_colors: Option<DefaultColors>,
}

#[cfg(unix)]
mod imp {
    use super::DefaultColors;
    use super::StartupProbe;
    use super::parse_default_colors;
    use ratatui::layout::Position;
    use std::fs::File;
    use std::fs::OpenOptions;
    use std::io;
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::fd::FromRawFd;
    use std::time::Duration;
    use std::time::Instant;

    struct Tty {
        reader: File,
        writer: File,
        original_flags: libc::c_int,
        original_termios: Option<libc::termios>,
    }

    impl Tty {
        fn open() -> io::Result<Self> {
            let stdio_reader = dup_file(libc::STDIN_FILENO);
            let stdio_writer = dup_file(libc::STDOUT_FILENO);
            match (stdio_reader, stdio_writer) {
                (Ok(reader), Ok(writer)) => Self::new(reader, writer),
                (reader, writer) => {
                    let stdio_err = match (reader.err(), writer.err()) {
                        (Some(reader_err), Some(writer_err)) => {
                            format!("reader: {reader_err}; writer: {writer_err}")
                        }
                        (Some(reader_err), None) => format!("reader: {reader_err}"),
                        (None, Some(writer_err)) => format!("writer: {writer_err}"),
                        (None, None) => "unknown stdio duplicate error".to_string(),
                    };
                    let reader =
                        OpenOptions::new()
                            .read(true)
                            .open("/dev/tty")
                            .map_err(|fallback_err| {
                                io::Error::new(
                                    fallback_err.kind(),
                                    format!(
                                        "failed to duplicate stdio ({stdio_err}) or open /dev/tty reader ({fallback_err})"
                                    ),
                                )
                            })?;
                    let writer = OpenOptions::new().write(true).open("/dev/tty").map_err(
                        |fallback_err| {
                            io::Error::new(
                                fallback_err.kind(),
                                format!(
                                    "failed to duplicate stdio ({stdio_err}) or open /dev/tty writer ({fallback_err})"
                                ),
                            )
                        },
                    )?;
                    Self::new(reader, writer)
                }
            }
        }

        fn new(reader: File, writer: File) -> io::Result<Self> {
            let fd = reader.as_raw_fd();
            // SAFETY: fcntl reads flags for a valid duplicated terminal fd.
            let original_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if original_flags == -1 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: toggles O_NONBLOCK on only the duplicated reader fd and
            // restores the previous flags in Drop.
            if unsafe { libc::fcntl(fd, libc::F_SETFL, original_flags | libc::O_NONBLOCK) } == -1 {
                return Err(io::Error::last_os_error());
            }
            let original_termios = probe_termios_without_echo(fd)?;
            Ok(Self {
                reader,
                writer,
                original_flags,
                original_termios,
            })
        }

        fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
            self.writer.write_all(bytes)?;
            self.writer.flush()
        }

        fn read_available(&mut self, buffer: &mut Vec<u8>) -> io::Result<()> {
            let mut chunk = [0_u8; 256];
            loop {
                // SAFETY: reads into a valid stack buffer from a duplicated fd.
                let count = unsafe {
                    libc::read(
                        self.reader.as_raw_fd(),
                        chunk.as_mut_ptr().cast::<libc::c_void>(),
                        chunk.len(),
                    )
                };
                if count > 0 {
                    buffer.extend_from_slice(&chunk[..count as usize]);
                    continue;
                }
                if count == 0 {
                    return Ok(());
                }
                let err = io::Error::last_os_error();
                if matches!(
                    err.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) {
                    return Ok(());
                }
                return Err(err);
            }
        }

        fn poll_readable(&self, timeout: Duration) -> io::Result<bool> {
            let mut fd = libc::pollfd {
                fd: self.reader.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let deadline = Instant::now() + timeout;
            loop {
                let now = Instant::now();
                if now >= deadline {
                    return Ok(false);
                }
                let timeout_ms = deadline
                    .saturating_duration_since(now)
                    .as_millis()
                    .min(libc::c_int::MAX as u128) as libc::c_int;
                // SAFETY: polls a single valid duplicated fd.
                let result = unsafe { libc::poll(&mut fd, 1, timeout_ms) };
                if result > 0 {
                    return Ok((fd.revents & libc::POLLIN) != 0);
                }
                if result == 0 {
                    return Ok(false);
                }
                let err = io::Error::last_os_error();
                if err.kind() != io::ErrorKind::Interrupted {
                    return Err(err);
                }
            }
        }
    }

    impl Drop for Tty {
        fn drop(&mut self) {
            if let Some(termios) = self.original_termios.as_ref() {
                // SAFETY: restores terminal attributes on the duplicated reader
                // fd used for the bounded probe.
                let _ = unsafe { libc::tcsetattr(self.reader.as_raw_fd(), libc::TCSANOW, termios) };
            }
            // SAFETY: restores flags on the duplicated reader fd owned by Tty.
            let _ =
                unsafe { libc::fcntl(self.reader.as_raw_fd(), libc::F_SETFL, self.original_flags) };
        }
    }

    fn probe_termios_without_echo(fd: libc::c_int) -> io::Result<Option<libc::termios>> {
        // SAFETY: termios is immediately initialized by tcgetattr on success.
        let mut original: libc::termios = unsafe { std::mem::zeroed() };
        // SAFETY: reads terminal attributes for a valid duplicated terminal fd.
        if unsafe { libc::tcgetattr(fd, &mut original) } != 0 {
            return Ok(None);
        }

        let mut probe = original;
        probe.c_lflag &= !(libc::ECHO | libc::ICANON);
        probe.c_cc[libc::VMIN] = 0;
        probe.c_cc[libc::VTIME] = 0;
        // SAFETY: applies temporary probe-only terminal attributes; Drop
        // restores the original attributes.
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &probe) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(original))
    }

    fn dup_file(fd: libc::c_int) -> io::Result<File> {
        // SAFETY: dup returns a new owned fd on success.
        let duplicated = unsafe { libc::dup(fd) };
        if duplicated == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: duplicated is a fresh owned file descriptor.
        Ok(unsafe { File::from_raw_fd(duplicated) })
    }

    #[allow(dead_code)]
    pub fn cursor_position(timeout: Duration) -> io::Result<Option<Position>> {
        let mut tty = Tty::open()?;
        tty.write_all(b"\x1B[6n")?;
        let deadline = Instant::now() + timeout;
        let mut buffer = Vec::new();
        loop {
            tty.read_available(&mut buffer)?;
            if let Some(position) = parse_cursor_position(&buffer) {
                return Ok(Some(position));
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            if !tty.poll_readable(deadline.saturating_duration_since(now))? {
                return Ok(None);
            }
        }
    }

    pub fn startup(timeout: Duration) -> io::Result<StartupProbe> {
        let mut tty = Tty::open()?;
        tty.write_all(b"\x1B[6n\x1B]10;?\x1B\\\x1B]11;?\x1B\\")?;
        read_startup_probe(&mut tty, timeout)
    }

    #[cfg_attr(test, allow(dead_code))]
    pub fn default_colors(timeout: Duration) -> io::Result<Option<DefaultColors>> {
        let mut tty = Tty::open()?;
        tty.write_all(b"\x1B]10;?\x1B\\\x1B]11;?\x1B\\")?;
        read_until(&mut tty, timeout, parse_default_colors)
    }

    #[cfg_attr(test, allow(dead_code))]
    fn read_until<T>(
        tty: &mut Tty,
        timeout: Duration,
        mut parse: impl FnMut(&[u8]) -> Option<T>,
    ) -> io::Result<Option<T>> {
        let deadline = Instant::now() + timeout;
        let mut buffer = Vec::new();
        loop {
            tty.read_available(&mut buffer)?;
            if let Some(value) = parse(&buffer) {
                return Ok(Some(value));
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            if !tty.poll_readable(deadline.saturating_duration_since(now))? {
                return Ok(None);
            }
        }
    }

    fn read_startup_probe(tty: &mut Tty, timeout: Duration) -> io::Result<StartupProbe> {
        let deadline = Instant::now() + timeout;
        let mut buffer = Vec::new();
        let mut probe = StartupProbe::default();
        loop {
            tty.read_available(&mut buffer)?;
            update_startup_probe(&mut probe, &buffer);
            if probe.cursor_position.is_some() && probe.default_colors.is_some() {
                return Ok(probe);
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(probe);
            }
            if !tty.poll_readable(deadline.saturating_duration_since(now))? {
                return Ok(probe);
            }
        }
    }

    fn update_startup_probe(probe: &mut StartupProbe, buffer: &[u8]) {
        if probe.cursor_position.is_none() {
            probe.cursor_position = parse_cursor_position(buffer);
        }
        if probe.default_colors.is_none() {
            probe.default_colors = parse_default_colors(buffer);
        }
    }

    fn parse_cursor_position(buffer: &[u8]) -> Option<Position> {
        for start in find_all_subslices(buffer, b"\x1B[") {
            let rest = &buffer[start + 2..];
            let Some(end) = rest.iter().position(|b| *b == b'R') else {
                continue;
            };
            let payload = std::str::from_utf8(&rest[..end]).ok()?;
            let (row, col) = payload.split_once(';')?;
            let row = row.parse::<u16>().ok()?;
            let col = col.parse::<u16>().ok()?;
            return Some(Position {
                x: col.saturating_sub(1),
                y: row.saturating_sub(1),
            });
        }
        None
    }

    fn find_all_subslices<'a>(
        haystack: &'a [u8],
        needle: &'a [u8],
    ) -> impl Iterator<Item = usize> + 'a {
        haystack
            .windows(needle.len())
            .enumerate()
            .filter_map(move |(idx, window)| (window == needle).then_some(idx))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_cursor_position_response() {
            assert_eq!(
                parse_cursor_position(b"\x1B[20;10R"),
                Some(Position { x: 9, y: 19 })
            );
        }

        #[test]
        fn ignores_incomplete_cursor_position_response() {
            assert_eq!(parse_cursor_position(b"\x1B[20;"), None);
        }

        #[test]
        fn startup_probe_parses_batched_terminal_responses() {
            let mut probe = StartupProbe::default();
            update_startup_probe(
                &mut probe,
                b"\x1B[20;10R\x1B]11;rgb:1111/1111/1111\x07\x1B]10;rgb:eeee/eeee/eeee\x1B\\",
            );

            assert_eq!(
                probe,
                StartupProbe {
                    cursor_position: Some(Position { x: 9, y: 19 }),
                    default_colors: Some(DefaultColors {
                        fg: (238, 238, 238),
                        bg: (17, 17, 17),
                    }),
                }
            );
        }
    }
}

#[cfg(any(unix, test))]
fn parse_osc_color(buffer: &[u8], slot: u8) -> Option<(u8, u8, u8)> {
    let prefix = format!("\x1B]{slot};");
    let start = find_subslice(buffer, prefix.as_bytes())?;
    let payload_start = start + prefix.len();
    let rest = &buffer[payload_start..];
    let (payload_end, _terminator_len) = osc_payload_end(rest)?;
    let payload = std::str::from_utf8(&rest[..payload_end]).ok()?;
    parse_osc_rgb(payload)
}

#[cfg(any(unix, test))]
fn parse_default_colors(buffer: &[u8]) -> Option<DefaultColors> {
    let fg = parse_osc_color(buffer, 10)?;
    let bg = parse_osc_color(buffer, 11)?;
    Some(DefaultColors { fg, bg })
}

#[cfg(any(unix, test))]
fn osc_payload_end(buffer: &[u8]) -> Option<(usize, usize)> {
    let mut idx = 0;
    while idx < buffer.len() {
        match buffer[idx] {
            0x07 => return Some((idx, 1)),
            0x1B if buffer.get(idx + 1) == Some(&b'\\') => return Some((idx, 2)),
            _ => idx += 1,
        }
    }
    None
}

#[cfg(any(unix, test))]
fn parse_osc_rgb(payload: &str) -> Option<(u8, u8, u8)> {
    let (prefix, values) = payload.trim().split_once(':')?;
    if !prefix.eq_ignore_ascii_case("rgb") && !prefix.eq_ignore_ascii_case("rgba") {
        return None;
    }

    let mut parts = values.split('/');
    let r = parse_osc_component(parts.next()?)?;
    let g = parse_osc_component(parts.next()?)?;
    let b = parse_osc_component(parts.next()?)?;
    if prefix.eq_ignore_ascii_case("rgba") {
        parse_osc_component(parts.next()?)?;
    }
    parts.next().is_none().then_some((r, g, b))
}

#[cfg(any(unix, test))]
fn parse_osc_component(component: &str) -> Option<u8> {
    match component.len() {
        2 => u8::from_str_radix(component, 16).ok(),
        4 => u16::from_str_radix(component, 16)
            .ok()
            .map(|value| (value / 257) as u8),
        _ => None,
    }
}

#[cfg(any(unix, test))]
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(unix)]
#[allow(dead_code)]
pub fn cursor_position(timeout: Duration) -> std::io::Result<Option<ratatui::layout::Position>> {
    imp::cursor_position(timeout)
}

#[cfg(unix)]
pub(crate) fn startup(timeout: Duration) -> std::io::Result<StartupProbe> {
    imp::startup(timeout)
}

#[cfg(unix)]
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn default_colors(timeout: Duration) -> std::io::Result<Option<DefaultColors>> {
    imp::default_colors(timeout)
}

#[cfg(not(unix))]
pub fn cursor_position(_timeout: Duration) -> std::io::Result<Option<ratatui::layout::Position>> {
    match crossterm::cursor::position() {
        Ok((x, y)) => Ok(Some(ratatui::layout::Position { x, y })),
        Err(err) => Err(err),
    }
}

#[cfg(not(unix))]
pub(crate) fn startup(timeout: Duration) -> std::io::Result<StartupProbe> {
    let cursor_position = cursor_position(timeout).ok().flatten();
    Ok(StartupProbe {
        cursor_position,
        default_colors: None,
    })
}

#[cfg(not(unix))]
#[allow(dead_code)]
pub(crate) fn default_colors(_timeout: Duration) -> std::io::Result<Option<DefaultColors>> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_osc_colors_with_bel_and_st() {
        assert_eq!(
            parse_osc_color(b"\x1B]10;rgb:ffff/8000/0000\x07", 10),
            Some((255, 127, 0))
        );
        assert_eq!(
            parse_osc_color(b"\x1B]11;rgba:00/80/ff/ff\x1B\\", 11),
            Some((0, 128, 255))
        );
    }

    #[test]
    fn parses_default_colors_from_one_buffer() {
        assert_eq!(
            parse_default_colors(b"\x1B]10;rgb:eeee/eeee/eeee\x1B\\\x1B]11;rgb:1111/1111/1111\x07"),
            Some(DefaultColors {
                fg: (238, 238, 238),
                bg: (17, 17, 17),
            })
        );
        assert_eq!(
            parse_default_colors(b"\x1B]11;rgb:1111/1111/1111\x07\x1B]10;rgb:eeee/eeee/eeee\x1B\\"),
            Some(DefaultColors {
                fg: (238, 238, 238),
                bg: (17, 17, 17),
            })
        );
    }

    #[test]
    fn ignores_malformed_or_partial_default_color_responses() {
        assert_eq!(
            parse_default_colors(b"\x1B]10;rgb:eeee/eeee/eeee\x1B\\"),
            None
        );
        assert_eq!(
            parse_default_colors(b"\x1B]10;rgb:eeee/eeee/eeee\x1B\\\x1B]11;rgb:nope\x07"),
            None
        );
        assert_eq!(
            parse_default_colors(b"\x1B]10;rgb:eeee/eeee/eeee\x1B\\\x1B]11;rgb:1111/1111/1111"),
            None
        );
    }

    #[test]
    fn parses_default_colors_with_unrelated_bytes() {
        assert_eq!(
            parse_default_colors(
                b"typed\x1B]10;rgb:eeee/eeee/eeee\x1B\\noise\x1B]11;rgb:1111/1111/1111\x07"
            ),
            Some(DefaultColors {
                fg: (238, 238, 238),
                bg: (17, 17, 17),
            })
        );
    }
}
