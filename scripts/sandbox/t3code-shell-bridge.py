#!/usr/bin/python3 -I
"""System shell entry point: fetch granted variables, run the original shell, redact output."""
import json
import hashlib
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import time
import errno
import fcntl
import pty
import termios

# The OCI launcher pins this for each canonical shell. execveat callers can
# expose /dev/fd/N as the script name, which does not identify the real shell.
NATIVE_SHELL_NAME = None


class OutputFilter:
    def __init__(self, values):
        self.trie = {}
        for value in {value.encode() for value in values if value}:
            node = self.trie
            for byte in value:
                node = node.setdefault(byte, {})
            node[None] = True
        self.buffer = b""

    def feed(self, chunk, final=False):
        self.buffer += chunk
        output = bytearray()
        position = 0
        while position < len(self.buffer):
            node = self.trie
            end = position
            match = None
            while end < len(self.buffer) and self.buffer[end] in node:
                node = node[self.buffer[end]]
                end += 1
                if None in node:
                    match = end
            # Only an actual possible prefix waits for the next chunk. No
            # idle timer can safely release a partially printed credential.
            if end == len(self.buffer) and not final and any(key is not None for key in node):
                break
            if match is not None:
                output.extend(b"[REDACTED]")
                position = match
            else:
                output.append(self.buffer[position])
                position += 1
        self.buffer = self.buffer[position:]
        return bytes(output)


def is_command_boundary(environment):
    """Use the launcher's PID/executable context, never a process-name guess."""
    root_pid = environment.get("T3_CREDENTIAL_COMMAND_PID")
    if not root_pid:
        return True  # Compatibility with previously installed launchers.
    pid, parent_pid = os.getpid(), os.getppid()
    try:
        # A nested native sandbox can keep the outer /proc mount while its
        # getpid()/getppid() refer to a new namespace. Use the PIDs as seen by
        # the same /proc filesystem used for executable identity below.
        status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
        pid, parent_pid = int(status["Pid"]), int(status["PPid"])
    except (OSError, ValueError, KeyError):
        pass
    if int(root_pid) in (pid, parent_pid):
        return True
    try:
        parent = Path(f"/proc/{parent_pid}/exe").resolve(strict=True)
        roots = [Path(root) for root in json.loads(environment.get("T3_CREDENTIAL_RUNTIME_ROOTS", "[]"))]
        if parent.name not in ("node", "nodejs") and any(parent == root or root in parent.parents for root in roots):
            return True
        # Official npm launchers can have a Node interpreter outside their
        # installation while their entry script remains in that installation.
        argv = Path(f"/proc/{parent_pid}/cmdline").read_bytes().split(b"\0")
        if len(argv) > 1 and argv[1].startswith(b"/"):
            entry = Path(os.fsdecode(argv[1])).resolve(strict=True)
            return any(entry == root or root in entry.parents for root in roots)
    except (OSError, ValueError):
        pass
    return False


def granted_environment(environment):
    address = environment.get("T3_CREDENTIAL_SOCKET")
    authorization = environment.get("T3_CREDENTIAL_AUTHORIZATION")
    if not address or not authorization:
        return {}
    # Codex may deny AF_UNIX entirely inside its native network sandbox. The
    # read-only, session-encrypted grant transport needs no socket syscall.
    grant_file = Path(address + "." + hashlib.sha256(authorization.encode()).hexdigest() + ".grant")
    if grant_file.exists():
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.exceptions import InvalidTag
        data = grant_file.read_bytes()
        key = hashlib.sha256(b"t3-credential-bridge-v1\0" + authorization.encode()).digest()
        try:
            payload = json.loads(AESGCM(key).decrypt(data[:12], data[12:], b"t3-credential-bridge-v1"))
        except InvalidTag:
            raise ValueError("Invalid credential grant") from None
        values = {}
        now = time.time() * 1000
        for grant in payload["grants"]:
            if grant["expiresAt"] > now:
                values.update(grant["environment"])
        if not all(isinstance(key, str) and isinstance(value, str) and "\0" not in value for key, value in values.items()):
            raise ValueError("Invalid environment")
        return values
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect(address)
        client.sendall(json.dumps({"authorization": authorization}).encode() + b"\n")
        with client.makefile("rb") as stream:
            response = stream.readline(4 * 1024 * 1024 + 1)
        if len(response) > 4 * 1024 * 1024:
            raise ValueError("Oversized response")
        payload = json.loads(response)
        if payload.get("ok") is not True or not isinstance(payload.get("environment"), dict):
            raise ValueError("Unavailable grant")
        values = payload["environment"]
        if not all(isinstance(key, str) and isinstance(value, str) and "\0" not in value for key, value in values.items()):
            raise ValueError("Invalid environment")
        return values


