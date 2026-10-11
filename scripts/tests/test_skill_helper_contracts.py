"""Fixture regressions for bundled helper failures; no model or Office calls."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "skills/skill-creator"))
sys.path.insert(0, str(ROOT / "skills/docx/scripts"))
from scripts import run_eval, improve_description
from scripts.agent_cli import AgentCLI

spec = importlib.util.spec_from_file_location("docx_accept_changes", ROOT / "skills/docx/scripts/accept_changes.py")
docx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docx)


def available_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
            return True
    except OSError:
        return False


@unittest.skipUnless(sys.platform == "linux", "real process ownership fixtures require Linux")
class ServerContracts(unittest.TestCase):
    def run_wrapper(self, directory, server, port, timeout=2):
        command = [sys.executable, str(ROOT / "skills/webapp-testing/scripts/with_server.py"),
                   "--server", server, "--port", str(port), "--timeout", str(timeout), "--",
                   sys.executable, "-c", "from pathlib import Path; Path('command-ran').touch()"]
        process = subprocess.Popen(command, cwd=directory, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            stdout, _ = process.communicate(timeout=10)
            return process.returncode, stdout
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            # Old helpers leave children in the wrapper group. Own fixture only.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            pid_file = Path(directory) / "server-pid"
            if pid_file.exists():
                try:
                    os.kill(int(pid_file.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def server_command(self, directory, port, *, flood=False, exit_code=None):
        source = ("import os,socket,time; from pathlib import Path; "
                  "Path('server-pid').write_text(str(os.getpid())); ")
        if flood:
            source += "os.write(1,b'x'*300000); os.write(2,b'y'*300000); "
        if exit_code is not None:
            source += f"raise SystemExit({exit_code})"
        else:
            source += f"s=socket.socket(); s.bind(('127.0.0.1',{port})); s.listen(); time.sleep(60)"
        server = Path(directory) / "server.py"
        server.write_text(source)
        return f"{shlex.quote(sys.executable)} {shlex.quote(str(server))}"

    def test_startup_drains_large_stdout_and_stderr(self):
        with tempfile.TemporaryDirectory() as directory:
            port = available_port()
            code, _ = self.run_wrapper(directory, self.server_command(directory, port, flood=True), port)
            self.assertEqual(code, 0)
            self.assertTrue((Path(directory) / "command-ran").exists())

    def test_ready_requires_owned_listener_and_live_process(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as unrelated:
            unrelated.bind(("127.0.0.1", 0))
            unrelated.listen()
            port = unrelated.getsockname()[1]
            code, _ = self.run_wrapper(directory, self.server_command(directory, port, exit_code=7), port)
            self.assertNotEqual(code, 0)
            self.assertFalse((Path(directory) / "command-ran").exists())
            self.assertTrue(listening(port))

    def test_cleanup_removes_owned_child_listener(self):
        with tempfile.TemporaryDirectory() as directory:
            port = available_port()
            # Check within the wrapper's own command after normal cleanup through output.
            server = self.server_command(directory, port)
            command = [sys.executable, str(ROOT / "skills/webapp-testing/scripts/with_server.py"),
                       "--server", server, "--port", str(port), "--timeout", "2", "--", "true"]
            process = subprocess.Popen(command, cwd=directory, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            try:
                stdout, _ = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, stdout.decode())
                self.assertFalse(listening(port), "owned descendant still listens after helper reports cleanup")
            finally:
                pids = [process.pid, int((Path(directory) / "server-pid").read_text())]
                if (Path(directory) / "command-pid").exists():
                    pids.append(int((Path(directory) / "command-pid").read_text()))
                for pid in pids:
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


    def test_detached_child_is_cleaned_even_after_launcher_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            port = available_port()
            source = ("import os,socket,time; from pathlib import Path; "
                      "child=os.fork(); "
                      "(time.sleep(0.15), os._exit(0)) if child else None; "
                      "os.setsid(); Path('server-pid').write_text(str(os.getpid())); "
                      f"s=socket.socket(); s.bind(('127.0.0.1',{port})); s.listen(); time.sleep(60)")
            server = Path(directory) / "daemon.py"
            server.write_text(source)
            command = [sys.executable, str(ROOT / "skills/webapp-testing/scripts/with_server.py"),
                       "--server", f"{shlex.quote(sys.executable)} {shlex.quote(str(server))}",
                       "--port", str(port), "--timeout", "2", "--", "true"]
            process = subprocess.Popen(command, cwd=directory, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            try:
                output, _ = process.communicate(timeout=10)
                self.assertNotEqual(process.returncode, 0, output.decode())
                self.assertFalse(listening(port))
            finally:
                for pid in [process.pid, int((Path(directory) / "server-pid").read_text())]:
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_dead_launcher_is_failure_without_running_command(self):
        with tempfile.TemporaryDirectory() as directory:
            port = available_port()
            code, output = self.run_wrapper(directory, self.server_command(directory, port, exit_code=7), port)
            self.assertNotEqual(code, 0)
            self.assertIn(b"exited 7", output)
            self.assertFalse((Path(directory) / "command-ran").exists())

    def test_failed_startup_retains_bounded_log_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            port = available_port()
            code, output = self.run_wrapper(directory, self.server_command(directory, port, flood=True, exit_code=7), port)
            self.assertNotEqual(code, 0)
            self.assertLess(len(output), 140000)
            self.assertFalse((Path(directory) / "command-ran").exists())

    def test_sigterm_cleans_owned_listener(self):
        with tempfile.TemporaryDirectory() as directory:
            port = available_port()
            command = [sys.executable, str(ROOT / "skills/webapp-testing/scripts/with_server.py"),
                       "--server", self.server_command(directory, port), "--port", str(port),
                       "--timeout", "2", "--", sys.executable, "-c", "import os,time; from pathlib import Path; Path('command-pid').write_text(str(os.getpid())); time.sleep(60)"]
            process = subprocess.Popen(command, cwd=directory, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            try:
                deadline = time.monotonic() + 3
                while not listening(port) and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(listening(port))
                while not (Path(directory) / "command-pid").exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue((Path(directory) / "command-pid").exists())
                command_pid = int((Path(directory) / "command-pid").read_text())
                process.terminate()
                output, _ = process.communicate(timeout=5)
                self.assertNotEqual(process.returncode, 0, output.decode())
                self.assertFalse(listening(port))
                with self.assertRaises(ProcessLookupError):
                    os.kill(command_pid, 0)
            finally:
                pids = [process.pid, int((Path(directory) / "server-pid").read_text())]
                if (Path(directory) / "command-pid").exists():
                    pids.append(int((Path(directory) / "command-pid").read_text()))
                for pid in pids:
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass



class DocxContracts(unittest.TestCase):
    def document(self, path, revision=True):
        content = '<w:ins/>' if revision else '<w:p/>'
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
            archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + content + '</w:document>')

    def test_timeout_is_failure_and_does_not_publish_unaccepted_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'input.docx', Path(directory) / 'output.docx'
            self.document(source)
            output.write_bytes(b'previous output')
            with patch.object(docx, '_setup_libreoffice_macro', return_value=True), patch.object(docx, 'get_soffice_env', return_value={}), patch.object(docx.subprocess, 'run', side_effect=subprocess.TimeoutExpired('soffice', 30)):
                _, message = docx.accept_changes(str(source), str(output))
            self.assertIn('Error', message)
            self.assertEqual(output.read_bytes(), b'previous output')

    def test_zero_exit_with_pending_changes_is_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'input.docx', Path(directory) / 'output.docx'
            self.document(source)
            with patch.object(docx, '_setup_libreoffice_macro', return_value=True), patch.object(docx, 'get_soffice_env', return_value={}), patch.object(docx.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
                _, message = docx.accept_changes(str(source), str(output))
            self.assertIn('Error', message)
            self.assertFalse(output.exists())

    def test_validated_clean_output_is_published(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'input.docx', Path(directory) / 'output.docx'
            self.document(source)
            def complete(command, **kwargs):
                self.document(Path(command[-1]), revision=False)
                return subprocess.CompletedProcess(command, 0, '', '')
            with patch.object(docx, '_setup_libreoffice_macro', return_value=True), patch.object(docx, 'get_soffice_env', return_value={}), patch.object(docx.subprocess, 'run', side_effect=complete):
                _, message = docx.accept_changes(str(source), str(output))
            self.assertIn('Successfully', message)
            with zipfile.ZipFile(output) as archive:
                self.assertNotIn(b'<w:ins', archive.read('word/document.xml'))

    def test_invalid_output_does_not_replace_previous_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'input.docx', Path(directory) / 'output.docx'
            self.document(source)
            output.write_bytes(b'previous output')
            for partial_zip in [False, True]:
                with self.subTest(partial_zip=partial_zip):
                    def complete(command, **kwargs):
                        if partial_zip:
                            with zipfile.ZipFile(command[-1], 'w') as archive:
                                archive.writestr('word/document.xml', '<document/>')
                        else:
                            Path(command[-1]).write_bytes(b'not a zip')
                        return subprocess.CompletedProcess(command, 0, '', '')
                    with patch.object(docx, '_setup_libreoffice_macro', return_value=True), patch.object(docx, 'get_soffice_env', return_value={}), patch.object(docx.subprocess, 'run', side_effect=complete):
                        _, message = docx.accept_changes(str(source), str(output))
                    self.assertIn('Error', message)
                    self.assertEqual(output.read_bytes(), b'previous output')



class SkillEvalContracts(unittest.TestCase):
    def fixture_cli(self, directory, failure=False):
        cli = Path(directory) / 'kcoder-fixture'
        cli.write_text('#!' + sys.executable + '\n' + """
