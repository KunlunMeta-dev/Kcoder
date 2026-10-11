"""Measure real stdio initialize/tools-list; never calls a desktop action."""
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time

EXPECTED = {'Snapshot', 'Screenshot', 'DisplayInventory', 'App', 'Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'WaitFor'}


def measure(root):
    manifest = json.loads((root/'runtime-manifest.json').read_text(encoding='utf-8-sig'))
    with tempfile.TemporaryDirectory(prefix='kcoder-startup-measure-') as temporary:
        env = {key: value for key, value in os.environ.items() if key.upper() in {
            'SYSTEMROOT','WINDIR','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA',
            'PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','COMMONPROGRAMFILES',
            'USERNAME','USERDOMAIN','SESSIONNAME'}}
        env.update(TEMP=temporary, TMP=temporary, PATH=str(Path(os.environ['SystemRoot'])/'System32'),
                   ANONYMIZED_TELEMETRY='false', WINDOWS_MCP_WATCHDOG='false')
        started = time.monotonic()
        worker = subprocess.Popen([str(root/manifest['python']),'-I','-B','-X','utf8',str(root/'launch.py')],
            cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        replies = queue.Queue()
        def read():
            for line in iter(lambda: worker.stdout.readline(2*1024*1024+1), b''):
                if len(line)>2*1024*1024: replies.put(None);return
                try: replies.put(json.loads(line))
                except ValueError: replies.put(None);return
            replies.put(None)
        threading.Thread(target=read,daemon=True).start()
        try:
            def send(value):
                worker.stdin.write((json.dumps(value)+'\n').encode());worker.stdin.flush()
            def response(request_id):
                deadline=time.monotonic()+40
                while True:
                    result=replies.get(timeout=max(.01,deadline-time.monotonic()))
                    if result is None: raise RuntimeError('worker closed its protocol stream')
                    if result.get('id')==request_id:
                        if 'error' in result:raise RuntimeError('MCP request failed')
                        return result['result']
            send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'kcoder-startup-probe','version':'1'}}})
            response(1)
            initialized=time.monotonic()
            send({'jsonrpc':'2.0','method':'notifications/initialized','params':{}})
            send({'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}})
            tools=response(2)['tools']
            listed=time.monotonic()
            assert {tool['name'] for tool in tools}==EXPECTED, 'desktop tool surface changed'
            return {'initializeMs':round((initialized-started)*1000),'readyMs':round((listed-started)*1000),'toolCount':len(tools),'toolSchemaSha256':hashlib.sha256(json.dumps(sorted([{'name':tool['name'],'inputSchema':tool['inputSchema']} for tool in tools],key=lambda tool:tool['name']),sort_keys=True,separators=(',',':')).encode()).hexdigest(),'desktopInputSent':False}
        finally:
            worker.stdin.close()
            try:worker.wait(timeout=5)
            except subprocess.TimeoutExpired:worker.kill();worker.wait(timeout=5)
            worker.stdout.close()


if __name__=='__main__':
    root=Path(sys.argv[1]).resolve(strict=True)
    reports=[]
    rounds=int(sys.argv[2]) if len(sys.argv)>2 else 3
    assert 1 <= rounds <= 5
    for _ in range(rounds): reports.append(measure(root))
    print(json.dumps({'runtime':root.name,'runs':reports}))
