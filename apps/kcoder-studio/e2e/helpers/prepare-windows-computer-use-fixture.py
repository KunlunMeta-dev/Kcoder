import hashlib,json,os,shutil,zipfile
from pathlib import Path
home=Path.home();downloads=home/'Downloads';base=downloads/'kcoder-studio-cu-ui'
assert not base.exists(), 'owned package destination must be new'
with zipfile.ZipFile(downloads/'windows-ui-app.zip') as z:z.extractall(base)
source=downloads/'kcoder-live-package/resources/computer-use'
def copy_link(src,dst):
 try:os.link(src,dst)
 except OSError:shutil.copy2(src,dst)
 return dst
shutil.copytree(source,base/'resources/computer-use',copy_function=copy_link)
p=base/'resources/kcoder-release-manifest.json';manifest=json.loads(p.read_text())
inv=base/'resources/computer-use/files.sha256.json'
manifest['resources'].append({'path':'computer-use/files.sha256.json','bytes':inv.stat().st_size,'sha256':hashlib.sha256(inv.read_bytes()).hexdigest()})
p.write_text(json.dumps(manifest),encoding='utf-8')
source_root=downloads/'kcoder-studio-cu-ui-source'
assert not source_root.exists(), 'owned source destination must be new'
with zipfile.ZipFile(downloads/'windows-ui-source.zip') as z:z.extractall(source_root)
print(json.dumps({'package':str(base),'sources':str(source_root)}))
