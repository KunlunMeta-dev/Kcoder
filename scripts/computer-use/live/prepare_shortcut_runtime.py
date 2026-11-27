"""Derive a fresh sealed test runtime with corrected shortcut scan codes."""
from pathlib import Path
import ast
import hashlib
import json
import os
import shutil
import sys
sys.path.insert(0,str(Path(__file__).parent))
from patch_shortcut_input import patch
from runtime_inventory import seal,verify
source=Path.home()/'Downloads/kcoder-cu-prototype-8-clipboard'
root=Path.home()/'Downloads/kcoder-cu-prototype-9-shortcuts'
assert not root.exists(),'new prototype directory required'
def link(src,dst):
 try:os.link(src,dst)
 except OSError:shutil.copy2(src,dst)
 return dst
shutil.copytree(source,root,copy_function=link)
p=root/'source/src/windows_mcp/uia/core.py';text=patch(p.read_text(encoding='utf-8'));ast.parse(text);p.unlink();p.write_text(text,encoding='utf-8')
p=root/'source/src/windows_mcp/kcoder_clipboard.py';p.unlink();shutil.copyfile(Path(__file__).with_name('clipboard_paste.py'),p)
p=root/'runtime-manifest.json';m=json.loads(p.read_text(encoding='utf-8-sig'));m['upstream']=json.loads(Path(__file__).with_name('upstream.json').read_text());p.unlink();p.write_text(json.dumps(m,indent=2),encoding='utf-8')
(root/'files.sha256.json').unlink();seal(root)
print(json.dumps({'runtime':str(root),'verifiedFiles':verify(root),'inventorySha256':hashlib.sha256((root/'files.sha256.json').read_bytes()).hexdigest()}))
