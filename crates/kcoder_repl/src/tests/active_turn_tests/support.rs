#[derive(Debug)]
struct NamedTool {
    name: &'static str,
}

#[async_trait::async_trait]
impl kcoder_tools::Tool for NamedTool {
    fn name(&self) -> String {
        self.name.to_string()
    }

    fn description(&self) -> String {
        format!("test tool {}", self.name)
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type": "object"})
    }

    async fn call(
        &self,
        _input: serde_json::Value,
        _ctx: &kcoder_tools::ToolContext,
    ) -> std::result::Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        Ok(kcoder_tools::ToolOutput::text("ok"))
    }
}

struct CaptureBackend {
    output: Vec<u8>,
    drawn_text: String,
    size: Size,
    cursor: Position,
    clear_region_count: usize,
    clear_region_positions: Vec<Position>,
    scroll_region_up_calls: Vec<(std::ops::Range<u16>, u16)>,
    hide_cursor_count: usize,
    set_cursor_position_count: usize,
}

impl CaptureBackend {
    fn new(width: u16, height: u16) -> Self {
        Self {
            output: Vec::new(),
            drawn_text: String::new(),
            size: Size { width, height },
            cursor: Position { x: 0, y: 0 },
            clear_region_count: 0,
            clear_region_positions: Vec::new(),
            scroll_region_up_calls: Vec::new(),
            hide_cursor_count: 0,
            set_cursor_position_count: 0,
        }
    }

    fn output(&self) -> String {
        String::from_utf8_lossy(&self.output).into_owned()
    }
}

impl Write for CaptureBackend {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.output.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Backend for CaptureBackend {
    fn draw<'a, I>(&mut self, content: I) -> std::io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        self.drawn_text.clear();
        self.drawn_text
            .extend(content.flat_map(|(_, _, cell)| cell.symbol().chars()));
        Ok(())
    }

    fn hide_cursor(&mut self) -> std::io::Result<()> {
        self.hide_cursor_count += 1;
        Ok(())
    }

    fn show_cursor(&mut self) -> std::io::Result<()> {
        Ok(())
    }

    fn get_cursor_position(&mut self) -> std::io::Result<Position> {
        Ok(self.cursor)
    }

    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> std::io::Result<()> {
        self.set_cursor_position_count += 1;
        self.cursor = position.into();
        Ok(())
    }

    fn clear(&mut self) -> std::io::Result<()> {
        Ok(())
    }

    fn clear_region(&mut self, _clear_type: ClearType) -> std::io::Result<()> {
        self.clear_region_count += 1;
        self.clear_region_positions.push(self.cursor);
        Ok(())
    }

    fn append_lines(&mut self, _line_count: u16) -> std::io::Result<()> {
        Ok(())
    }

    fn scroll_region_up(
        &mut self,
        region: std::ops::Range<u16>,
        scroll_by: u16,
    ) -> std::io::Result<()> {
        self.scroll_region_up_calls.push((region, scroll_by));
        Ok(())
    }

    fn scroll_region_down(
        &mut self,
        _region: std::ops::Range<u16>,
        _scroll_by: u16,
    ) -> std::io::Result<()> {
        Ok(())
    }

    fn size(&self) -> std::io::Result<Size> {
        Ok(self.size)
    }

    fn window_size(&mut self) -> std::io::Result<WindowSize> {
        Ok(WindowSize {
            columns_rows: self.size,
            pixels: self.size,
        })
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn unique_temp_dir(name: &str) -> std::path::PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let id = COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
    std::env::temp_dir().join(format!("kcoder-repl-{name}-{id}-{}", std::process::id()))
}
