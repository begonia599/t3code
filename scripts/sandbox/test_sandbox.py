"""Focused launcher tests. Root enables the real OCI tests; no persistent users or profiles."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import socket
import threading
import http.server
import hashlib
import time
import io
import pwd
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("launcher", Path(__file__).with_name("t3code-sandbox.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class OutputTests(unittest.TestCase):
    def bridge(self):
        spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("t3code-shell-bridge.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_short_logs_pass_immediately_and_overlapping_credentials_do_not_leak(self):
        output = self.bridge().OutputFilter(["fixture-token", "fixture-token-long"])
        self.assertEqual(output.feed(b"ready\n"), b"ready\n")
        self.assertEqual(output.feed(b"fixture-t"), b"")
        self.assertEqual(output.feed(b"oken-long\n"), b"[REDACTED]\n")
        self.assertEqual(output.feed(b"fixture-token"), b"")
        self.assertEqual(output.feed(b"", final=True), b"[REDACTED]")

    def test_filters_values_across_every_chunk_boundary_without_changing_other_bytes(self):
        bridge_spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("t3code-shell-bridge.py"))
        bridge = importlib.util.module_from_spec(bridge_spec)
        bridge_spec.loader.exec_module(bridge)
        raw = b"prefix\x00fixture-private-key suffix fixture-private-key\n"
        expected = b"prefix\x00[REDACTED] suffix [REDACTED]\n"
        for split in range(len(raw) + 1):
            output = bridge.OutputFilter(["fixture-private-key", "private-key"])
            self.assertEqual(output.feed(raw[:split]) + output.feed(raw[split:]) + output.feed(b"", final=True), expected)


class RequestTests(unittest.TestCase):
    def setUp(self):
        # Native Codex grants /tmp writes by default, so a real permission
        # test must place the persistent mounts outside that exception.
        self.directory = tempfile.TemporaryDirectory(prefix="t3-sandbox-unit-", dir="/run" if os.geteuid() == 0 else None)
        root = Path(self.directory.name)
        self.policy_patch = patch.object(launcher.resource_policy, "CONFIG", root / "resources.json")
        self.policy_patch.start()
        self.previous_init = launcher.HARNESS_INIT
        launcher.HARNESS_INIT = root / "init.py"
        launcher.HARNESS_INIT.write_bytes(Path(__file__).with_name("t3code-harness-init.py").read_bytes())
        self.profile = {
            "instanceId": "claude-main", "driver": "claudeAgent", "ownerUid": 1000, "ownerGid": 1000,
            "uid": 65534, "gid": 65534, "home": str(root / "home"), "providerHome": str(root / "private"),
            "defaultCwd": str(root / "home"), "workspaces": [str(root / "workspace")],
            "readonlyPaths": [], "path": "/usr/bin:/bin", "network": {"mode": "host"},
        }
        for key in ("home", "providerHome"):
            Path(self.profile[key]).mkdir()
        Path(self.profile["workspaces"][0]).mkdir()
        self.request = {
            "instanceId": "claude-main", "driver": "claudeAgent", "argv": ["/usr/bin/true"],
            "cwd": self.profile["home"],
            "env": {"HOME": self.profile["home"], "CLAUDE_CONFIG_DIR": self.profile["providerHome"], "PATH": "/usr/bin:/bin"},
        }

    def tearDown(self):
        self.policy_patch.stop()
        launcher.HARNESS_INIT = self.previous_init
        self.directory.cleanup()

    def test_owner_mapping_and_no_privileged_provider(self):
        mount = launcher.bind_mount(self.profile["home"], profile=self.profile)
        self.assertIn("ridmap", mount["options"])
        self.assertEqual(mount["uidMappings"], [{"containerID": 1000, "hostID": 65534, "size": 1}])

    def test_rejects_cross_instance_and_escaped_cwd(self):
        for patch in ({"instanceId": "another"}, {"driver": "codex"}, {"cwd": "/etc"}, {"argv": []}, {"argv": ["bad\0arg"]}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                launcher.validate_request(self.profile, {**self.request, **patch})
        escaped = Path(self.profile["home"]) / "escape"
        escaped.symlink_to("/etc")
        with self.assertRaises(ValueError):
            launcher.validate_request(self.profile, {**self.request, "cwd": str(escaped)})

    def test_rejects_home_override_and_manifest_symlink(self):
        with self.assertRaises(ValueError):
            launcher.validate_request(self.profile, {**self.request, "env": {**self.request["env"], "HOME": "/root"}})
        manifest = Path(self.directory.name) / "request.json"
        manifest.write_text(json.dumps(self.request))
        link = manifest.with_suffix(".link")
        link.symlink_to(manifest)
        with self.assertRaises(OSError):
            launcher.read_json_file(link, os.getuid())

    def test_namespace_uses_its_own_dns_configuration(self):
        resolver = Path(self.directory.name) / "resolv.conf"
        resolver.write_text("nameserver 192.0.2.53\n")
        rootfs = Path(self.directory.name) / "rootfs"
        rootfs.mkdir()
        profile = {**self.profile, "network": {"mode": "namespace", "path": "/run/netns/fixture", "resolvConf": str(resolver)}}
        config = launcher.make_config(profile, self.request, rootfs)
        mounts = [mount for mount in config["mounts"] if mount["destination"] == "/etc/resolv.conf"]
        self.assertEqual(len(mounts), 1)
        self.assertEqual(mounts[0]["source"], str(resolver))
        self.assertIn("rro", mounts[0]["options"])
        self.assertIn({"type": "network", "path": "/run/netns/fixture"}, config["linux"]["namespaces"])

    def test_github_helper_is_automatic_without_changing_other_git_hosts(self):
        root = Path(self.directory.name)
        broker = root / "broker"; broker.mkdir()
        native = root / "native-gh"; native.write_text("fixture")
        wrapper = root / "gh-wrapper"; wrapper.write_text("fixture")
        rootfs = root / "rootfs"; rootfs.mkdir()
        request = {**self.request, "env": {**self.request["env"], "GIT_CONFIG_COUNT": "1",
                   "GIT_CONFIG_KEY_0": "user.name", "GIT_CONFIG_VALUE_0": "Fixture"}}
        with patch.object(launcher, "GH_BRIDGE", wrapper), \
             patch.object(launcher, "SHELL_BRIDGE", Path(__file__).with_name("t3code-shell-bridge.py")), \
             patch.object(launcher.shutil, "which", return_value=str(native)):
            config = launcher.make_config({**self.profile, "credentialBrokerDirectory": str(broker)}, request, rootfs)
        environment = dict(value.split("=", 1) for value in config["process"]["env"])
        self.assertNotIn("GH_TOKEN", environment)
        environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=str(root / "gitconfig"))
        # A stale auth setup-git entry must not select the unauthenticated native CLI.
        (root / "gitconfig").write_text('[credential "https://github.com"]\n helper = !/t3-native-tools/gh auth git-credential\n')
        def read(key, url=None):
            args = ["git", "config", *( ["--get-urlmatch", key, url] if url else ["--get", key] )]
            return subprocess.run(args, env=environment, capture_output=True, text=True)
        self.assertEqual(read("user.name").stdout.strip(), "Fixture")
        self.assertEqual(read("credential.helper", "https://github.com/owner/repo").stdout.strip(),
                         "!/t3-tools/gh auth git-credential")
        self.assertEqual(read("credential.helper", "https://gitlab.com/owner/repo").returncode, 1)
        self.assertEqual(read("credential.helper", "http://github.com/owner/repo").returncode, 1)
        transport = next(m for m in config["mounts"] if m["destination"] == "/t3-native-tools/git-remote-http")
        self.assertIn("rro", transport["options"])

    def test_writable_software_keeps_execution_uid_and_shared_memory_is_private(self):
        software = Path(self.directory.name) / "software"
        software.mkdir()
        rootfs = Path(self.directory.name) / "rootfs"
        rootfs.mkdir()
        config = launcher.make_config({**self.profile, "softwareDirectory": str(software)}, self.request, rootfs)
        mount = next(m for m in config["mounts"] if m["destination"] == str(software))
        self.assertNotIn("ridmap", mount["options"])
        self.assertNotIn("rro", mount["options"])
        shm = next(m for m in config["mounts"] if m["destination"] == "/dev/shm")
        self.assertEqual(shm["type"], "tmpfs")
        self.assertIn("mode=1777", shm["options"])

    def test_framework_child_is_readonly_after_its_shared_parent_and_hidden_children_are_masked(self):
        workspace = Path(self.profile["workspaces"][0])
        framework = workspace / "t3code"; framework.mkdir()
        secret = workspace / "state"; secret.mkdir()
        launcher.resource_policy.CONFIG.write_text(json.dumps({"ownerUid": self.profile["ownerUid"], "protectedPaths": [
            {"path": str(framework), "visibility": "read"}, {"path": str(secret), "visibility": "hidden"}]}))
        rootfs = Path(self.directory.name) / "rootfs"; rootfs.mkdir()
        with patch.object(launcher.resource_policy, "load_policy", return_value=json.loads(launcher.resource_policy.CONFIG.read_text())):
            config = launcher.make_config(self.profile, self.request, rootfs)
        mounts = config["mounts"]
        parent = next(i for i, m in enumerate(mounts) if m["destination"] == str(workspace))
        child = next(i for i, m in enumerate(mounts) if m["destination"] == str(framework))
        self.assertGreater(child, parent); self.assertIn("rro", mounts[child]["options"])
        mask = next(m for m in mounts if m["destination"] == str(secret))
        self.assertNotEqual(mask["source"], str(secret)); self.assertIn("rro", mask["options"])

    @unittest.skipUnless(os.geteuid() == 0, "Root-owned profile migration")
    def test_reprovision_preserves_existing_egress_and_mounts(self):
        config = Path(self.directory.name) / "config"
        config.mkdir()
        original = {**self.profile, "network": {"mode": "namespace", "path": "/run/netns/fixture", "resolvConf": "/etc/fixture-resolv.conf"},
                    "mcpHost": "127.0.0.1", "path": "/opt/fixture-node:/usr/bin:/bin"}
        file = config / "fixture.json"
        file.write_text(json.dumps(original))
        args = SimpleNamespace(owner=pwd.getpwuid(original["ownerUid"]).pw_name, profile="fixture", instance=original["instanceId"],
            driver=original["driver"], execution_user=None, workspace=[], readonly=[], network_namespace=None,
            resolv_conf=None, mcp_host=None, path=None)
        with patch.object(launcher, "CONFIG_DIR", config), patch.object(launcher, "STATE_DIR", Path(self.directory.name) / "state"), redirect_stdout(io.StringIO()):
            launcher.provision(args)
            launcher.provision(args)
        updated = json.loads(file.read_text())
        self.assertEqual(updated["network"], original["network"])
        self.assertEqual(updated["mcpHost"], original["mcpHost"])
        self.assertEqual(updated["workspaces"], original["workspaces"])
        self.assertEqual(updated["readonlyPaths"], original["readonlyPaths"])
        self.assertIn("/opt/fixture-node", updated["path"].split(":"))
        self.assertEqual(len(updated["path"].split(":")), len(set(updated["path"].split(":"))))

    @unittest.skipUnless(os.geteuid() == 0, "Root-managed software fixture")
    def test_root_managed_software_preserves_group_execution_identity(self):
        software = Path(self.directory.name) / "software"
        software.mkdir()
        rootfs = Path(self.directory.name) / "rootfs"
        rootfs.mkdir()
        config = launcher.make_config({**self.profile, "readonlyPaths": [str(software)]}, self.request, rootfs)
        mount = next(m for m in config["mounts"] if m["destination"] == str(software))
        self.assertIn("rro", mount["options"])
        self.assertNotIn("ridmap", mount["options"])
        self.assertNotIn("uidMappings", mount)


@unittest.skipUnless(os.geteuid() == 0, "Run with sudo for real OCI verification")
class OciTests(RequestTests):
    def setUp(self):
        super().setUp()
        for path in [self.profile["home"], self.profile["providerHome"], *self.profile["workspaces"]]:
            os.chown(path, 1000, 1000)
            os.chmod(path, 0o700)
        self.runtime = Path(self.directory.name) / "runtime"

    def runner(self, profile, request):
        config = Path(self.directory.name) / "test-input.json"
        config.write_text(json.dumps({"profile": profile, "request": request, "bridge": str(launcher.SHELL_BRIDGE), "init": str(launcher.HARNESS_INIT), "policy": str(launcher.resource_policy.CONFIG)}))
        runner = (
            "import importlib.util,json,sys; from pathlib import Path; "
            "spec=importlib.util.spec_from_file_location('launcher',sys.argv[1]); "
            "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m); "
            "data=json.load(open(sys.argv[2]));m.SHELL_BRIDGE=Path(data['bridge']);m.HARNESS_INIT=Path(data['init']);m.resource_policy.CONFIG=Path(data['policy']);sys.exit(m.run_profile(data['profile'],data['request'],Path(sys.argv[3])))"
        )
        return [sys.executable, "-B", "-c", runner, str(Path(__file__).with_name("t3code-sandbox.py")), str(config), str(self.runtime)]

    def test_framework_is_actually_readonly_while_business_project_can_be_written(self):
        workspace = Path(self.profile['workspaces'][0])
        framework = workspace/'t3code'; framework.mkdir(); os.chown(framework,1000,1000)
        (framework/'source.txt').write_text('original'); os.chown(framework/'source.txt',1000,1000)
        launcher.resource_policy.CONFIG.write_text(json.dumps({'ownerUid':1000,'protectedPaths':[{'path':str(framework),'visibility':'read'}]}))
        script = "from pathlib import Path; import errno; p=Path("+repr(str(framework/'source.txt'))+"); assert p.read_text()=='original';\ntry:p.write_text('changed');raise AssertionError('framework writable')\nexcept OSError as e:assert e.errno==errno.EROFS\nPath("+repr(str(workspace/'business.txt'))+").write_text('ok');print('protected-and-business-writable')"
        result = subprocess.run(self.runner(self.profile,{**self.request,'argv':['/usr/bin/python3','-c',script]}),capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stderr);self.assertIn('protected-and-business-writable',result.stdout)
        self.assertEqual((framework/'source.txt').read_text(),'original')

    def test_granted_shell_preserves_git_protocols_tty_streaming_and_system_tools(self):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        import pty
        import selectors
        bridge = Path(self.directory.name) / "bridge.py"
        bridge.write_bytes(Path(__file__).with_name("t3code-shell-bridge.py").read_bytes())
        launcher.SHELL_BRIDGE, previous = bridge, launcher.SHELL_BRIDGE
        broker = Path(self.directory.name) / "broker"
        broker.mkdir(); os.chown(broker, 1000, 1000)
        address = str(broker / "socket")
        authorization = "Bearer fixture-shell-only"
        nonce = os.urandom(12)
        key = hashlib.sha256(b"t3-credential-bridge-v1\0" + authorization.encode()).digest()
        grants = {"grants": [{"environment": {"APP_KEY": "fixture-private-key"}, "expiresAt": time.time()*1000 + 60000}]}
        file = Path(address + "." + hashlib.sha256(authorization.encode()).hexdigest() + ".grant")
        file.write_bytes(nonce + AESGCM(key).encrypt(nonce, json.dumps(grants).encode(), b"t3-credential-bridge-v1"))
        os.chown(file, 1000, 1000); file.chmod(0o600)
        profile = {**self.profile, "credentialBrokerDirectory": str(broker)}
        environment = {**self.request["env"], "T3_CREDENTIAL_SOCKET": address, "T3_CREDENTIAL_AUTHORIZATION": authorization}
        try:
            command = 'git init -q repo && git init -q --bare remote && cd repo && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -q --allow-empty -m fixture && git push ../remote HEAD:main && python3 -c "import multiprocessing; multiprocessing.Lock(); print(123)" && awk \'BEGIN {print 456}\''
            result = subprocess.run(self.runner(profile, {**self.request, "argv": ["/bin/bash", "-c", command], "env": environment}), capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("123\n456", result.stdout)
            master, slave = pty.openpty()
            # SDK streams use nonterminal OCI stdio. Exercise the filter's
            # terminal branch directly against a real PTY.
            tty_runner = "import importlib.util,sys,os; s=importlib.util.spec_from_file_location('bridge',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); sys.exit(m.execute('/bin/bash',['bash','-c','test -t 1 && echo ready; read answer; printf \"%s\" \"$APP_KEY\"'],dict(os.environ,APP_KEY='fixture-private-key'),{'APP_KEY':'fixture-private-key'}))"
            child = subprocess.Popen([sys.executable, "-B", "-c", tty_runner, str(bridge)], stdin=subprocess.PIPE, stdout=slave, stderr=slave)
            os.close(slave)
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(master, selectors.EVENT_READ)
                    self.assertTrue(selector.select(5), "The shell withheld its ready receipt")
                self.assertIn(b"ready", os.read(master, 1024))
                child.stdin.write(b"continue\n"); child.stdin.flush()
                child.wait(timeout=10)
                self.assertEqual(os.read(master, 1024), b"[REDACTED]")
                self.assertEqual(child.returncode, 0)
            finally:
                if child.poll() is None: child.kill(); child.wait(timeout=10)
                child.stdin.close(); os.close(master)
        finally:
            launcher.SHELL_BRIDGE = previous

    def test_stop_removes_background_processes_and_runtime_state(self):
        request = {**self.request, "argv": ["/usr/bin/python3", "-c",
            "import subprocess,signal; subprocess.Popen(['/usr/bin/sleep','600']); print('ready',flush=True); signal.pause()"]}
        child = subprocess.Popen(self.runner(self.profile, request), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            child.terminate()
            child.communicate(timeout=10)
            self.assertFalse(list((self.runtime / "state").glob("t3-*")))
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=10)

    def test_sdk_inline_mcp_authorization_is_kept_out_of_process_arguments(self):
        config = {"mcpServers": {"fixture": {"type": "http", "url": "http://127.0.0.1/mcp", "headers": {"Authorization": "Bearer fixture-native-only"}}}}
        script = "import json,os,sys;from pathlib import Path; p=Path(sys.argv[-1]); assert p.stat().st_mode & 0o777 == 0o600; token=json.loads(p.read_text())['mcpServers']['fixture']['headers']['Authorization']; assert token.startswith('Bearer '); assert token.encode() not in Path('/proc/self/cmdline').read_bytes();print('private-config-ok')"
        request = {**self.request, "argv": ["/usr/bin/python3", "-I", "-c", script, "--mcp-config", json.dumps(config)]}
        result = subprocess.run(self.runner(self.profile, request), capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "private-config-ok")

    @unittest.skipUnless(os.environ.get("T3_SANDBOX_TEST_BINARIES"), "Native CLI paths were not supplied")
    def test_installed_native_clis_start_inside_sandbox(self):
        binaries = json.loads(os.environ["T3_SANDBOX_TEST_BINARIES"])
        for driver, key in (("claudeAgent", "CLAUDE_CONFIG_DIR"), ("codex", "CODEX_HOME"), ("grok", "GROK_HOME")):
            binary = Path(binaries[driver]).resolve(strict=True)
            profile = {**self.profile, "driver": driver, "readonlyPaths": [str(binary.parent)]}
            request = {**self.request, "driver": driver, "argv": [str(binary), "--version"],
                       "env": {"HOME": profile["home"], key: profile["providerHome"], "PATH": "/usr/bin:/bin"}}
            result = subprocess.run(self.runner(profile, request), input="", capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertRegex(result.stdout, r"\d+\.\d+\.\d+")
            print(f"Native {driver}: {result.stdout.strip()}", file=sys.stderr)

    def test_three_real_identities_share_t3_owned_files(self):
        workspace = Path(self.profile["workspaces"][0])
        secret = Path(self.directory.name) / "server-secret"
        secret.write_text("not mounted")
        for driver, uid, gid, key in (
            ("claudeAgent", 65534, 65534, "CLAUDE_CONFIG_DIR"),
            ("codex", 1, 1, "CODEX_HOME"),
            ("grok", 2, 2, "GROK_HOME"),
        ):
            private = Path(self.directory.name) / f"private-{driver}"
            private.mkdir()
            os.chown(private, 1000, 1000)
            private.chmod(0o700)
            profile = {**self.profile, "driver": driver, "uid": uid, "gid": gid, "providerHome": str(private)}
            script = (
                "import os,sys; from pathlib import Path; "
                f"assert os.getuid()=={uid}; "
                f"assert not Path({str(secret)!r}).exists(); "
                "assert 'T3_HOST_SECRET' not in os.environ; "
                "assert sys.stdin.readline().strip()=='protocol-input'; "
                "Path('test').mkdir(exist_ok=True); Path('test/shared').write_text(str(os.getuid())); "
                "print('protocol-output', flush=True)"
            )
            request = {**self.request, "driver": driver, "argv": ["/usr/bin/python3", "-c", script],
                       "cwd": str(workspace), "env": {"HOME": profile["home"], key: str(private), "PATH": "/usr/bin:/bin"}}
            result = subprocess.run(self.runner(profile, request),
                                    input="protocol-input\n", capture_output=True, text=True, timeout=20,
                                    env={"PATH": "/usr/bin:/bin", "T3_HOST_SECRET": "must not inherit"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "protocol-output")
            self.assertEqual((workspace / "test/shared").stat().st_uid, 1000)
            self.assertEqual((workspace / "test/shared").stat().st_gid, 1000)
            self.assertEqual((workspace / "test/shared").read_text(), str(uid))
        self.assertFalse(list((self.runtime / "state").glob("t3-*")))

    @unittest.skipUnless(os.environ.get("T3_SANDBOX_TEST_BINARIES"), "Native CLI paths were not supplied")
    def test_codex_native_tool_sandbox_preserves_workspace_permissions(self):
        binary = Path(json.loads(os.environ["T3_SANDBOX_TEST_BINARIES"])["codex"]).resolve(strict=True)
        software = binary.parent.parent if (binary.parent.parent / "codex-resources").is_dir() else binary.parent
        profile = {**self.profile, "driver": "codex", "readonlyPaths": [str(software)]}
        script = """import errno, os
