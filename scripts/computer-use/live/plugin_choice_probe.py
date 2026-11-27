"""Real app-server configuration policy RPCs; no model turns or desktop input."""
from pathlib import Path
import json, os, queue, subprocess, sys, tempfile, threading, time
from collections import deque

report = {'status':'failed', 'desktopInputSent':False, 'modelTurnsSent':0}
process = None
with tempfile.TemporaryDirectory(prefix='kcoder-plugin-choice-') as directory:
    root=Path(directory); home=root/'config';home.mkdir();workspace=root/'workspace';workspace.mkdir()
    settings=home/'settings.json'
    settings.write_text(json.dumps({'active_provider':'fixture','plugins':{'runtime':{'enabled':True}},
        'providers':{'fixture':{'api_format':'openai_chat_completions','authentication':{'mode':'none'},
        'endpoint':'http://127.0.0.1:1/v1','default_model':'fixture','no_proxy':True,
        'context_window_tokens':128000,'max_output_tokens':1024,'output_headroom_tokens':1024}}}),encoding='utf-8')
    env={key:value for key,value in os.environ.items() if key.upper() in {
        'SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMDATA'}}
    env['KCODER_CONFIG_DIR']=str(home)
    messages=queue.Queue()
    errors=deque(maxlen=16)
    try:
        process=subprocess.Popen([sys.argv[1],'app-server'],cwd=workspace,env=env,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
        def read():
            for line in process.stdout:
                try: messages.put(json.loads(line))
                except ValueError: messages.put({'protocolError':True})
            messages.put({'closed':True})
        threading.Thread(target=read,daemon=True).start()
        def read_errors():
            for line in process.stderr: errors.append(line[:400])
        threading.Thread(target=read_errors,daemon=True).start()
        def rpc(identifier,method,params):
            report['lastRpc']=method
            process.stdin.write(json.dumps({'jsonrpc':'2.0','id':identifier,'method':method,'params':params})+'\n')
            process.stdin.flush();until=time.monotonic()+30
            while time.monotonic()<until:
                response=messages.get(timeout=max(0.1,until-time.monotonic()))
                if response.get('closed'): raise RuntimeError('app-server output closed before '+method)
                if response.get('id')==identifier:
                    assert 'error' not in response, 'RPC failed: '+method
                    return response['result']
            raise TimeoutError(method)
        rpc(1,'initialize',{'protocolVersion':'2026-07-27','clientInfo':{'name':'owned-plugin-choice-probe','version':'1'}})
        value=json.loads(settings.read_text(encoding='utf-8-sig'))
        value['mcp_servers']=[{'name':'existing','transport':'stdio','command':'windows-mcp.exe','args':[]}]
        settings.write_text(json.dumps(value),encoding='utf-8')
        before=rpc(2,'computerUse/status',{})
        assert before['reason']=='existing_windows_mcp_requires_choice', 'new configuration was not observed'
        installed=rpc(3,'plugin/install',{'marketplaceName':'kcoder-bundled','pluginName':'kcoder-windows-computer-use'})
        value=json.loads(settings.read_text(encoding='utf-8-sig'))
        assert value['plugins']['installed']['kcoder-windows-computer-use@kcoder-bundled']['enabled'] is True
        after=rpc(4,'computerUse/status',{})
        assert after['reason']!='existing_windows_mcp_requires_choice', 'explicit choice stayed stale'
        assert after['canControl'] is False, 'SSH session must not grant desktop access'
        report.update(status='passed',freshConfigurationObserved=True,explicitChoicePersisted=True,
                      freshChoiceObserved=True,desktopStillDenied=True)
    except Exception as error:
        report['error']=type(error).__name__+': '+str(error)[:250]
        report['diagnostic']=''.join(errors)[-2000:]
    finally:
        if process:
            process.stdin.close()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill();process.wait(timeout=5)
                report.update(status='failed',error='app-server did not exit on disconnect')
            report['processExited']=process.poll() is not None
print(json.dumps(report))
sys.exit(0 if report['status']=='passed' else 1)
