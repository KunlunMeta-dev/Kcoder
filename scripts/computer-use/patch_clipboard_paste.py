"""Patch the pinned Windows-MCP method; normal failures must preserve formats."""
from pathlib import Path


def patch(source):
    start = source.index('    def _paste_text(self, text: str):\n')
    end = source.index('    def scroll(', start)
    original = source[start:end]
    if original.count('prior = uia.GetClipboardText()') != 1 or original.count('uia.SetClipboardText(prior)') != 1:
        raise ValueError('Pinned clipboard implementation changed')
    replacement = '''    def _paste_text(self, text: str):
        from windows_mcp.kcoder_clipboard import paste_text
        paste_text(text, lambda keys: uia.SendKeys(keys, interval=0.04, waitTime=0.05))

'''
    return source[:start] + replacement + source[end:]


if __name__ == '__main__':
    import ast
    import sys
    path = Path(sys.argv[1])
    result = patch(path.read_text(encoding='utf-8'))
    ast.parse(result)
    path.write_text(result, encoding='utf-8')
