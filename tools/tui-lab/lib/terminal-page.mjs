export function renderTerminalPage(options) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>KCoder TUI Lab</title>
  <link rel="stylesheet" href="/xterm.css">
  <style>
    html, body, #terminal {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: #101316;
    }
    .xterm {
      padding: 10px 12px;
      box-sizing: border-box;
    }
    .xterm-viewport::-webkit-scrollbar {
      width: 12px;
    }
    .xterm-viewport::-webkit-scrollbar-track {
      background: #111820;
    }
    .xterm-viewport::-webkit-scrollbar-thumb {
      background: #7cc7ff;
      border-radius: 2px;
    }
    #lab-scrollbar {
      position: fixed;
      top: 10px;
      right: 5px;
      bottom: 10px;
      width: 7px;
      border-radius: 2px;
      background: rgba(124, 199, 255, 0.16);
      pointer-events: none;
      opacity: 0;
      transition: opacity 80ms linear;
    }
    #lab-scrollbar.visible {
      opacity: 1;
    }
    #lab-scrollbar-thumb {
      position: absolute;
      left: 1px;
      right: 1px;
      top: 0;
      height: 40px;
      min-height: 28px;
      border-radius: 2px;
      background: #7cc7ff;
      box-shadow: 0 0 0 1px rgba(16, 19, 22, 0.5);
    }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <div id="lab-scrollbar"><div id="lab-scrollbar-thumb"></div></div>
  <script src="/xterm.js"></script>
  <script src="/addon-fit.js"></script>
  <script src="/addon-webgl.js"></script>
  <script>
    const term = new Terminal({
      cols: ${options.cols},
      rows: ${options.rows},
      cursorBlink: false,
      convertEol: false,
      scrollback: 10000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.15,
      theme: {
        background: '#101316',
        foreground: '#dbe7ef',
        cursor: '#7cc7ff',
        selectionBackground: '#29465f'
      }
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    term.attachCustomKeyEventHandler((event) => {
      const copySelection =
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === 'c' &&
        term.hasSelection();
      return !copySelection;
    });
    let renderer = 'webgl';
    try {
      const webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(() => {
        renderer = 'webgl-context-lost';
      });
      term.loadAddon(webglAddon);
    } catch (error) {
      renderer = 'dom-fallback:' + String(error && error.message ? error.message : error);
    }
    term.focus();

    const clipboardCopies = [];
    if (${JSON.stringify(options.tuiLabMode === "copy-view")}) {
      // Use xterm's official OSC parser and the browser clipboard to validate the client-side copy path.
      term.parser.registerOscHandler(52, (data) => {
        const separator = data.indexOf(';');
        if (separator < 0 || data.slice(separator + 1) === '?') return false;
        const bytes = Uint8Array.from(atob(data.slice(separator + 1)), (value) => value.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        navigator.clipboard.writeText(text).then(() => clipboardCopies.push(text)).catch((error) => console.error(error));
        return true;
      });
    }

    const socket = new WebSocket('ws://' + window.location.host + '/pty');
    let terminalTitle = '';
    term.onTitleChange((title) => { terminalTitle = title; });
    const inputEvents = [];
    window.tuiLab = {
      ready: false,
      title() { return terminalTitle; },
      clipboardCopies() { return clipboardCopies.slice(); },
      get renderer() { return renderer; },
      rendererDiagnostics() {
        const canvases = [...document.querySelectorAll('#terminal canvas')];
        const contexts = canvases.map((canvas) => canvas.getContext('webgl2') || canvas.getContext('webgl')).filter(Boolean);
        const contextLost = contexts.some((context) => context.isContextLost());
        // Addon notification may lag by several seconds, so screenshot gating also inspects the current canvas directly.
        if (contextLost) renderer = 'webgl-context-lost';
        return { renderer, canvasCount: canvases.length, webglContexts: contexts.length, contextLost };
      },
      focus() {
        term.focus();
      },
      inputEvents() {
        return inputEvents.slice();
      },
      async viewportDiagnostics(afterSequence = 0) {
        const response = await fetch('/viewport-diagnostics?after=' + encodeURIComponent(afterSequence), {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('viewport diagnostics request failed: ' + response.status);
        return response.json();
      },
      sendInput(data) {
        inputEvents.push(data);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'input', data }));
        }
      },
      selectAll() {
        term.selectAll();
        return term.getSelection();
      },
      clearSelection() {
        term.clearSelection();
      },
      text() {
        const buffer = term.buffer.active;
        const lines = [];
        for (let i = 0; i < buffer.length; i += 1) {
          const line = buffer.getLine(i);
          lines.push(line ? line.translateToString(true) : '');
        }
        return lines.join('\\n');
      },
      visibleText() {
        const buffer = term.buffer.active;
        const viewportY = buffer.viewportY || 0;
        const lines = [];
        for (let row = 0; row < term.rows; row += 1) {
          const line = buffer.getLine(viewportY + row);
          lines.push(line ? line.translateToString(true) : '');
        }
        return lines.join('\\n');
      },
      textHitCells(needle) {
        const buffer = term.buffer.active;
        const hits = [];
        // Locate Unicode text through xterm's real cell API instead of calculating character widths independently.
        for (let row = 0; row < term.rows; row += 1) {
          const line = buffer.getLine((buffer.viewportY || 0) + row);
          if (!line || !line.translateToString(true).includes(needle)) continue;
          for (let column = 0; column < term.cols; column += 1) {
            if (line.getCell(column)?.getWidth() === 0) continue;
            if (line.translateToString(true, column).startsWith(needle)) {
              hits.push({ row, column, text: line.translateToString(true) });
            }
          }
        }
        return hits;
      },
      textStyleCells(needle) {
        // Read colors and modifiers from real xterm cells rather than inferring rendering from ANSI strings.
        return this.textHitCells(needle).map((hit) => {
          const line = term.buffer.active.getLine((term.buffer.active.viewportY || 0) + hit.row);
          const cells = [];
          let text = '';
          for (let column = hit.column; column < term.cols && text.length < needle.length; column += 1) {
            const cell = line.getCell(column);
            if (!cell || cell.getWidth() === 0) continue;
            text += cell.getChars();
            cells.push({ text: cell.getChars(), fg: cell.getFgColor(), fgMode: cell.getFgColorMode(),
              rgb: cell.isFgRGB(), bold: Boolean(cell.isBold()), underline: Boolean(cell.isUnderline()) });
          }
          return { ...hit, cells };
        });
      },
      underlinedCells() {
        const buffer = term.buffer.active;
        const cells = [];
        for (let row = 0; row < term.rows; row += 1) {
          const line = buffer.getLine((buffer.viewportY || 0) + row);
          for (let column = 0; column < term.cols; column += 1) {
            const cell = line?.getCell(column);
            if (cell?.isUnderline()) cells.push({ row, column, text: cell.getChars() });
          }
        }
        return cells;
      },
      hasScrollbar() {
        const viewport = document.querySelector('.xterm-viewport');
        return Boolean(viewport && viewport.scrollHeight > viewport.clientHeight);
      },
      scrollBy(deltaY) {
        const viewport = document.querySelector('.xterm-viewport');
        if (viewport) {
          viewport.scrollBy(0, deltaY);
          updateScrollbar();
        }
      },
      scrollToTop() {
        const viewport = document.querySelector('.xterm-viewport');
        if (viewport) {
          viewport.scrollTop = 0;
          updateScrollbar();
        }
      },
      scrollToBottom() {
        const viewport = document.querySelector('.xterm-viewport');
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight;
          updateScrollbar();
        }
      },
      dimensions() {
        const viewport = document.querySelector('.xterm-viewport');
        return {
          cols: term.cols,
          rows: term.rows,
          scrollHeight: viewport ? viewport.scrollHeight : 0,
          clientHeight: viewport ? viewport.clientHeight : 0,
          scrollTop: viewport ? viewport.scrollTop : 0
        };
      },
      internalScrollbar() {
        const buffer = term.buffer.active;
        const col = Math.max(0, term.cols - 2);
        const viewportY = buffer.viewportY || 0;
        const trackRows = [];
        const thumbRows = [];
        const adjacentRailRows = [];
        const railCell = (cell) => {
          if (!cell) return false;
          const chars = cell.getChars();
          const inverse = typeof cell.isInverse === 'function' && cell.isInverse();
          return chars === '░' || chars === '█' || chars === '│' || chars === '┃' ||
            chars === '.' || chars === ':' || chars === '|' || inverse;
        };
        for (let row = 0; row < term.rows; row += 1) {
          const line = buffer.getLine(viewportY + row);
          const cell = line ? line.getCell(col) : null;
          if (!cell) continue;
          const chars = cell.getChars();
          const inverse = typeof cell.isInverse === 'function' && cell.isInverse();
          const fixedTrack = chars === '░' || chars === '█' || chars === '│' || chars === '┃';
          if (fixedTrack || chars === '.' || chars === ':' || chars === '|' || inverse) {
            trackRows.push(row);
          }
          if (chars === '█' || chars === '┃' || chars === '|' || inverse) thumbRows.push(row);
          const left = col > 0 && line ? line.getCell(col - 1) : null;
          const right = col + 1 < term.cols && line ? line.getCell(col + 1) : null;
          if (railCell(left) || railCell(right)) adjacentRailRows.push(row);
        }
        return { col, viewportY, trackRows, thumbRows, adjacentRailRows };
      }
    };

    function fitAndReport() {
      fitAddon.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
      updateScrollbar();
    }

    function updateScrollbar() {
      const viewport = document.querySelector('.xterm-viewport');
      const track = document.getElementById('lab-scrollbar');
      const thumb = document.getElementById('lab-scrollbar-thumb');
      if (!viewport || !track || !thumb) return;
      const maxScroll = viewport.scrollHeight - viewport.clientHeight;
      if (maxScroll <= 0) {
        track.classList.remove('visible');
        return;
      }
      track.classList.add('visible');
      const trackHeight = track.clientHeight;
      const thumbHeight = Math.max(28, Math.round(trackHeight * viewport.clientHeight / viewport.scrollHeight));
      const top = Math.round((trackHeight - thumbHeight) * viewport.scrollTop / maxScroll);
      thumb.style.height = thumbHeight + 'px';
      thumb.style.transform = 'translateY(' + top + 'px)';
    }

    socket.addEventListener('open', () => {
      window.tuiLab.ready = true;
      fitAndReport();
    });
    socket.addEventListener('message', (event) => term.write(event.data, updateScrollbar));
    term.onWriteParsed(updateScrollbar);
    term.onData((data) => {
      window.tuiLab.sendInput(data);
    });
    window.addEventListener('resize', fitAndReport);
    requestAnimationFrame(() => {
      const viewport = document.querySelector('.xterm-viewport');
      if (viewport) viewport.addEventListener('scroll', updateScrollbar);
      updateScrollbar();
    });
  </script>
</body>
</html>`;
}
