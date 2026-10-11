"""Derive a new sealed development runtime from verified dependencies + overlay.
Never changes a previously sealed runtime. This does not mark release readiness.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import sys
sys.path.insert(0, str(Path(__file__).parent))
from runtime_inventory import seal, verify

source, overlay, root = map(Path, sys.argv[1:4])
assert not root.exists(), 'fresh output directory required'
verify(source)
assert json.loads((overlay / 'overlay.json').read_text())['baseInventorySha256'] == hashlib.sha256((source / 'files.sha256.json').read_bytes()).hexdigest(), 'base runtime pin mismatch'

def link_or_copy(src, dst):
    try: os.link(src, dst)
    except OSError: shutil.copy2(src, dst)
    return dst

shutil.copytree(source, root, copy_function=link_or_copy)
for path in overlay.rglob('*'):
    if not path.is_file() or path.name == 'overlay.json': continue
    relative = path.relative_to(overlay)
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.unlink(missing_ok=True)
    shutil.copyfile(path, destination)
shutil.rmtree(root / 'packages/posthog/test', ignore_errors=True)
for leaf in ['t64-arm.exe', 'w64-arm.exe']:
    (root / 'runtime/cpython-3.14.6-windows-x86_64-none/Lib/site-packages/pip/_vendor/distlib' / leaf).unlink(missing_ok=True)
manifest_path = root / 'runtime-manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
manifest.update(inputTrackingVersion=1, clipboardRecoveryVersion=1, status='prototype', validation='pending')
manifest['upstream'] = json.loads((root / 'upstream.json').read_text())
manifest_path.unlink()
manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
(root / 'files.sha256.json').unlink()
seal(root)
print(json.dumps({'runtime':str(root), 'verifiedFiles':verify(root),
                  'inventorySha256':hashlib.sha256((root/'files.sha256.json').read_bytes()).hexdigest(),
                  'clipboardRecoveryVersion':1, 'validation':'pending'}))