from pathlib import Path
assert os.getuid() == 65534
Path('native-tool').write_text('ok')
try:
    (Path.home() / 'outside-workspace').write_text('must fail')
except OSError as error:
    assert error.errno in (errno.EACCES, errno.EPERM, errno.EROFS)
else:
    raise AssertionError('native workspace policy was bypassed')
print('native-tool-ok')
"""
        request = {**self.request, "driver": "codex", "cwd": profile["workspaces"][0],
                   "argv": [str(binary), "sandbox", "-c", 'sandbox_mode="workspace-write"', "--", "/usr/bin/python3", "-c", script],
                   "env": {"HOME": profile["home"], "CODEX_HOME": profile["providerHome"], "PATH": "/usr/bin:/bin"}}
        result = subprocess.run(self.runner(profile, request), capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "native-tool-ok")
        self.assertEqual((Path(request["cwd"]) / "native-tool").stat().st_uid, 1000)
        self.assertFalse((Path(profile["home"]) / "outside-workspace").exists())

    def test_shell_uses_new_grants_with_native_curl_and_filters_output(self):
        bridge = Path(self.directory.name) / "bridge.py"
        bridge.write_bytes(Path(__file__).with_name("t3code-shell-bridge.py").read_bytes())
        bridge.chmod(0o755)
        previous_bridge = launcher.SHELL_BRIDGE
        launcher.SHELL_BRIDGE = bridge
        broker = Path(self.directory.name) / "broker"
        broker.mkdir(); os.chown(broker, 1000, 1000)
        address = str(broker / "socket")
        response = {"ok": True, "environment": {}}
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(address); os.chown(address, 1000, 1000); os.chmod(address, 0o600)
        listener.listen()
        stopping = threading.Event()
        def serve():
            while not stopping.is_set():
                client, _peer = listener.accept()
                with client:
                    data = client.recv(8192)
                    if not data: continue
                    self.assertEqual(json.loads(data)["authorization"], "Bearer fixture-session")
                    client.sendall(json.dumps(response).encode() + b"\n")
        worker = threading.Thread(target=serve, daemon=True); worker.start()
        class Api(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200 if self.headers.get("Authorization") == "Bearer fixture-private-key" else 401)
                self.end_headers(); self.wfile.write(b'{"data":[{"id":"fixture-model"}]}')
            def log_message(self, *_args): pass
        api = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Api)
        api_worker = threading.Thread(target=api.serve_forever, daemon=True); api_worker.start()
        profile = {**self.profile, "credentialBrokerDirectory": str(broker)}
        environment = {**self.request["env"], "T3_CREDENTIAL_SOCKET": address, "T3_CREDENTIAL_AUTHORIZATION": "Bearer fixture-session", "T3_MCP_BEARER_TOKEN": "fixture-native-only"}
        def run(argv):
            return subprocess.run(self.runner(profile, {**self.request, "argv": argv, "env": environment}), capture_output=True, text=True, timeout=20)
        try:
            before = run(["/bin/bash", "-c", 'test -z "$OPENAI_API_KEY" && test -z "$T3_MCP_BEARER_TOKEN"'])
            self.assertEqual(before.returncode, 0, before.stderr)
            response["environment"] = {"OPENAI_API_KEY": "fixture-private-key"}
            command = f'curl --silent --show-error --fail-with-body http://127.0.0.1:{api.server_port}/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"; printf "%s" "$OPENAI_API_KEY" >&2'
            after = run(["/bin/bash", "-c", command])
            self.assertEqual(after.returncode, 0, after.stderr)
            self.assertIn("fixture-model", after.stdout)
            self.assertEqual(after.stderr, "[REDACTED]")
            self.assertNotIn("fixture-private-key", after.stdout)
            descriptor_script = "import os; fd=os.open('/usr/bin/bash',os.O_RDONLY); os.set_inheritable(fd,True); os.execve(fd,['bash','-c','printf \"%s\" \"$OPENAI_API_KEY\"'],dict(os.environ))"
            descriptor_shell = run(["/usr/bin/python3", "-I", "-c", descriptor_script])
            self.assertEqual(descriptor_shell.returncode, 0, descriptor_shell.stderr)
            self.assertEqual(descriptor_shell.stdout, "[REDACTED]")
            # Codex's nested workspace sandbox uses encrypted files without AF_UNIX.
            binaries = json.loads(os.environ.get("T3_SANDBOX_TEST_BINARIES", "{}"))
            if "codex" in binaries:
                from cryptography.hazmat.primitives.ciphers.aead import AESGCM
                authorization = environment["T3_CREDENTIAL_AUTHORIZATION"]
                grant_file = Path(address + "." + hashlib.sha256(authorization.encode()).hexdigest() + ".grant")
                nonce = os.urandom(12)
                key = hashlib.sha256(b"t3-credential-bridge-v1\0" + authorization.encode()).digest()
                grant_payload = json.dumps({"grants": [{"environment": response["environment"], "expiresAt": time.time() * 1000 + 60000}]}).encode()
                grant_file.write_bytes(nonce + AESGCM(key).encrypt(nonce, grant_payload, b"t3-credential-bridge-v1"))
                os.chown(grant_file, 1000, 1000); grant_file.chmod(0o600)
                self.assertNotIn(b"fixture-private-key", grant_file.read_bytes())
                binary = Path(binaries["codex"]).resolve()
                codex_profile = {**profile, "driver": "codex", "readonlyPaths": [str(binary.parent.parent)]}
                codex_environment = {**environment, "CODEX_HOME": profile["providerHome"]}
                request = {**self.request, "driver": "codex", "cwd": profile["workspaces"][0], "env": codex_environment,
                           "argv": [str(binary), "sandbox", "-c", 'sandbox_mode="workspace-write"', "--", "/bin/bash", "-c", 'test "$OPENAI_API_KEY" = "fixture-private-key" && echo native-grant-ok']}
                native = subprocess.run(self.runner(codex_profile, request), capture_output=True, text=True, timeout=20)
                self.assertEqual(native.returncode, 0, native.stderr)
                self.assertEqual(native.stdout.strip(), "native-grant-ok")
                grant_file.unlink()
            response["environment"] = {}
            revoked = run(["/bin/sh", "-c", 'test -z "$OPENAI_API_KEY"'])
            self.assertEqual(revoked.returncode, 0, revoked.stderr)
        finally:
            launcher.SHELL_BRIDGE = previous_bridge
            api.shutdown(); api.server_close(); api_worker.join(timeout=5)
            stopping.set()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as wake: wake.connect(address)
            worker.join(timeout=5); listener.close()


if __name__ == "__main__":
    unittest.main()
