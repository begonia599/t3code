#!/usr/bin/python3 -I
"""Transparent native gh entry point; T3 supplies only this tool's credential."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import time

NATIVE_GH = '/t3-native-tools/gh'
NATIVE_GIT_HTTP = '/t3-native-tools/git-remote-http'
BRIDGE = '/usr/local/libexec/t3code-shell-bridge.py'


def is_git_credential_pipe():
    """Only Git's HTTP transport may receive a credential on its private pipe."""
    if sys.argv[1:] != ['auth', 'git-credential', 'get']:
        return False
    try:
        pipe = os.readlink('/proc/self/fd/1')
        if not pipe.startswith('pipe:['):
            return False
        # /proc may belong to an outer PID namespace in a native sandbox.
        status = Path('/proc/self/status').read_text().splitlines()
        pid = int(next(line.split(':', 1)[1] for line in status if line.startswith('PPid:')))
        for _ in range(8):
            if pid <= 1:
                break
            parent = Path(f'/proc/{pid}')
            if os.path.samefile(parent / 'exe', NATIVE_GIT_HTTP):
                for descriptor in (parent / 'fd').iterdir():
                    if os.readlink(descriptor) != pipe:
                        continue
                    info = (parent / 'fdinfo' / descriptor.name).read_text().splitlines()
                    flags = int(next(line.split(':', 1)[1] for line in info if line.startswith('flags:')), 8)
                    if flags & os.O_ACCMODE == os.O_RDONLY:
                        return True
                return False
            status = (parent / 'status').read_text().splitlines()
            pid = int(next(line.split(':', 1)[1] for line in status if line.startswith('PPid:')))
    except (OSError, ValueError, StopIteration):
        pass
    return False


def tool_environment(environment):
    address = environment.get('T3_CREDENTIAL_SOCKET')
    authorization = environment.get('T3_CREDENTIAL_AUTHORIZATION')
    if not address or not authorization:
        return {}
    # Prefer a live resolution; a disabled/revoked binding cannot fall back to
    # a different host login. Only native AF_UNIX restrictions use the file.
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(20)
            client.connect(address)
            client.sendall(json.dumps({'authorization': authorization, 'tool': 'gh'}).encode()+b'\n')
            with client.makefile('rb') as stream:
                data = stream.readline(131073)
            if len(data) > 131072:
                raise ValueError('Invalid tool response')
            response = json.loads(data)
            if response.get('ok') is not True:
                raise ValueError('The gh tool binding is unavailable; verify it in T3 Resources settings.')
            return response['environment']
    except OSError as error:
        # A normal unreachable broker fails closed. EPERM/EACCES are native
        # sandbox restrictions, not an authorization decision from T3.
        import errno
        if error.errno not in (errno.EPERM, errno.EACCES):
            raise ValueError('The T3 tool credential broker is unavailable.') from None
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    path = Path(address+'.'+hashlib.sha256(authorization.encode()).hexdigest()+'.grant')
    data = path.read_bytes()
    key = hashlib.sha256(b't3-credential-bridge-v1\0'+authorization.encode()).digest()
    payload = json.loads(AESGCM(key).decrypt(data[:12], data[12:], b't3-credential-bridge-v1'))
    gh = payload.get('tools', {}).get('gh')
    if not gh:
        return {}
    if gh.get('error'):
        raise ValueError(gh['error'])
    if gh['expiresAt'] <= time.time()*1000:
        raise ValueError('The gh tool credential expired. Verify the binding in T3; no other credential will be used.')
    return gh['environment']


def main():
    environment = dict(os.environ)
    # Never let an unrelated grant or inherited host login take precedence.
    for name in ('GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_DEBUG', 'GH_CONFIG_DIR'):
        environment.pop(name, None)
    values = tool_environment(environment)
    if not all(isinstance(key, str) and isinstance(value, str) and '\0' not in value for key, value in values.items()) or set(values)-{'GH_TOKEN', 'GH_HOST', 'GH_DEBUG'}:
        raise ValueError('Invalid tool credential response')
    environment.update(values)
    spec = importlib.util.spec_from_file_location('bridge', BRIDGE)
    bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
    # Preserve argv and exit status, including auth token's exact-value output.
    return bridge.execute(NATIVE_GH, ['gh', *sys.argv[1:]], environment,
                          {'GH_TOKEN': values['GH_TOKEN']} if values.get('GH_TOKEN') else {},
                          redact_stdout=not is_git_credential_pipe())


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, ImportError):
        print('T3 gh authentication is unavailable. Check the instance binding in Resources settings; no alternate credential was used.', file=sys.stderr)
        sys.exit(125)