def execute(shell, argv, environment, values, *, redact_stdout=True):
    if not values:
        os.execve(shell, argv, environment)
    environment["T3_CREDENTIAL_FILTER_ACTIVE"] = "1"
    channels = []
    child_outputs = []
    slaves = []
    for target in (sys.stdout.buffer, sys.stderr.buffer):
        if target.isatty():
            master, slave = pty.openpty()
            settings = termios.tcgetattr(slave)
            settings[1] &= ~termios.OPOST
            termios.tcsetattr(slave, termios.TCSANOW, settings)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, fcntl.ioctl(target.fileno(), termios.TIOCGWINSZ, b"\0" * 8))
            channels.append((master, target))
            child_outputs.append(slave)
            slaves.append(slave)
        else:
            channels.append((None, target))
            child_outputs.append(subprocess.PIPE)
    try:
        child = subprocess.Popen(argv, executable=shell, env=environment, stdin=sys.stdin.buffer,
                                 stdout=child_outputs[0], stderr=child_outputs[1])
    finally:
        for slave in slaves:
            os.close(slave)
    previous = {}
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        previous[sig] = signal.signal(sig, lambda signum, _frame: child.send_signal(signum) if child.poll() is None else None)
    def resize(_signum, _frame):
        for descriptor, target in channels:
            if descriptor is not None:
                try:
                    fcntl.ioctl(descriptor, termios.TIOCSWINSZ, fcntl.ioctl(target.fileno(), termios.TIOCGWINSZ, b"\0" * 8))
                except OSError:
                    pass
    previous[signal.SIGWINCH] = signal.signal(signal.SIGWINCH, resize)
    selector = selectors.DefaultSelector()
    for index, (stream, (descriptor, target)) in enumerate(zip((child.stdout, child.stderr), channels)):
        selector.register(descriptor if descriptor is not None else stream, selectors.EVENT_READ,
                          (target, OutputFilter(values.values() if index or redact_stdout else [])))
    try:
        while selector.get_map():
            for key, _events in selector.select():
                target, output_filter = key.data
                try:
                    chunk = os.read(key.fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""  # Linux PTYs signal EOF with EIO.
                target.write(output_filter.feed(chunk, final=not chunk))
                target.flush()
                if not chunk:
                    selector.unregister(key.fileobj)
                    os.close(key.fileobj) if isinstance(key.fileobj, int) else key.fileobj.close()
    finally:
        selector.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    code = child.wait()
    return code if code >= 0 else 128 - code


def main():
    name = NATIVE_SHELL_NAME or Path(sys.argv[0]).name
    shell = f"/t3-native-shells/{name}"
    environment = dict(os.environ)
    # Codex's native MCP client needs this in its own process. Ordinary
    # commands use the separate shell bridge or restricted script context.
    environment.pop("T3_MCP_BEARER_TOKEN", None)
    if environment.get("T3_CREDENTIAL_FILTER_ACTIVE") == "1" or not is_command_boundary(environment):
        os.execve(shell, sys.argv, environment)
    try:
        values = granted_environment(environment)
    except (OSError, ValueError, KeyError, TypeError, ImportError):
        print("T3 credentials are unavailable; this command runs without newly granted variables.", file=sys.stderr)
        environment.pop("T3_CREDENTIAL_AUTHORIZATION", None)
        environment.pop("T3_CREDENTIAL_SOCKET", None)
        values = {}
    environment.update(values)
    output_secrets = dict(values)
    authorization = environment.get("T3_CREDENTIAL_AUTHORIZATION")
    if values and authorization:
        output_secrets["T3_CREDENTIAL_AUTHORIZATION"] = authorization
        if authorization.startswith("Bearer "):
            output_secrets["T3_MCP_BEARER_TOKEN"] = authorization[7:]
    return execute(shell, sys.argv, environment, output_secrets)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, ImportError):
        print("T3 could not prepare the authorized shell environment. Request credential access again.", file=sys.stderr)
        sys.exit(125)