import json, sys
from pathlib import Path
if '--help' in sys.argv:
    print('--json --permission-mode --cwd --training-mode --tool-profile --model --settings-file')
    raise SystemExit(0)
if sys.argv[1:3] == ['trust','status']:
    print('trusted\\t' + str(Path.cwd()))
    raise SystemExit(0)
Path('fixture-argv.json').write_text(json.dumps(sys.argv[1:]))
skills = list(Path('.kcoder/skills').glob('*/SKILL.md'))
name = skills[0].parent.name if skills else 'not-registered'
print(json.dumps({'type':'tool_use_started','name':'skill','id':'skill1','input':{'skill':name}}))
print(json.dumps({'type':'tool_result','name':'skill','id':'skill1','text':'active','is_error':False}))
print(json.dumps({'type':'assistant_text_delta','text':'<new_description>Better description</new_description>'}))
print(json.dumps({'type':'result','subtype':'success','run_status':'completed','task_status':'completed'}))
""" + ("raise SystemExit(9)\n" if failure else ''))
        cli.chmod(0o755)
        return cli

    def test_kcoder_uses_real_flags_registration_and_events(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fixture_cli(directory)
            with patch.dict(os.environ, {'SKILL_EVAL_CLI':str(cli), 'SKILL_EVAL_BACKEND':'kcoder'}):
                self.assertTrue(run_eval.run_single_query('query', 'fixture-skill', 'description', 3, directory))
            argv = json.loads((Path(directory) / 'fixture-argv.json').read_text())
            self.assertIn('--json', argv)
            self.assertEqual(argv[argv.index('--tool-profile') + 1], 'full')
            self.assertIn('--settings-file', argv)
            self.assertFalse(Path(argv[argv.index('--settings-file') + 1]).exists())
            self.assertNotIn('-p', argv)
            self.assertNotIn('--output-format', argv)
            self.assertFalse(list((Path(directory) / '.kcoder/skills').glob('*/SKILL.md')))

    def test_nonzero_exit_after_trigger_is_infrastructure_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fixture_cli(directory, failure=True)
            with patch.dict(os.environ, {'SKILL_EVAL_CLI':str(cli), 'SKILL_EVAL_BACKEND':'kcoder'}):
                with self.assertRaises(RuntimeError):
                    run_eval.run_single_query('query', 'fixture-skill', 'description', 3, directory)

    def test_failed_process_is_excluded_from_trigger_quality(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fixture_cli(directory, failure=True)
            with patch.dict(os.environ, {'SKILL_EVAL_CLI':str(cli), 'SKILL_EVAL_BACKEND':'kcoder'}):
                result = run_eval.run_eval([{'query':'query','should_trigger':False}], 'fixture-skill', 'description', 1, 3, Path(directory))
            self.assertEqual(result['summary']['infrastructure_errors'], 1)
            self.assertEqual(result['summary']['passed'], 0)
            self.assertEqual(result['results'][0]['runs'], 0)
            self.assertIsNone(result['results'][0]['trigger_rate'])

    def test_improvement_uses_kcoder_json_text_and_positional_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fixture_cli(directory)
            previous = Path.cwd()
            try:
                os.chdir(directory)
                with patch.dict(os.environ, {'SKILL_EVAL_CLI':str(cli), 'SKILL_EVAL_BACKEND':'kcoder'}):
                    text = improve_description._call_agent_cli('improvement prompt', 'fixture-model')
                self.assertEqual(text, '<new_description>Better description</new_description>')
                argv = json.loads((Path(directory) / 'fixture-argv.json').read_text())
                self.assertEqual(argv[-1], 'improvement prompt')
                self.assertIn('--json', argv)
            finally:
                os.chdir(previous)

    def test_standalone_improvement_refuses_infrastructure_failures(self):
        with patch.object(improve_description, '_call_agent_cli') as call:
            with self.assertRaises(RuntimeError):
                improve_description.improve_description('fixture-skill', 'body', 'description',
                    {'summary': {'infrastructure_errors': 1}, 'results': []}, [], 'fixture-model')
            call.assert_not_called()

    def test_claude_requires_explicit_backend_and_uses_its_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = Path(directory) / 'claude-fixture'
            cli.write_text('#!' + sys.executable + '\n' + """
