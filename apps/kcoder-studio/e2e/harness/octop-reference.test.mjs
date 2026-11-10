import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('reference cleanup refuses a replaced directory and symlink before removing only its owned root', async () => {
  const fixture=fileURLToPath(new URL('./fixtures/owned-octop-reference.py',import.meta.url));
  const source=`import importlib.util,pathlib,tempfile\ns=importlib.util.spec_from_file_location('reference',${JSON.stringify(fixture)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nwith tempfile.TemporaryDirectory() as tmp:\n p=pathlib.Path(tmp);root=p/'owned';root.mkdir();st=root.stat();identity=(st.st_dev,st.st_ino,st.st_uid)\n root.rename(p/'moved');root.symlink_to(p/'moved',target_is_directory=True)\n try:m.remove_owned_root(root,identity);raise AssertionError('symlink deleted')\n except RuntimeError:pass\n assert (p/'moved').is_dir();root.unlink();root.mkdir()\n try:m.remove_owned_root(root,identity);raise AssertionError('replacement deleted')\n except RuntimeError:pass\n root.rmdir();(p/'moved').rename(root);m.remove_owned_root(root,identity);assert not root.exists()\nprint('owned cleanup passed')`;
  const result=await promisify(execFile)('python3',['-c',source]);assert.match(result.stdout,/owned cleanup passed/);
});
