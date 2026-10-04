"""Verify the native gh boundary with a fake CLI and fake authorization only."""
import importlib.util
import base64
import http.server
import json
import os
from pathlib import Path
import subprocess
import socketserver
import sys
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location('gh_bridge', Path(__file__).with_name('t3code-gh.py'))
gh = importlib.util.module_from_spec(spec); spec.loader.exec_module(gh)


class GitHubBoundaryTests(unittest.TestCase):
    def test_native_arguments_identity_exit_code_and_redaction(self):
        with tempfile.TemporaryDirectory() as root:
            native = Path(root)/'native-gh'
            native.write_text('#!/usr/bin/python3\nimport json,os,sys\nprint(json.dumps(sys.argv[1:]))\nprint(os.getuid())\nprint(os.environ.get("GH_TOKEN","missing"))\nprint(os.environ.get("GH_HOST","missing"))\nprint(os.environ.get("GH_TOKEN","missing"),file=sys.stderr)\nsys.exit(7)\n')
            native.chmod(0o755)
            runner = '''import importlib.util,sys
s=importlib.util.spec_from_file_location('gh',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.NATIVE_GH=sys.argv[2];m.BRIDGE=sys.argv[3];m.tool_environment=lambda e:{'GH_TOKEN':'ghs_fixture_private','GH_HOST':'github.com','GH_DEBUG':''}
sys.argv=['gh','pr','list','--repo','owner/blog'];sys.exit(m.main())
'''
            result = subprocess.run([sys.executable,'-B','-c',runner,str(Path(__file__).with_name('t3code-gh.py')),str(native),str(Path(__file__).with_name('t3code-shell-bridge.py'))],capture_output=True,text=True)
            self.assertEqual(result.returncode,7,result.stderr)
            self.assertIn('["pr", "list", "--repo", "owner/blog"]',result.stdout)
            self.assertIn(str(os.getuid()),result.stdout)
            self.assertIn('github.com',result.stdout)
            self.assertIn('[REDACTED]',result.stdout);self.assertIn('[REDACTED]',result.stderr)
            self.assertNotIn('ghs_fixture_private',result.stdout+result.stderr)
    def test_ordinary_unconfigured_invocation_gets_no_host_token(self):
        from unittest.mock import patch
        with patch.dict(os.environ,{'GH_TOKEN':'fixture-inherited-token','GITHUB_TOKEN':'fixture-other-token'},clear=True), patch.object(gh,'tool_environment',return_value={}), patch.object(gh.importlib.util,'spec_from_file_location') as loader:
            # The native execution is separately covered above. Here we inspect
            # the environment at the exact external program boundary.
            captured={}
            class Bridge:
                @staticmethod
                def execute(native,argv,environment,values,**kwargs):captured.update(environment);return 0
            fake=type('Spec',(),{'loader':type('Loader',(),{'exec_module':lambda *_:None})()})()
            loader.return_value=fake
            with patch.object(gh.importlib.util,'module_from_spec',return_value=Bridge):gh.main()
            self.assertNotIn('GH_TOKEN',captured);self.assertNotIn('GITHUB_TOKEN',captured)


class GitTransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.home = self.root / 'home'; self.home.mkdir()
        self.token = 'ghs_fixture_private'
        self.allowed = True
        self.resolutions = 0
        self.environment = {**os.environ, 'HOME': str(self.home), 'GIT_CONFIG_NOSYSTEM': '1',
                            'GIT_CONFIG_GLOBAL': str(self.home / 'gitconfig'), 'GIT_TERMINAL_PROMPT': '0'}
        for name in list(self.environment):
            if name.lower().endswith('_proxy') or name.startswith(('GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_')):
                self.environment.pop(name)
        self.environment.pop('GIT_CONFIG_COUNT', None)
        self.native = self.root / 'native-gh'
        self.native.write_text('''#!/usr/bin/python3
import os,sys
if sys.argv[1:3] == ['auth','git-credential']:
    sys.stdin.read()
    if sys.argv[-1] == 'get':
        print('username=x-access-token')
        print('password='+os.environ['GH_TOKEN'])
        print(os.environ['GH_TOKEN'],file=sys.stderr)
else:
    print(os.environ['GH_TOKEN'])
''')
        self.native.chmod(0o755)
        exec_path = subprocess.check_output(['git', '--exec-path'], text=True).strip()
        self.runner = self.root / 'gh'
        self.runner.write_text(f'''#!{sys.executable}
import importlib.util,sys
s=importlib.util.spec_from_file_location('gh',{str(Path(__file__).with_name('t3code-gh.py'))!r})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.NATIVE_GH={str(self.native)!r}
m.NATIVE_GIT_HTTP={str(Path(exec_path)/'git-remote-http')!r}
m.BRIDGE={str(Path(__file__).with_name('t3code-shell-bridge.py'))!r}
try:
    sys.exit(m.main())
except (OSError,ValueError,KeyError,ImportError):
    print('Tool binding unavailable',file=sys.stderr);sys.exit(125)
''')
        self.runner.chmod(0o755)
        self.environment['PATH'] = str(self.root) + ':' + self.environment['PATH']
        test = self
        class BrokerHandler(socketserver.StreamRequestHandler):
            def handle(self):
                request = json.loads(self.rfile.readline())
                valid = test.allowed and request == {'authorization': 'Bearer fixture', 'tool': 'gh'}
                test.resolutions += 1
                response = {'ok': valid, 'environment': {'GH_TOKEN': test.token, 'GH_HOST': 'github.com', 'GH_DEBUG': ''}}
                self.wfile.write(json.dumps(response).encode()+b'\n')
        broker = socketserver.ThreadingUnixStreamServer(str(self.root/'broker'), BrokerHandler)
        self.start_server(broker)
        self.environment.update(T3_CREDENTIAL_SOCKET=str(self.root/'broker'), T3_CREDENTIAL_AUTHORIZATION='Bearer fixture')
        self.git('init', '-q', '--bare', str(self.root/'repo.git'))
        seed = self.root/'seed'; self.git('init', '-q', str(seed))
        self.git('-C', str(seed), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-q', '--allow-empty', '-m', 'fixture')
        self.git('-C', str(seed), 'push', '-q', str(self.root/'repo.git'), 'HEAD:main')
        self.git('-C', str(self.root/'repo.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main')
        class GitHandler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def handle_git(self):
                expected = 'Basic ' + base64.b64encode(('x-access-token:'+test.token).encode()).decode()
                if self.headers.get('Authorization') != expected:
                    self.send_response(401); self.send_header('WWW-Authenticate', 'Basic realm="fixture"')
                    self.send_header('Content-Length', '0'); self.end_headers(); return
                path, _, query = self.path.partition('?')
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                environment = {**test.environment, 'GIT_PROJECT_ROOT': str(test.root), 'GIT_HTTP_EXPORT_ALL': '1',
                               'REQUEST_METHOD': self.command, 'PATH_INFO': path, 'QUERY_STRING': query,
                               'CONTENT_TYPE': self.headers.get('Content-Type', ''), 'REMOTE_USER': 'fixture'}
                backend = subprocess.run(['git', 'http-backend'], input=body, capture_output=True, env=environment, timeout=10)
                headers, _, response = backend.stdout.partition(b'\r\n\r\n')
                parsed = [line.decode().split(':', 1) for line in headers.split(b'\r\n')]
                status = next((int(value.strip().split()[0]) for key,value in parsed if key == 'Status'), 200)
                self.send_response(status)
                for key,value in parsed:
                    if key != 'Status': self.send_header(key,value.strip())
                self.send_header('Content-Length',str(len(response))); self.end_headers(); self.wfile.write(response)
            do_GET = handle_git
            do_POST = handle_git
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), GitHandler)
        self.start_server(server)
        self.url = f'http://127.0.0.1:{server.server_port}/repo.git'
        self.environment.update(GIT_CONFIG_COUNT='2', GIT_CONFIG_KEY_0='credential.helper', GIT_CONFIG_VALUE_0='',
                                GIT_CONFIG_KEY_1='credential.helper', GIT_CONFIG_VALUE_1=f'!{self.runner} auth git-credential')

    def start_server(self, server):
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def stop():
            server.shutdown(); server.server_close(); thread.join()
        self.addCleanup(stop)

    def git(self, *args, check=True, input=None):
        result = subprocess.run(['git', *args], input=input, capture_output=True, text=True, env=self.environment, timeout=20)
        if check: self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.token, result.stdout+result.stderr)
        return result

    def test_plain_git_can_list_clone_fetch_and_push(self):
        result = self.git('-c', 'credential.helper=!gh auth git-credential', 'ls-remote', self.url)
        self.assertIn('refs/heads/main',result.stdout)
        self.assertIn('[REDACTED]',result.stderr)
        checkout = self.root/'checkout'
        self.git('clone', '-q', self.url, str(checkout))
        self.git('-C', str(checkout), 'fetch', '-q')
        self.git('-C', str(checkout), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-q', '--allow-empty', '-m', 'pushed fixture')
        self.git('-C', str(checkout), 'push', '-q')
        local = self.git('-C', str(checkout), 'rev-parse', 'HEAD').stdout.strip()
        remote = self.git('ls-remote', self.url, 'refs/heads/main').stdout.split()[0]
        self.assertEqual(local, remote)

    def test_git_credential_fill_stays_redacted(self):
        result = self.git('credential', 'fill', input=f'url={self.url}\n\n')
        self.assertIn('password=[REDACTED]',result.stdout)

    def test_git_shell_alias_is_not_an_authentication_pipe(self):
        result = self.git('-c', f'alias.fixture=!{self.runner} auth git-credential get', 'fixture',
                          input=f'url={self.url}\n\n')
        self.assertIn('password=[REDACTED]',result.stdout)

    def test_revoked_binding_fails_authentication_but_local_git_still_works(self):
        self.allowed = False
        result = self.git('ls-remote', self.url, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Tool binding unavailable',result.stderr)
        count = self.resolutions
        self.git('-C', str(self.root/'seed'), 'status', '--porcelain')
        self.assertEqual(count,self.resolutions)


if __name__ == '__main__': unittest.main()