import json,sys
from pathlib import Path
if '--help' in sys.argv:
    print('--output-format --include-partial-messages')
    raise SystemExit(0)
assert sys.argv[1] == '-p'
assert '--json' not in sys.argv
assert sys.stdin.read() == 'query'
commands = list(Path('.claude/commands').glob('*.md'))
assert len(commands) == 1
print(json.dumps({'type':'assistant','message':{'content':[{'type':'tool_use','name':'Skill','input':{'skill':commands[0].stem}}]}}))
print(json.dumps({'type':'result','subtype':'success','result':'Claude fixture text'}))
""")
            cli.chmod(0o755)
            with patch.dict(os.environ, {'SKILL_EVAL_CLI':str(cli), 'SKILL_EVAL_BACKEND':'claude'}):
                self.assertTrue(run_eval.run_single_query('query', 'fixture-skill', 'description', 3, directory))
            self.assertFalse(list((Path(directory) / '.claude/commands').glob('*.md')))
            with self.assertRaises(RuntimeError):
                AgentCLI('kcoder', str(cli)).preflight()

    def test_failed_terminal_event_is_infrastructure_error_even_on_zero_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fixture_cli(directory)
            cli.write_text(cli.read_text().replace("'subtype':'success'", "'subtype':'error'"))
            with patch.dict(os.environ, {'SKILL_EVAL_CLI':str(cli), 'SKILL_EVAL_BACKEND':'kcoder'}):
                with self.assertRaises(RuntimeError):
                    run_eval.run_single_query('query', 'fixture-skill', 'description', 3, directory)

    def test_skill_denial_is_not_a_successful_trigger(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fixture_cli(directory)
            cli.write_text(cli.read_text().replace("'is_error':False", "'is_error':True"))
            with patch.dict(os.environ, {'SKILL_EVAL_CLI':str(cli), 'SKILL_EVAL_BACKEND':'kcoder'}):
                self.assertFalse(run_eval.run_single_query('query', 'fixture-skill', 'description', 3, directory))

    def test_timeout_is_infrastructure_error_and_removes_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fixture_cli(directory)
            cli.write_text(cli.read_text() + 'import time; time.sleep(10)\n')
            with patch.dict(os.environ, {'SKILL_EVAL_CLI':str(cli), 'SKILL_EVAL_BACKEND':'kcoder'}):
                with self.assertRaises(RuntimeError):
                    run_eval.run_single_query('query', 'fixture-skill', 'description', 0.1, directory)
            self.assertFalse(list((Path(directory) / '.kcoder/skills').glob('*/SKILL.md')))

    def test_malformed_event_is_infrastructure_error(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fixture_cli(directory)
            cli.write_text(cli.read_text() + "print('not-json')\n")
            with patch.dict(os.environ, {'SKILL_EVAL_CLI':str(cli), 'SKILL_EVAL_BACKEND':'kcoder'}):
                with self.assertRaises(RuntimeError):
                    run_eval.run_single_query('query', 'fixture-skill', 'description', 3, directory)

    def test_untrusted_project_is_rejected_before_model_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = self.fixture_cli(directory)
            cli.write_text(cli.read_text().replace("print('trusted", "print('unknown"))
            with patch.dict(os.environ, {'SKILL_EVAL_CLI':str(cli), 'SKILL_EVAL_BACKEND':'kcoder'}):
                with self.assertRaises(RuntimeError):
                    run_eval.run_single_query('query', 'fixture-skill', 'description', 3, directory)
            self.assertFalse((Path(directory) / 'fixture-argv.json').exists())



if __name__ == '__main__':
    unittest.main()
