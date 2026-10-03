"""Create a new owned runtime prototype; never mutate a prior sealed copy."""
from pathlib import Path
import ast
import json
import os
import shutil
import sys
import hashlib

sys.path.insert(0, str(Path(__file__).parent))
from patch_clipboard_paste import patch as patch_clipboard
from patch_unicode_input import patch as patch_unicode
from runtime_inventory import seal, verify

source = Path.home() / 'Downloads/kcoder-live-package/resources/computer-use'
root = Path.home() / 'Downloads/kcoder-cu-prototype-8-clipboard'
assert not root.exists(), 'new prototype directory required'

def link_or_copy(src, dst):
    try: os.link(src, dst)
    except OSError: shutil.copy2(src, dst)
    return dst

shutil.copytree(source, root, copy_function=link_or_copy)
for relative, patch in [('source/src/windows_mcp/desktop/service.py', patch_clipboard),
                        ('source/src/windows_mcp/uia/core.py', patch_unicode)]:
    path = root / relative
    result = patch(path.read_text(encoding='utf-8'))
    ast.parse(result)
    path.unlink()  # Break the hard link before changing a sealed source copy.
    path.write_text(result, encoding='utf-8')
shutil.copyfile(Path(__file__).with_name('clipboard_paste.py'), root / 'source/src/windows_mcp/kcoder_clipboard.py')
shutil.rmtree(root / 'packages/posthog/test', ignore_errors=True)
for leaf in ['t64-arm.exe', 'w64-arm.exe']:
    (root / 'runtime/cpython-3.14.6-windows-x86_64-none/Lib/site-packages/pip/_vendor/distlib' / leaf).unlink(missing_ok=True)
path = root / 'runtime-manifest.json'
manifest = json.loads(path.read_text(encoding='utf-8-sig'))
manifest['upstream'] = json.loads(Path(__file__).with_name('upstream.json').read_text())
path.unlink()
path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
(root / 'files.sha256.json').unlink()
seal(root)
print(json.dumps({'runtime':str(root), 'verifiedFiles':verify(root),
                  'inventorySha256':hashlib.sha256((root/'files.sha256.json').read_bytes()).hexdigest()}))
