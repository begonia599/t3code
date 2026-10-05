#!/usr/bin/python3 -I
"""Host application broker. Runtime authority never crosses into a Harness."""
import argparse
import copy
import ctypes
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid

_spec = importlib.util.spec_from_file_location('policy', Path(__file__).with_name('t3code_resource_policy.py'))
policy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy)
_native_spec = importlib.util.spec_from_file_location('native_applications', Path(__file__).with_name('t3code_systemd.py'))
native = importlib.util.module_from_spec(_native_spec)
_native_spec.loader.exec_module(native)
_deployment_spec = importlib.util.spec_from_file_location('deployments', Path(__file__).with_name('t3code_deployments.py'))
deployments = importlib.util.module_from_spec(_deployment_spec)
_deployment_spec.loader.exec_module(deployments)
CONFIG = Path('/etc/t3code/resources.json')
PROFILES = Path('/etc/t3code/sandboxes')
STATE = Path('/var/lib/t3code-applications')
BROKER = '/usr/local/libexec/t3code-applications'
DOCKER = '/usr/bin/docker'
CADDY_FRAGMENT = Path('/etc/caddy/t3code-applications.caddy')
NETWORK_CONFIG = Path('/etc/t3code/service-network.json')
NETWORK_STATE = Path('/var/lib/t3code-service-network/state.json')
PUBLICATION_LOCK = Path('/run/t3code-publications.lock')
SLUG = re.compile(r'^[a-z][a-z0-9_-]{0,63}$')
IDENTIFIER = re.compile(r'^[a-f0-9]{32}$')
ENV_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,127}$')
DOMAIN = re.compile(r'^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$')
TERMINAL = {'succeeded', 'failed'}
MAX_OUTPUT = 65536
MAX_LOG = 4 * 1024 * 1024


class BrokerApi:
    def __getattr__(self, name):
        return globals()[name]


def native_backend(config):
    return native.Backend(BrokerApi(), config)


def is_native(release):
    return read(release/'release.json').get('backend', 'docker-compose') == 'systemd'


def require(condition, code, message):
    policy.require(condition, code, message)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'))
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else copy.deepcopy(default)


class Lock:
    def __init__(self, path):
        self.path = path
    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self
    def __exit__(self, *_):
        os.close(self.fd)


def load_config(caller=0):
    config = policy.load_policy()
    owner = pwd.getpwuid(config['ownerUid'])
    require(owner.pw_uid > 0 and caller in (0, owner.pw_uid), 'not_allowed', 'Incorrect T3 host identity.')
    config['ownerGid'] = owner.pw_gid
    config['runtimeUid'] = config['ownerUid']
    config['runtimeGid'] = owner.pw_gid
    return config


def profile_for(config, instance_id):
    selected = config.get('instanceProfiles', {}).get(instance_id)
    if selected:
        require(isinstance(selected, str) and SLUG.fullmatch(selected), 'not_configured', 'Invalid instance profile binding.')
        matches = [policy.trusted_json(PROFILES/(selected+'.json'))]
    else:
        matches = [policy.trusted_json(path) for path in PROFILES.glob('*.json')]
    matches = [profile for profile in matches if profile['instanceId'] == instance_id and profile['ownerUid'] == config['ownerUid']]
    require(len(matches) == 1, 'not_allowed', 'No authorized Linux Harness profile for this instance.')
    return matches[0]


def scope_roots(profile, roots):
    require(isinstance(roots, list) and roots and len(roots) <= 128 and all(isinstance(root, str) and os.path.isabs(root) for root in roots),
            'not_allowed', 'Application management requires an authenticated workspace scope.')
    allowed = [Path(root).resolve() for root in [profile['home'], *profile['workspaces']]]
    return [str(Path(root).resolve()) for root in roots if any(policy.inside(Path(root).resolve(), parent) for parent in allowed)]


def app_dir(identifier):
    require(isinstance(identifier, str) and IDENTIFIER.fullmatch(identifier), 'not_allowed', 'Invalid application identifier.')
    return STATE / 'apps' / identifier


def authorized_app(identifier, roots, config):
    directory = app_dir(identifier)
    app = read(directory / 'application.json')
    require(app is not None, 'not_found', 'The application is not registered with T3.')
    policy.authorized_project(app['projectRoot'], roots, config)
    return directory, app


def release_dir(directory, identifier):
    require(isinstance(identifier, str) and IDENTIFIER.fullmatch(identifier), 'not_allowed', 'Invalid release identifier.')
    target = directory / 'releases' / identifier
    require((target / 'release.json').exists(), 'not_found', 'The release is not registered with this application.')
    return target


def operation_dir(directory, identifier):
    require(isinstance(identifier, str) and IDENTIFIER.fullmatch(identifier), 'not_allowed', 'Invalid operation identifier.')
    target = directory / 'operations' / identifier
    require((target / 'operation.json').exists(), 'not_found', 'The operation is not registered with this application.')
    return target


def redact(text, secrets):
    for secret in sorted(set(secrets), key=len, reverse=True):
        if secret:
            text = text.replace(secret, '[REDACTED]')
    return text


def run(argv, *, timeout=30, stdin=None, env=None, limit=MAX_OUTPUT, secrets=(), log=None):
    """Bound memory, preserve native streams, terminate only our child process group."""
    child = subprocess.Popen(argv, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                             start_new_session=True)
    pending_input = memoryview(stdin.encode()) if stdin is not None else None
    output = [bytearray(), bytearray()]
    truncated = False
    deadline = time.monotonic() + timeout
    timed_out = False
    # Redact before persistence, with one streaming filter for each channel.
    bridge_spec = importlib.util.spec_from_file_location('filter', Path(__file__).with_name('t3code-shell-bridge.py'))
    bridge = importlib.util.module_from_spec(bridge_spec); bridge_spec.loader.exec_module(bridge)
    filters = [bridge.OutputFilter(secrets), bridge.OutputFilter(secrets)]
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ, 0)
        selector.register(child.stderr, selectors.EVENT_READ, 1)
        if child.stdin is not None:
            os.set_blocking(child.stdin.fileno(), False)
            selector.register(child.stdin, selectors.EVENT_WRITE, -1)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                os.killpg(child.pid, signal.SIGKILL)
                deadline = time.monotonic() + 2
            for key, _ in selector.select(max(0, remaining)):
                if key.data == -1:
                    if pending_input:
                        try:
                            written = os.write(key.fd, pending_input[:16384])
                            pending_input = pending_input[written:]
                        except BlockingIOError:
                            continue
                        except BrokenPipeError:
                            pending_input = None
                    if not pending_input:
                        selector.unregister(key.fileobj); key.fileobj.close()
                    continue
                chunk = os.read(key.fd, 65536)
                safe = filters[key.data].feed(chunk, final=not chunk)
                if len(output[key.data]) + len(safe) > limit:
                    truncated = True
                output[key.data].extend(safe[:max(0, limit-len(output[key.data]))])
                if log and safe:
                    append_log(log, 'stdout' if key.data == 0 else 'stderr', safe.decode(errors='replace'))
                if not chunk:
                    selector.unregister(key.fileobj); key.fileobj.close()
    code = child.wait()
    return {'stdout': output[0].decode(errors='replace'), 'stderr': output[1].decode(errors='replace'),
            'exitCode': code, 'truncated': truncated, 'cancelled': timed_out}


def checked_run(argv, code, message, **kwargs):
    result = run(argv, **kwargs)
    require(result['exitCode'] == 0 and not result['cancelled'], code, message)
    return result


def append_log(path, source, text):
    # Cap each operation's persistent log independently from returned output.
    if path.exists() and path.stat().st_size >= MAX_LOG:
        return
    with path.open('a') as stream:
        stream.write(json.dumps({'time': now(), 'source': source, 'text': text[:65536]}) + '\n')
    path.chmod(0o600)


def safe_snapshot(project, target, config):
    """Walk directory descriptors; source files are never followed through symlinks."""
    target.mkdir(parents=True, mode=0o755)
    digest = hashlib.sha256()
    count = size = 0
    exclude = {'.git', '.t3', 'node_modules', '.venv', '__pycache__', '.env', '.npmrc', '.netrc'}
    def walk(fd, relative):
        nonlocal count, size
        destination = target / relative
        destination.mkdir(exist_ok=True, mode=0o755)
        destination.chmod(0o755)
        for name in sorted(os.listdir(fd)):
            if name in exclude or name.startswith('.env.') and not name.endswith(('example', 'sample', 'template')) or name.endswith(('.pem', '.key')):
                continue
            item = relative / name
            original = project / item
            for protected in config['protectedPaths']:
                require(not policy.overlaps(original, Path(protected['path']).resolve()), 'protected_resource', 'Build snapshot includes a protected resource.')
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            count += 1
            require(count <= 100000, 'invalid_manifest', 'Build snapshot contains too many files.')
            digest.update(os.fsencode(str(item)) + b'\0')
            if stat.S_ISDIR(info.st_mode):
                child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    walk(child_fd, item)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(info.st_mode):
                require(info.st_nlink == 1, 'not_allowed', 'Build hard links are not supported; copy the source file into the project.')
                require(info.st_size <= 128 * 1024 * 1024, 'invalid_manifest', 'A build file exceeds 128 MB.')
                source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    require(stat.S_ISREG(os.fstat(source).st_mode), 'invalid_manifest', 'Source changed while taking snapshot.')
                    with os.fdopen(source, 'rb', closefd=False) as stream, (target/item).open('wb') as out:
                        while chunk := stream.read(65536):
                            size += len(chunk)
                            require(size <= 512 * 1024 * 1024, 'invalid_manifest', 'Build snapshot exceeds 512 MB.')
                            digest.update(chunk); out.write(chunk)
                finally:
                    os.close(source)
                (target/item).chmod(0o755 if info.st_mode & 0o111 else 0o644)
                digest.update(b'x' if info.st_mode & 0o111 else b'-')
            elif stat.S_ISLNK(info.st_mode):
                link = os.readlink(name, dir_fd=fd)
                require(not os.path.isabs(link) and policy.inside(original.resolve(), project), 'not_allowed', 'Build symlink escapes the project.')
                digest.update(os.fsencode(link)); (target/item).symlink_to(link)
            else:
                require(False, 'invalid_manifest', 'Only regular files, directories and internal symlinks can be published.')
    source_fd = os.open(project, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        walk(source_fd, Path('.'))
    finally:
        os.close(source_fd)
    return digest.hexdigest()


def local_path(root, value, *, directory=False):
    require(isinstance(value, str) and value and not os.path.isabs(value) and ':' not in value, 'invalid_manifest', 'Use a project-relative path.')
    try:
        path = (root/value).resolve(strict=True)
    except OSError:
        require(False, 'invalid_manifest', 'A manifest path does not exist in the immutable build snapshot.')
    require(policy.inside(path, root.resolve()) and (path.is_dir() if directory else path.is_file()), 'not_allowed', 'Manifest path escapes the build snapshot.')
    return path


def no_interpolation(value):
    if isinstance(value, str):
        return value.replace('$', '$$')
    if isinstance(value, list):
        return [no_interpolation(item) for item in value]
    if isinstance(value, dict):
        return {key: no_interpolation(item) for key, item in value.items()}
    return value


def validate_compose(manifest, source, directory, config, allocated_port):
    """Allow a deliberate Compose subset, then generate the host configuration ourselves."""
    require(isinstance(manifest, dict) and set(manifest) <= {'services', 'volumes', 'name', 'version', 'x-t3'},
            'invalid_manifest', 'Supported Compose roots: services, named volumes and x-t3 credential bindings.')
    services = manifest.get('services')
    require(isinstance(services, dict) and 1 <= len(services) <= 8, 'invalid_manifest', 'Declare between one and eight application services.')
    volumes = manifest.get('volumes', {})
    require(isinstance(volumes, dict) and len(volumes) <= 16 and all(SLUG.fullmatch(name) and value in (None, {}) for name, value in volumes.items()),
            'not_allowed', 'Volumes must be T3-managed named data volumes; external volumes and driver options are not supported.')
    extension = manifest.get('x-t3', {})
    require(isinstance(extension, dict) and set(extension) <= {'credentials'}, 'invalid_manifest', 'Unknown x-t3 option.')
    bindings = extension.get('credentials', {})
    require(isinstance(bindings, dict) and set(bindings) <= set(services), 'invalid_manifest', 'Credential binding names must refer to declared services.')
    output, exposed, credentials = {}, [], set()
    allowed = {'build', 'image', 'command', 'entrypoint', 'environment', 'volumes', 'ports', 'expose',
               'healthcheck', 'depends_on', 'working_dir', 'user', 'init', 'read_only', 'tmpfs',
               'cpus', 'mem_limit', 'pids_limit', 'restart', 'labels'}
    for name, service in services.items():
        require(isinstance(name, str) and SLUG.fullmatch(name) and isinstance(service, dict), 'invalid_manifest', 'Invalid service declaration.')
        require(set(service) <= allowed, 'not_allowed', 'Unsupported Compose authority: privileged, host namespaces, devices, socket, external networks, extends and arbitrary host mounts are not allowed.')
        spec = {key: copy.deepcopy(service[key]) for key in ('command', 'entrypoint', 'working_dir', 'read_only') if key in service}
        for field in ('command', 'entrypoint'):
            require(field not in spec or isinstance(spec[field], str) or isinstance(spec[field], list) and all(isinstance(value, str) for value in spec[field]), 'invalid_manifest', 'Commands must be strings or argv arrays.')
        uid = f"{config['runtimeUid']}:{config['runtimeGid']}"
        require(str(service.get('user', uid)) == uid, 'not_allowed', f'Application containers run as {uid}; root or alternate host identities are not supported.')
        require(service.get('restart', 'unless-stopped') == 'unless-stopped', 'invalid_manifest', 'Managed applications use restart: unless-stopped.')
        spec.update(user=uid, restart='unless-stopped', init=True, cap_drop=['ALL'],
                    security_opt=['no-new-privileges:true'], pids_limit=256,
                    cpus=1, mem_limit='512m', logging={'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}})
        for field in ('cpus', 'mem_limit', 'pids_limit'):
            require(field not in service, 'invalid_manifest', 'Resource limits are selected by the T3 host policy in this release.')
        if 'image' in service:
            require(isinstance(service['image'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}', service['image']), 'invalid_manifest', 'Invalid image reference.')
            spec['image'] = service['image']
        if 'build' in service:
            build = service['build']
            build = {'context': build} if isinstance(build, str) else build
            require(isinstance(build, dict) and set(build) <= {'context', 'dockerfile', 'args', 'target'}, 'not_allowed', 'Build context must be inside the project; additional contexts, SSH and build secrets are not supported.')
            context = local_path(source, build.get('context', '.'), directory=True)
            dockerfile = local_path(context, build.get('dockerfile', 'Dockerfile'))
            # Cache identity is immutable and never overwrites a developer-selected tag.
            spec['image'] = f"t3-app-{directory.parent.parent.name}-{directory.name}-{name}"
            spec['build'] = {'context': str(context), 'dockerfile': str(dockerfile)}
            if 'args' in build:
                require(isinstance(build['args'], dict) and all(ENV_NAME.fullmatch(key) and isinstance(value, str) for key, value in build['args'].items()), 'invalid_manifest', 'Build args must be explicit non-secret string values.')
                spec['build']['args'] = build['args']
            if 'target' in build:
                require(isinstance(build['target'], str) and SLUG.fullmatch(build['target']), 'invalid_manifest', 'Invalid Dockerfile target.')
                spec['build']['target'] = build['target']
        require('image' in spec, 'invalid_manifest', 'Each service requires an image or Dockerfile build.')
        environment = service.get('environment', {})
        require(isinstance(environment, dict) and all(isinstance(key, str) and ENV_NAME.fullmatch(key) and isinstance(value, (str, int, float, bool)) for key, value in environment.items()), 'invalid_manifest', 'Use explicit environment values, not host inheritance or env_file. Secrets use x-t3.credentials.')
        spec['environment'] = {key: str(value) for key, value in environment.items()}
        bound = bindings.get(name, {})
        require(isinstance(bound, dict) and len(bound) <= 32 and all(ENV_NAME.fullmatch(key) and isinstance(value, str) and ENV_NAME.fullmatch(value) for key, value in bound.items()), 'invalid_manifest', 'x-t3.credentials maps environment variable names to vault names.')
        require(not set(bound) & set(environment), 'invalid_manifest', 'Credential environment variables cannot also have literal values.')
        credentials.update(bound.values())
        # Set these only when the server has resolved the vault, not at validation time.
        if bound:
            spec['env_file'] = [{'path': str(directory/f'{name}.env'), 'format': 'raw'}]
        mounts = []
        for mount in service.get('volumes', []):
            require(isinstance(mount, str), 'invalid_manifest', 'Use named:/absolute/path or ./relative:/absolute/path:ro volume declarations.')
            parts = mount.split(':')
            require(len(parts) in (2, 3) and parts[1].startswith('/') and parts[1] not in ('/', '/proc', '/sys', '/dev') and (len(parts) == 2 or parts[2] in ('ro', 'rw')), 'not_allowed', 'Invalid volume declaration.')
            origin, destination = parts[:2]
            if origin in volumes:
                host = directory.parent.parent/'data'/origin
                host.mkdir(parents=True, exist_ok=True, mode=0o750)
                os.chown(host, config['runtimeUid'], config['runtimeGid'])
                mounts.append({'type': 'bind', 'source': str(host), 'target': destination, 'read_only': len(parts) == 3 and parts[2] == 'ro', 'bind': {'create_host_path': False}})
            else:
                require(origin.startswith('./') and len(parts) == 3 and parts[2] == 'ro', 'not_allowed', 'Project mounts must be relative read-only snapshot paths. Use named volumes for persistent data.')
                host = local_path(source, origin, directory=True)
                mounts.append({'type': 'bind', 'source': str(host), 'target': destination, 'read_only': True, 'bind': {'create_host_path': False}})
        if mounts:
            spec['volumes'] = mounts
        ports = service.get('ports', [])
        require(isinstance(ports, list) and len(ports) <= 8, 'invalid_manifest', 'Invalid application port list.')
        spec['ports'] = []
        for selected in ports:
            require(isinstance(selected, (str, int)) and re.fullmatch(r'[0-9]{1,5}', str(selected)), 'not_allowed', 'Declare container ports only, e.g. "8080". T3 allocates loopback host ports.')
            port = int(selected)
            require(1 <= port <= 65535, 'invalid_manifest', 'Invalid container port.')
            host_port = allocated_port()
            spec['ports'].append({'target': port, 'published': str(host_port), 'host_ip': '127.0.0.1', 'protocol': 'tcp'})
            exposed.append({'service': name, 'containerPort': port, 'hostPort': host_port})
        if 'expose' in service:
            require(isinstance(service['expose'], list) and all(str(value).isdigit() and 1 <= int(value) <= 65535 for value in service['expose']), 'invalid_manifest', 'Invalid internal port list.')
            spec['expose'] = service['expose']
        health = service.get('healthcheck')
        require(isinstance(health, dict) and set(health) <= {'test', 'interval', 'timeout', 'retries', 'start_period', 'start_interval'} and isinstance(health.get('test'), list) and len(health['test']) >= 2 and health['test'][0] in ('CMD', 'CMD-SHELL') and all(isinstance(value, str) for value in health['test']), 'invalid_manifest', 'Every managed service requires an explicit Compose healthcheck. One-shot jobs are not supported.')
        spec['healthcheck'] = health
        if 'depends_on' in service:
            dependencies = service['depends_on']
            require(isinstance(dependencies, (dict, list)) and set(dependencies) <= set(services) and name not in dependencies, 'invalid_manifest', 'Dependencies must refer to services in this application.')
            if isinstance(dependencies, dict):
                require(all(isinstance(value, dict) and set(value) <= {'condition', 'required'} and value.get('condition', 'service_started') in ('service_started', 'service_healthy') for value in dependencies.values()), 'invalid_manifest', 'Unsupported dependency condition.')
            spec['depends_on'] = dependencies
        if 'tmpfs' in service:
            require(isinstance(service['tmpfs'], list) and all(isinstance(value, str) and re.fullmatch(r'/[A-Za-z0-9/_-]+(?:\:size=[0-9]+[mk])?', value) for value in service['tmpfs']), 'invalid_manifest', 'Use absolute tmpfs paths with optional size limits.')
            spec['tmpfs'] = service['tmpfs']
        require('labels' not in service, 'not_allowed', 'Container labels are controlled by T3.')
        spec['labels'] = {'t3.application': directory.parent.parent.name, 't3.release': directory.name}
        output[name] = no_interpolation(spec)
    return {'services': output}, exposed, bindings, sorted(credentials)


def all_apps():
    return [(path.parent, read(path)) for path in (STATE/'apps').glob('*/application.json')]


def allocate_port(config):
    used = {port['hostPort'] for root, _ in all_apps() for path in (root/'releases').glob('*/release.json') for port in read(path).get('ports', [])}
    low, high = config['applications'].get('portRange', [42000, 45999])
    require(type(low) is int and type(high) is int and 1024 <= low <= high <= 65535, 'not_configured', 'Invalid host port range.')
    def allocate():
        for value in range(low, high+1):
            if value in used or value in config.get('reservedPorts', []):
                continue
            with socket.socket() as test:
                try:
                    test.bind(('127.0.0.1', value))
                except OSError:
                    continue
            used.add(value)
            return value
        require(False, 'not_configured', 'No loopback application ports are available.')
    return allocate


def checked_hostname(hostname, application_id, config):
    if hostname is None:
        return
    require(isinstance(hostname, str) and DOMAIN.fullmatch(hostname) and any(hostname.endswith('.'+suffix) for suffix in config['applications'].get('allowedDomainSuffixes', [])), 'not_allowed', 'Choose a dedicated hostname in the allowed publication domains.')
    require(hostname not in config.get('reservedHosts', []) and not any(hostname == app.get('hostname') and app['id'] != application_id for _, app in all_apps()), 'protected_resource', 'Hostname belongs to a protected or registered service.')
    if NETWORK_CONFIG.exists():
        network = policy.trusted_json(NETWORK_CONFIG)
        require(hostname not in [network['publicHost'], *network.get('reservedHosts', [])], 'protected_resource', 'Hostname belongs to the management framework.')
    if NETWORK_STATE.exists():
        require(not any(hostname == publication['hostname'] for publication in read(NETWORK_STATE)['publications']), 'not_allowed', 'Hostname belongs to a temporary service publication.')


def public_app(app):
    return {key: app[key] for key in ('id', 'name', 'projectRoot', 'createdBy', 'createdAt', 'updatedAt', 'state') if key in app} | {key: app[key] for key in ('currentReleaseId', 'latestOperationId', 'hostname', 'url', 'backend', 'deploymentProfile') if key in app}


def prepare(profile, roots, payload, config):
    require(set(payload) <= {'projectRoot', 'manifestPath', 'name', 'applicationId', 'hostname', 'httpService', 'httpPort', 'backend', 'deploymentProfile'}, 'invalid_manifest', 'Unexpected publication fields.')
    project = policy.authorized_project(payload.get('projectRoot', ''), roots, config)
    identifier = payload.get('applicationId') or uuid.uuid4().hex
    directory = app_dir(identifier)
    if payload.get('applicationId'):
        _, app = authorized_app(identifier, roots, config)
        require(app['projectRoot'] == str(project), 'not_allowed', 'An application cannot be moved to another project.')
        busy(directory)
    else:
        name = payload.get('name')
        require(isinstance(name, str) and SLUG.fullmatch(name), 'invalid_manifest', 'Choose an application name such as my-blog.')
        require(not any(item['projectRoot'] == str(project) and item['name'] == name for _, item in all_apps()), 'not_allowed', 'Application name is already registered in this project; supply applicationId to update it.')
        app = {'id': identifier, 'name': name, 'projectRoot': str(project), 'createdBy': profile['instanceId'], 'createdAt': now(), 'state': 'unpublished'}
    backend = payload.get('backend', app.get('backend', 'docker-compose'))
    require(backend in ('docker-compose', 'systemd'), 'invalid_manifest', 'Unknown application backend.')
    identity = payload.get('deploymentProfile', app.get('deploymentProfile'))
    if payload.get('applicationId'):
        require(backend == app.get('backend', 'docker-compose') and identity == app.get('deploymentProfile'),
                'not_allowed', 'Create a new application to change backend or deployment profile.')
    if backend == 'systemd':
        native_backend(config).authorized_profile(identity, project, app['name'], profile['instanceId'])
        require(not payload.get('hostname') and 'httpService' not in payload and 'httpPort' not in payload,
                'not_supported', 'Native services have no public route. Use Docker Compose for managed HTTP publishing.')
        app['deploymentProfile'] = identity
    else:
        require(config.get('applications', {}).get('enabled') is True, 'not_configured', 'Docker hosting is not enabled.')
        require(identity is None, 'invalid_manifest', 'Deployment profiles apply to systemd applications.')
    app['backend'] = backend
    hostname = payload.get('hostname', app.get('hostname'))
    checked_hostname(hostname, identifier, config)
    release_id, operation_id = uuid.uuid4().hex, uuid.uuid4().hex
    release = directory/'releases'/release_id
    snapshot = release/'source'
    try:
        digest = safe_snapshot(project, snapshot, config)
        manifest_path = payload.get('manifestPath', 'application.yaml' if backend == 'systemd' else 'compose.yaml')
        path = local_path(snapshot, manifest_path)
        require(path.stat().st_size < 1024*1024, 'invalid_manifest', 'Application declaration is too large.')
        import yaml
        declaration = yaml.safe_load(path.read_text())
        if backend == 'systemd':
            spec, bindings, names = native_backend(config).validate(declaration, snapshot, app, identity, profile['instanceId'])
            ports, compose = [], {'services': {'service': {}}}
            atomic(release/'native.json', spec)
        else:
            compose, ports, bindings, names = validate_compose(declaration, snapshot, release, config, allocate_port(config))
        endpoint = None
        if ports:
            matched = [port for port in ports if port['service'] == payload.get('httpService', ports[0]['service']) and port['containerPort'] == payload.get('httpPort', ports[0]['containerPort'])]
            require(len(matched) == 1, 'invalid_manifest', 'Select exactly one published container HTTP port.')
            endpoint = matched[0]
        require(hostname is None or endpoint is not None, 'invalid_manifest', 'A public application requires a declared HTTP port.')
        # Git is run as the owner and never receives credential material.
        git = run(['/usr/sbin/runuser', '-u', pwd.getpwuid(config['ownerUid']).pw_name, '--', '/usr/bin/git', '-C', str(project), 'rev-parse', 'HEAD'], timeout=5)
        source_commit = git['stdout'].strip() if git['exitCode'] == 0 and re.fullmatch(r'[a-f0-9]{40,64}', git['stdout'].strip()) else None
        record = {'id': release_id, 'applicationId': identifier, 'createdAt': now(), 'createdBy': profile['instanceId'], 'snapshotDigest': digest,
                  'manifestPath': manifest_path, 'credentialNames': names, 'credentialVersions': {}, 'ports': ports, 'hostname': hostname,
                  'endpoint': endpoint, 'backend': backend, 'status': 'prepared',
                  'components': list(compose['services']), 'images': {}, 'sourceCommit': source_commit}
        if backend == 'systemd':
            record.update(deploymentProfile=identity, runtimeUser=spec['profile']['runtimeUser'])
        else:
            record['composeProject'] = f't3app-{identifier}-{release_id}'
            atomic(release/'compose.json', compose)
        atomic(release/'bindings.json', bindings)
        atomic(release/'release.json', record)
        operation = {'id': operation_id, 'applicationId': identifier, 'releaseId': release_id, 'action': 'publish', 'stage': 'validating', 'createdAt': now(), 'updatedAt': now(), 'actor': profile['instanceId']}
        atomic(directory/'operations'/operation_id/'operation.json', operation)
        app.update(latestOperationId=operation_id, updatedAt=now())
        atomic(directory/'application.json', app)
        return {'application': public_app(app), 'release': record, 'operation': operation}
    except Exception:
        import shutil
        shutil.rmtree(release, ignore_errors=True)
        if not (directory/'application.json').exists():
            shutil.rmtree(directory, ignore_errors=True)
        raise


def reconcile_operation(directory, operation_path):
    operation = read(operation_path)
    stage = operation['stage']
    if stage in TERMINAL:
        return operation
    if stage == 'validating':
        age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(operation['updatedAt'])).total_seconds()
        if age < 300:
            return operation
        message = 'The credential preparation expired before a worker started. Publish again.'
    else:
        unit = run(['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value',
                    't3-application-'+operation['id']+'.service'], timeout=10)
        if unit['exitCode'] == 0 and unit['stdout'].strip() in ('active', 'activating', 'deactivating'):
            return read(operation_path)
        # The worker may have written its final receipt while systemd was read.
        operation = read(operation_path)
        if operation['stage'] in TERMINAL:
            return operation
        message = 'The independent application worker was interrupted. Inspect current containers and routes before retrying; no recovery result is assumed.'
        log = operation_path.parent/'output.jsonl'
        capture_pending_diagnostic(directory, log)
        release = release_dir(directory, operation['releaseId'])
        target = begin_diagnostic(release, 't3-application-'+operation['id']+'.service', 'worker', since=operation['createdAt'])
        capture_diagnostic(release, target, log=log)
    result = operation_update(operation_path, 'failed', failedStage=stage, finishedAt=now(),
                              error={'code': 'internal_error', 'message': message})
    release = release_dir(directory, operation['releaseId'])
    metadata = read(release/'release.json')
    if metadata['status'] == 'prepared':
        metadata['status'] = 'failed'; atomic(release/'release.json', metadata)
    return result


def busy(directory):
    app = read(directory/'application.json')
    latest = app.get('latestOperationId')
    if latest:
        operation = reconcile_operation(directory, directory/'operations'/latest/'operation.json')
        require(operation.get('stage') in TERMINAL, 'operation_busy', 'Another application operation is still running.')


def install_values(release, values, versions):
    metadata = read(release/'release.json')
    require(isinstance(values, dict) and set(values) == set(metadata['credentialNames']) and all(isinstance(value, str) and '\0' not in value and '\n' not in value and '\r' not in value for value in values.values()), 'credential_expired', 'Resolve all bound vault values; multiline environment credentials are not supported.')
    require(isinstance(versions, dict) and set(versions) == set(values) and all(type(value) is int for value in versions.values()), 'credential_expired', 'Credential versions must accompany the application bindings.')
    for name, binding in read(release/'bindings.json').items():
        path = release/f'{name}.env'
        path.write_text(''.join(f'{key}={values[value]}\n' for key, value in binding.items()))
        path.chmod(0o600)
    # Redaction values stay in the private host runtime record, never in MCP results.
    atomic(release/'secrets.json', values)
    metadata['credentialVersions'] = versions
    atomic(release/'release.json', metadata)


def compose_command(release, *args):
    metadata = read(release/'release.json')
    return [DOCKER, 'compose', '--ansi', 'never', '--env-file', '/dev/null', '--project-name', metadata['composeProject'], '--file', str(release/'compose.json'), *args]


def operation_update(operation_path, stage, **fields):
    operation = read(operation_path)
    operation.update(stage=stage, updatedAt=now(), **fields)
    atomic(operation_path, operation)
    return operation


def begin_diagnostic(release, unit, phase, *, log=None, step=None, since=None):
    target = {'id': uuid.uuid4().hex, 'releaseId': release.name, 'unit': unit,
              'phase': phase, 'since': since or now()}
    if step is not None: target['step'] = step
    if log: atomic(log.parent/'diagnostic-target.json', target)
    return target


def capture_diagnostic(release, target, *, result=None, log=None):
    try:
        return _capture_diagnostic(release, target, result=result, log=log)
    except Exception:
        # Disk/full or collection failures must not stop service cleanup or rollback.
        return {key: target[key] for key in ('id', 'releaseId', 'unit', 'phase')} | {
            'capturedAt': now(), 'state': {}, 'stateAvailable': False, 'journal': '',
            'journalStatus': 'unavailable', 'truncated': False,
            'collectionError': 'Could not collect or save deployment diagnostics.'}


def _capture_diagnostic(release, target, *, result=None, log=None):
    """Read only a broker-selected unit; save bounded, redacted evidence before cleanup."""
    operation_path = log.parent/'operation.json' if log else None
    if operation_path:
        for saved in read(operation_path).get('diagnostics', []):
            if saved['id'] == target['id']: return saved
    secrets = list(read(release/'secrets.json', {}).values())
    fields = ('LoadState', 'ActiveState', 'SubState', 'Result', 'ExecMainCode',
              'ExecMainStatus', 'ConditionResult', 'AssertResult', 'NRestarts', 'InvocationID')
    diagnostic = {key: target[key] for key in ('id', 'releaseId', 'unit', 'phase', 'step') if key in target}
    diagnostic.update(capturedAt=now(), state={}, stateAvailable=False, journal='', journalStatus='unavailable', truncated=False)
    errors = []

    def query(argv, limit):
        try:
            value = run(argv, timeout=3, limit=limit, secrets=secrets)
            diagnostic['truncated'] |= value.get('truncated', False)
            if value['exitCode'] == 0 and not value.get('cancelled'): return value['stdout']
            errors.append(redact(value.get('stderr', ''), secrets)[:2048] or 'Diagnostic query failed or timed out.')
        except Exception:
            # Observability must never replace the original failure or prevent cleanup.
            errors.append('Diagnostic query could not be executed.')
        return None

    output = query(['/usr/bin/systemctl', 'show', target['unit'], '--property='+','.join(fields)], 8192)
    if output is not None:
        diagnostic['state'] = {key: redact(value, secrets)[:256] for line in output.splitlines()
                               if '=' in line for key, value in [line.split('=', 1)] if key in fields}
        diagnostic['stateAvailable'] = bool(diagnostic['state']) and diagnostic['state'].get('LoadState') != 'not-found'
    journal = query(['/usr/bin/journalctl', '--no-pager', '--output=short-iso-precise', '--lines=40', '--reverse',
                     '--unit='+target['unit'], '--since='+target['since'], '--until='+diagnostic['capturedAt']], 16384)
    if journal is not None:
        journal = redact(journal, secrets)
        diagnostic['journal'] = journal[:16384]
        diagnostic['journalStatus'] = 'available' if journal.strip() and journal.strip() != '-- No entries --' else 'empty'
        diagnostic['truncated'] |= len(journal) > 16384
    if errors: diagnostic['collectionError'] = '\n'.join(errors)
    if result:
        diagnostic.update(commandExitCode=result['exitCode'], cancelled=bool(result.get('cancelled')) or diagnostic['state'].get('Result') == 'timeout')
        for stream in ('stdout', 'stderr'):
            output = redact(result.get(stream, ''), secrets)
            diagnostic[stream] = output[-4096:]
            diagnostic['truncated'] |= len(output) > 4096
        diagnostic['truncated'] |= result.get('truncated', False)
    if log:
        operation = read(operation_path)
        operation['diagnostics'] = [*operation.get('diagnostics', []), diagnostic][-6:]
        atomic(operation_path, operation)
        header = {key: value for key, value in diagnostic.items() if key not in ('journal', 'stdout', 'stderr')}
        append_log(log, 'diagnostic', json.dumps(header, ensure_ascii=False))
        for source in ('stdout', 'stderr', 'journal'):
            for line in diagnostic.get(source, '').splitlines(): append_log(log, source, line[:8192])
    return diagnostic


def capture_pending_diagnostic(directory, log):
    try:
        target = read(log.parent/'diagnostic-target.json', None)
        if target:
            return capture_diagnostic(release_dir(directory, target['releaseId']), target, log=log)
    except Exception:
        return None


def start_worker(directory, operation, config):
    operation_path = directory/'operations'/operation['id']/'operation.json'
    operation_update(operation_path, 'queued')
    result = run(['/usr/bin/systemd-run', '--quiet', '--collect', '--unit', 't3-application-'+operation['id'],
                  '--property=Type=exec', '--property=UMask=0077', '--property=TimeoutStartSec=infinity',
                  '--property=MemoryHigh=384M', '--property=MemoryMax=512M', '--property=MemorySwapMax=0',
                  '--property=CPUQuota=100%', '--property=TasksMax=128',
                  BROKER, 'worker', directory.name, operation['id']], timeout=10)
    if result['exitCode'] or result.get('cancelled'):
        release = release_dir(directory, operation['releaseId'])
        target = begin_diagnostic(release, 't3-application-'+operation['id']+'.service', 'worker', since=operation['createdAt'])
        capture_diagnostic(release, target, result=result, log=operation_path.parent/'output.jsonl')
        operation_update(operation_path, 'failed', failedStage='queued', finishedAt=now(), error={'code': 'start_failed', 'message': 'Could not start the independent T3 application job. Inspect operation diagnostics.'})
        require(False, 'start_failed', 'Could not start the independent T3 application job.')


def caddy_text():
    result = '# T3 managed applications\n'
    for directory, app in all_apps():
        if app.get('state') != 'running' or not app.get('hostname') or not app.get('currentReleaseId'):
            continue
        metadata = read(directory/'releases'/app['currentReleaseId']/'release.json')
        result += f"{app['hostname']} {{\n reverse_proxy 127.0.0.1:{metadata['endpoint']['hostPort']} {{\n  header_down X-T3-Release {metadata['id']}\n }}\n}}\n\n"
    return result


def apply_routes():
    content = caddy_text()
    old = CADDY_FRAGMENT.read_text() if CADDY_FRAGMENT.exists() else '# T3 managed applications\n'
    if content == old:
        return
    CADDY_FRAGMENT.parent.mkdir(exist_ok=True)
    CADDY_FRAGMENT.write_text(content); CADDY_FRAGMENT.chmod(0o644)
    try:
        checked_run(['/usr/bin/caddy', 'validate', '--config', '/etc/caddy/Caddyfile'], 'route_failed', 'The Caddy application route failed validation.')
        checked_run(['/usr/bin/systemctl', 'reload', 'caddy.service'], 'route_failed', 'Caddy could not apply the application route.')
    except Exception:
        CADDY_FRAGMENT.write_text(old)
        run(['/usr/bin/systemctl', 'reload', 'caddy.service'])
        raise


def verify_public_route(metadata):
    if not metadata.get('hostname'):
        return
    # A successful Caddy reload does not establish DNS, TLS or the selected
    # backend. Probe the public URL and its immutable release marker. Root may
    # legitimately return 404 or require authentication, so do not require 200.
    result = run(['/usr/bin/curl', '--silent', '--show-error', '--noproxy', '*',
                  '--connect-timeout', '5', '--max-time', '10', '--retry', '5',
                  '--retry-delay', '2', '--retry-all-errors', '--retry-max-time', '60',
                  '--dump-header', '-', '--output', '/dev/null',
                  'https://'+metadata['hostname']+'/'], timeout=75)
    marker = 'x-t3-release: '+metadata['id']
    statuses = re.findall(r'^HTTP/\S+\s+(\d{3})', result['stdout'], re.MULTILINE)
    require(result['exitCode'] == 0 and not result['cancelled'] and
            statuses and 200 <= int(statuses[-1]) < 500 and
            marker in [line.strip().lower() for line in result['stdout'].splitlines()],
            'route_failed', 'The public HTTPS URL did not reach this release. Check DNS, TLS and Caddy; the previous application route is restored.')


def inspect_runtime(release):
    result = run(compose_command(release, 'ps', '--all', '--format', 'json'), timeout=10, limit=256*1024)
    if result['exitCode'] != 0:
        return [], False
    try:
        text = result['stdout'].strip()
        rows = json.loads(text) if text.startswith('[') else [json.loads(line) for line in text.splitlines() if line]
        identities = [item['ID'] for item in rows]
        details = run([DOCKER, 'inspect', *identities], timeout=10, limit=1024*1024) if identities else {'stdout': '[]', 'exitCode': 0}
        require(details['exitCode'] == 0, 'start_failed', 'Cannot inspect registered application containers.')
        entries = []
        for item in json.loads(details['stdout']):
            state = item['State']
            entries.append({'component': item['Config']['Labels']['com.docker.compose.service'], 'state': state['Status'],
                            'health': state.get('Health', {}).get('Status', 'unknown'), 'exitCode': state['ExitCode'],
                            'restartCount': item['RestartCount'], 'startedAt': state['StartedAt'], 'image': item['Image'],
                            'user': item['Config'].get('User', ''), 'command': item['Config'].get('Cmd') or []})
        return entries, True
    except (ValueError, KeyError, TypeError):
        return [], False


def ensure_builder(config):
    """Only our recorded builder is configured; never change the host's default builder."""
    limits = native.budgets(config.get('applications', {}).get('build', {}), native.DEFAULT_BUILD, require)
    path = STATE/'buildkit.json'
    record = read(path)
    if record:
        require(isinstance(record.get('name'), str) and re.fullmatch(r't3-app-build-[a-f0-9]{32}', record['name']), 'not_configured', 'Invalid managed build worker record.')
    if record and record.get('limits') != limits:
        checked_run([DOCKER, 'buildx', 'stop', record['name']], 'build_failed', 'Could not stop the previous managed builder.', timeout=60)
        record = None
    if not record:
        record = {'name': 't3-app-build-'+uuid.uuid4().hex, 'limits': limits}
        atomic(path, record)
    name = record['name']
    require(re.fullmatch(r't3-app-build-[a-f0-9]{32}', name), 'not_configured', 'Invalid managed build worker record.')
    inspected = run([DOCKER, 'buildx', 'inspect', name], timeout=15)
    if inspected['exitCode'] != 0:
        args = [DOCKER, 'buildx', 'create', '--name', name, '--node', name+'0', '--driver', 'docker-container']
        options = {'memory': str(limits['memoryMiB'])+'m', 'memory-swap': str(limits['memoryMiB'])+'m',
                   'cpu-period': '100000', 'cpu-quota': str(limits['cpuPercent']*1000),
                   'default-load': 'true', 'restart-policy': 'no'}
        for key, value in options.items(): args += ['--driver-opt', key+'='+value]
        checked_run(args, 'build_failed', 'Could not create the resource-limited BuildKit worker.', timeout=30)
    else:
        require(re.search(r'^Driver:\s+docker-container\s*$', inspected['stdout'], re.MULTILINE) is not None, 'not_configured', 'The managed builder must use docker-container; no default-builder fallback is permitted.')
    checked_run([DOCKER, 'buildx', 'inspect', '--bootstrap', name], 'build_failed', 'Could not start the managed BuildKit worker.', timeout=120)
    container = 'buildx_buildkit_'+name+'0'
    checked_run([DOCKER, 'update', '--memory', str(limits['memoryMiB'])+'m', '--memory-swap', str(limits['memoryMiB'])+'m',
                 '--cpu-period', '100000', '--cpu-quota', str(limits['cpuPercent']*1000), '--pids-limit', str(limits['tasks']), container],
                'build_failed', 'Could not apply the BuildKit resource budget.')
    result = checked_run([DOCKER, 'inspect', container, '--format', '{{json .HostConfig}}'], 'build_failed', 'Could not verify the BuildKit resource budget.')
    actual = json.loads(result['stdout'])
    require(actual.get('Memory') == limits['memoryMiB']*1024*1024 and actual.get('MemorySwap') == limits['memoryMiB']*1024*1024 and
            actual.get('CpuPeriod') == 100000 and actual.get('CpuQuota') == limits['cpuPercent']*1000 and actual.get('PidsLimit') == limits['tasks'],
            'build_failed', 'The actual BuildKit resource budget does not match host policy.')
    return name, limits


def build_compose(release, config, log, secrets):
    with Lock(STATE/'build.lock'):
        compose = read(release/'compose.json')
        if not any('build' in item for item in compose['services'].values()): return
        builder = None
        try:
            builder, limits = ensure_builder(config)
            checked_run(compose_command(release, 'build', '--pull', '--builder', builder), 'build_failed',
                        'Docker image build failed. Read this operation\'s build logs.', timeout=limits['timeoutSeconds'], secrets=secrets, log=log)
        finally:
            builder = builder or read(STATE/'buildkit.json', {}).get('name')
            if builder and re.fullmatch(r't3-app-build-[a-f0-9]{32}', builder):
                checked_run([DOCKER, 'buildx', 'stop', builder], 'build_failed', 'Could not stop the managed build worker.', timeout=60)


def worker(identifier, operation_id, config):
    directory = app_dir(identifier)
    if read(directory/'application.json').get('backend') == 'systemd':
        return native_backend(config).worker(directory, operation_id)
    operation_path = operation_dir(directory, operation_id)/'operation.json'
    operation = read(operation_path)
    release = release_dir(directory, operation['releaseId']) if operation.get('releaseId') else None
    log = operation_path.with_name('output.jsonl')
    secrets = list(read(release/'secrets.json', {}).values()) if release else []
    previous = copy.deepcopy(read(directory/'application.json'))
    old_release = release_dir(directory, previous['currentReleaseId']) if previous.get('currentReleaseId') else None
    old_stopped = False
    try:
        action = operation['action']
        if action in ('publish', 'rollback', 'start', 'restart'):
            if action == 'publish':
                operation_update(operation_path, 'building')
                build_compose(release, config, log, secrets)
                checked_run(compose_command(release, 'pull', '--ignore-buildable'), 'build_failed', 'Application image pull failed.', timeout=600, secrets=secrets, log=log)
                compose = read(release/'compose.json')
                for service in compose['services'].values():
                    image = checked_run([DOCKER, 'image', 'inspect', service['image'], '--format', '{{.Id}}'], 'build_failed', 'Could not pin the built application image.', secrets=secrets, log=log)['stdout'].strip()
                    require(re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'build_failed', 'Docker returned an invalid immutable image identity.')
                    service['image'] = image
                atomic(release/'compose.json', compose)
            operation_update(operation_path, 'starting')
            # Stop the old group before starting a new one. This prevents concurrent
            # writers to shared persistent volumes; first release is explicitly a
            # replace strategy, not a zero-downtime promise.
            if old_release and old_release != release and previous['state'] == 'running':
                checked_run(compose_command(old_release, 'stop', '--timeout', '15'), 'start_failed', 'Could not stop the previous application version.', secrets=list(read(old_release/'secrets.json', {}).values()), log=log)
                old_stopped = True
            if action == 'restart':
                checked_run(compose_command(release, 'restart', '--timeout', '15'), 'start_failed', 'Application restart failed.', timeout=60, secrets=secrets, log=log)
            else:
                checked_run(compose_command(release, 'up', '--detach', '--no-build', '--pull', 'never'), 'start_failed', 'Docker could not start the application containers.', timeout=60, secrets=secrets, log=log)
            operation_update(operation_path, 'checking-health')
            checked_run(compose_command(release, 'up', '--detach', '--wait', '--wait-timeout', '90', '--no-build', '--pull', 'never'), 'health_failed', 'Application did not reach its declared health checks. Inspect health and runtime logs.', timeout=110, secrets=secrets, log=log)
            containers, available = inspect_runtime(release)
            require(available and len(containers) == len(read(release/'release.json')['components']) and all(item['health'] == 'healthy' for item in containers), 'health_failed', 'One or more application components failed health validation.')
            metadata = read(release/'release.json'); metadata.update(images={entry['component']: entry['image'] for entry in containers})
            atomic(release/'release.json', metadata)
            operation_update(operation_path, 'switching-route')
            with Lock(STATE/'state.lock'), Lock(PUBLICATION_LOCK):
                app = read(directory/'application.json')
                checked_hostname(metadata.get('hostname'), identifier, config)
                app.update(currentReleaseId=metadata['id'], state='running', updatedAt=now())
                if metadata.get('hostname'):
                    app.update(hostname=metadata['hostname'], url='https://'+metadata['hostname']+'/')
                else:
                    app.pop('hostname', None); app.pop('url', None)
                atomic(directory/'application.json', app)
                try:
                    apply_routes()
                except Exception:
                    atomic(directory/'application.json', previous)
                    raise
            # Keep the global publication locks available to other applications
            # while DNS/TLS readiness is being established.
            verify_public_route(metadata)
            metadata['status'] = 'ready'
            atomic(release/'release.json', metadata)
            if old_release and old_release != release:
                run(compose_command(old_release, 'down', '--timeout', '15'), timeout=60)
        elif action in ('stop', 'unpublish'):
            operation_update(operation_path, 'stopping')
            if release:
                checked_run(compose_command(release, 'stop', '--timeout', '15'), 'start_failed', 'Could not stop this application.', timeout=60, secrets=secrets, log=log)
                old_stopped = True
            with Lock(STATE/'state.lock'), Lock(PUBLICATION_LOCK):
                app = read(directory/'application.json')
                app.update(state='unpublished' if action == 'unpublish' else 'stopped', updatedAt=now())
                atomic(directory/'application.json', app)
                try:
                    apply_routes()
                except Exception:
                    atomic(directory/'application.json', previous)
                    raise
            if action == 'unpublish' and release:
                checked_run(compose_command(release, 'down', '--timeout', '15'), 'start_failed', 'Application containers could not be removed. Business data is retained.', timeout=60, secrets=secrets, log=log)
        else:
            require(False, 'not_allowed', 'Unknown application operation.')
        operation_update(operation_path, 'succeeded', finishedAt=now())
    except Exception as error:
        stage = read(operation_path)['stage']
        append_log(log, 'broker', f'Application operation failed during {stage}.\n')
        recovery = 'unchanged'
        if release and release != old_release:
            run(compose_command(release, 'down', '--timeout', '10'), timeout=45, secrets=secrets)
        if old_stopped and old_release and previous['state'] == 'running':
            recovered = run(compose_command(old_release, 'up', '--detach', '--wait', '--wait-timeout', '90', '--no-build', '--pull', 'never'), timeout=110, secrets=list(read(old_release/'secrets.json', {}).values()), log=log)
            recovery = 'restored' if recovered['exitCode'] == 0 else 'failed'
        with Lock(STATE/'state.lock'), Lock(PUBLICATION_LOCK):
            restored = copy.deepcopy(previous)
            restored.update(state=previous['state'] if recovery != 'failed' else 'failed', updatedAt=now())
            atomic(directory/'application.json', restored)
            try:
                # Rebuild from all current applications, preserving concurrent
                # publications while restoring this application's old route.
                apply_routes()
            except Exception:
                recovery = 'failed'
                restored['state'] = 'failed'
                atomic(directory/'application.json', restored)
        code = getattr(error, 'code', 'internal_error')
        message = str(error) if isinstance(error, policy.PolicyError) else 'The application worker failed. Inspect the operation logs.'
        operation_update(operation_path, 'failed', failedStage=stage, recovery=recovery, finishedAt=now(), error={'code': code, 'message': redact(message, secrets)})
        if release and operation['action'] == 'publish':
            metadata = read(release/'release.json'); metadata['status'] = 'failed'; atomic(release/'release.json', metadata)


def wait_operation(path, timeout=25):
    """Use file change receipts; do not sleep/poll for a job to finish."""
    if read(path)['stage'] in TERMINAL:
        return read(path)
    libc = ctypes.CDLL(None, use_errno=True)
    fd = libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
    require(fd >= 0, 'internal_error', 'Application receipt watcher is unavailable.')
    try:
        watch = libc.inotify_add_watch(fd, os.fsencode(path.parent), 0x00000080 | 0x00000008)  # MOVED_TO, CLOSE_WRITE
        require(watch >= 0, 'internal_error', 'Application receipt watcher is unavailable.')
        deadline = time.monotonic()+timeout
        with selectors.DefaultSelector() as selector:
            selector.register(fd, selectors.EVENT_READ)
            while True:
                result = read(path)
                if result['stage'] in TERMINAL or time.monotonic() >= deadline:
                    return result
                if selector.select(max(0, deadline-time.monotonic())):
                    os.read(fd, 65536)
    finally:
        os.close(fd)


def get_logs(directory, app, payload, config=None):
    limit = payload.get('limit', 100)
    require(type(limit) is int and 1 <= limit <= 500, 'invalid_manifest', 'Log limit must be between 1 and 500.')
    kind = payload.get('kind', 'runtime')
    require(kind in ('runtime', 'build', 'health', 'route'), 'invalid_manifest', 'Unknown log category.')
    cursor = payload.get('cursor')
    if kind != 'runtime':
        operation_id = payload.get('operationId', app.get('latestOperationId'))
        operation = operation_dir(directory, operation_id)
        path = operation/'output.jsonl'
        offset = int(cursor) if isinstance(cursor, str) and cursor.isdigit() else 0
        require(cursor is None or isinstance(cursor, str) and cursor.isdigit(), 'invalid_manifest', 'Invalid build log cursor.')
        entries = []
        next_offset = offset
        if path.exists():
            require(offset <= path.stat().st_size, 'invalid_manifest', 'Log cursor is beyond the current log.')
            with path.open() as stream:
                stream.seek(offset)
                read_bytes = 0
                while len(entries) < limit and read_bytes < MAX_OUTPUT:
                    line = stream.readline()
                    if not line:
                        break
                    read_bytes += len(line.encode()); next_offset = stream.tell()
                    record = json.loads(line)
                    if payload.get('filter', '') in record['text'] and (not payload.get('since') or record['time'] >= payload['since']) and (not payload.get('until') or record['time'] <= payload['until']):
                        record['text'] = record['text'].encode()[:8192].decode(errors='replace')
                        entries.append(record)
                        if sum(len(entry['text'].encode()) for entry in entries) >= 32768:
                            break
        operation_record = read(operation/'operation.json')
        return {'entries': entries, 'cursor': str(next_offset), 'truncated': bool(path.exists() and path.stat().st_size >= MAX_LOG), 'operationId': operation_id, 'releaseId': operation_record.get('releaseId')}
    release = release_dir(directory, payload.get('releaseId', app.get('currentReleaseId')))
    pages = directory/'log-pages'
    pages.mkdir(exist_ok=True)
    if cursor:
        match = re.fullmatch(r'([a-f0-9]{32}):([0-9]+)', cursor)
        require(match is not None, 'invalid_manifest', 'Invalid runtime log cursor.')
        identity, offset = match[1], int(match[2])
        page = read(pages/(identity+'.json'))
        require(page is not None and time.time()-page['createdAt'] < 300 and page['releaseId'] == release.name, 'not_found', 'Runtime log page expired; query fresh logs without a cursor.')
    else:
        secrets = list(read(release/'secrets.json', {}).values())
        args = ['logs', '--no-color', '--timestamps', '--tail', '2000']
        for field in ('since', 'until'):
            if payload.get(field):
                require(isinstance(payload[field], str) and len(payload[field]) <= 64, 'invalid_manifest', 'Use an RFC3339 log time.')
                args.extend(['--'+field, payload[field]])
        result = native_backend(config).logs(release, payload, secrets) if is_native(release) else run(compose_command(release, *args), timeout=15, limit=256*1024, secrets=secrets)
        require(result['exitCode'] == 0, 'start_failed', 'Cannot read registered application logs.')
        entries = [{'time': now(), 'source': 'runtime', 'text': line} for line in (result['stdout']+result['stderr']).splitlines() if payload.get('filter', '') in line]
        identity, offset = uuid.uuid4().hex, 0
        page = {'createdAt': time.time(), 'releaseId': release.name, 'entries': entries, 'truncated': result['truncated']}
        atomic(pages/(identity+'.json'), page)
        for old in sorted(pages.glob('*.json'), key=lambda item: item.stat().st_mtime)[:-20]:
            old.unlink()
    entries = page['entries'][offset:offset+limit]
    # Bound response bytes even if one application emits unusually long lines.
    remaining = MAX_OUTPUT
    bounded = []
    for entry in entries:
        text = entry['text'].encode()[:min(remaining, 8192)].decode(errors='replace')
        remaining -= len(text.encode()); bounded.append({**entry, 'text': text})
        if remaining <= 0:
            break
    next_offset = offset+len(bounded)
    return {'entries': bounded, 'cursor': f'{identity}:{next_offset}' if next_offset < len(page['entries']) else None,
            'truncated': page['truncated'] or any(len(item['text']) > 8192 for item in entries), 'releaseId': release.name}


def request(instance_id, action, envelope, config):
    if action.startswith('deployment-'):
        return deployments.handle(BrokerApi(), instance_id, action, envelope)
    require(isinstance(envelope, dict) and set(envelope) <= {'roots', 'input', 'values', 'versions'}, 'invalid_manifest', 'Invalid broker request envelope.')
    profile = profile_for(config, instance_id)
    roots = scope_roots(profile, envelope.get('roots'))
    payload = envelope.get('input', {})
    require(isinstance(payload, dict), 'invalid_manifest', 'Expected an application request object.')
    deployment_profiles = native_backend(config).visible_profiles(instance_id, roots)
    backends = (['docker-compose'] if config.get('applications', {}).get('enabled') else []) + (['systemd'] if deployment_profiles else [])
    if action == 'info':
        return {'environment': {'instanceId': instance_id, 'home': profile['home'], 'workspaces': [root for root in roots if root not in (profile['providerHome'], profile.get('softwareDirectory'))],
                                'executionUid': profile['uid'], 'applicationBackend': ','.join(backends) or 'not-configured', 'applicationBackends': backends, 'deploymentProfiles': deployment_profiles,
                                **({'applicationRuntimeUid': config['runtimeUid']} if 'docker-compose' in backends else {}), 'applicationLifecycle': 'independent-managed-services',
                                'harnessLifecycle': 'ends-with-provider-session-or-T3-shutdown',
                                'frameworkAccess': 'read-only-or-hidden', 'networkNamespace': Path(profile['network'].get('path', '')).name,
                                'publicAccess': 'docker-compose:explicit-dedicated-hostname-via-Caddy;systemd:administrator-listen-ports-only', 'privateApplicationAccess': 'application_exec-and-logs'}}
    require(backends or action != 'prepare' and (STATE/'apps').exists(), 'not_configured', 'Application publishing is not configured. Ask the host administrator to enable Docker hosting or a systemd profile.')
    if action == 'list':
        visible = []
        for _, app in all_apps():
            try:
                policy.authorized_project(app['projectRoot'], roots, config)
                if app.get('backend') == 'systemd':
                    native_backend(config).authorized_profile(app.get('deploymentProfile'), app['projectRoot'], app['name'], instance_id)
                if not payload.get('projectRoot') or str(Path(payload['projectRoot']).resolve()) == app['projectRoot']:
                    visible.append(public_app(app))
            except (OSError, policy.PolicyError):
                pass
        return {'applications': visible, 'deploymentProfiles': deployment_profiles, 'backends': backends}
    if action == 'prepare':
        with Lock(STATE/'state.lock'), Lock(PUBLICATION_LOCK):
            return prepare(profile, roots, payload, config)
    directory, app = authorized_app(payload.get('applicationId'), roots, config)
    systemd_app = app.get('backend') == 'systemd'
    if systemd_app:
        native_backend(config).authorized_profile(app.get('deploymentProfile'), app['projectRoot'], app['name'], instance_id)
    if action == 'status':
        operation_id = payload.get('operationId', app.get('latestOperationId'))
        operation = None
        if operation_id:
            path = operation_dir(directory, operation_id)/'operation.json'
            with Lock(STATE/'state.lock'):
                reconcile_operation(directory, path)
            operation = wait_operation(path) if payload.get('wait') else read(path)
            app = read(directory/'application.json')
        runtime = native_backend(config).inspect if systemd_app else inspect_runtime
        entries, available = runtime(release_dir(directory, app['currentReleaseId'])) if app.get('currentReleaseId') else ([], True)
        unhealthy_current = systemd_app and (not entries or any(entry['state'] != 'active' or entry['subState'] != 'running' for entry in entries))
        if systemd_app and app.get('pendingReleaseId') and app['pendingReleaseId'] != app.get('currentReleaseId'):
            pending, pending_available = runtime(release_dir(directory, app['pendingReleaseId']))
            entries += pending; available = available and pending_available
        diagnostics = []
        if unhealthy_current and app['state'] == 'running' and app.get('currentReleaseId'):
            release = release_dir(directory, app['currentReleaseId'])
            target = begin_diagnostic(release, native_backend(config).unit_name(release), 'runtime', since=read(release/'release.json')['createdAt'])
            diagnostics.append(capture_diagnostic(release, target))
        return {'application': public_app(app), 'units' if systemd_app else 'containers': entries, 'runtimeAvailable': available,
                **({'operation': operation} if operation else {}), **({'diagnostics': diagnostics} if diagnostics else {})}
    if action == 'inspect':
        release = release_dir(directory, payload.get('releaseId', app.get('currentReleaseId')))
        if systemd_app:
            return {'application': public_app(app), 'release': read(release/'release.json'), 'configuration': native_backend(config).inspect_configuration(release)}
        compose = read(release/'compose.json')
        # Do not return env_file paths or values. Only vault names/versions are public.
        visible = {name: {key: value for key, value in service.items() if key in ('command', 'entrypoint', 'user', 'working_dir', 'ports', 'restart', 'cpus', 'mem_limit', 'pids_limit', 'healthcheck', 'cap_drop', 'security_opt')} for name, service in compose['services'].items()}
        for name, service in compose['services'].items():
            visible[name]['volumes'] = [{'target': mount['target'], 'readOnly': mount['read_only'], 'kind': 'persistent' if '/data/' in mount['source'] else 'snapshot'} for mount in service.get('volumes', [])]
        return {'application': public_app(app), 'release': read(release/'release.json'), 'configuration': visible}
    if action == 'releases':
        offset, limit = payload.get('offset', 0), payload.get('limit', 20)
        require(type(offset) is int and offset >= 0 and type(limit) is int and 1 <= limit <= 100, 'invalid_manifest', 'Invalid release page.')
        records = sorted([read(path) for path in (directory/'releases').glob('*/release.json')], key=lambda value: value['createdAt'], reverse=True)
        return {'releases': records[offset:offset+limit], 'nextOffset': offset+limit if len(records) > offset+limit else None}
    if action == 'logs':
        return {'logs': get_logs(directory, app, payload, config)}
    if action == 'exec':
        require(app['state'] == 'running' and app.get('currentReleaseId'), 'start_failed', 'Start the registered application before diagnostics.')
        release = release_dir(directory, app['currentReleaseId'])
        component = payload.get('component')
        require(component in read(release/'release.json')['components'], 'not_allowed', 'Select a registered application component.')
        argv = payload.get('argv')
        require(isinstance(argv, list) and argv and len(argv) <= 128 and all(isinstance(value, str) and '\0' not in value and len(value) <= 4096 for value in argv), 'invalid_manifest', 'Provide diagnostic command argv.')
        timeout = payload.get('timeoutSeconds', 30)
        require(type(timeout) is int and 1 <= timeout <= 120, 'invalid_manifest', 'Diagnostic timeout must be between 1 and 120 seconds.')
        stdin = payload.get('stdin')
        require(stdin is None or isinstance(stdin, str) and len(stdin.encode()) <= 65536, 'invalid_manifest', 'Diagnostic stdin exceeds the allowed size.')
        if systemd_app:
            backend = native_backend(config)
            spec = backend.validate_release(release, instance_id)
            cwd = payload.get('cwd', '/app')
            require(isinstance(cwd, str) and any(policy.inside(Path(cwd), Path(root)) for root in ('/app', '/data', '/tmp')) and '..' not in Path(cwd).parts and not any(c in cwd for c in '\0\n\r'), 'invalid_manifest', 'Diagnostic cwd must be inside /app, /data or /tmp.')
            result = backend.transient(release, spec, argv, kind='exec', timeout=timeout, stdin=stdin, cwd=cwd)
            return {'execution': result, 'application': public_app(app)}
        args = ['exec', '-T']
        if payload.get('cwd'):
            require(isinstance(payload['cwd'], str) and payload['cwd'].startswith('/') and '\0' not in payload['cwd'], 'invalid_manifest', 'Diagnostic cwd must be an absolute container path.')
            args += ['--workdir', payload['cwd']]
        args += [component, 'timeout', '-k', '2', str(timeout), *argv]
        secrets = list(read(release/'secrets.json', {}).values())
        result = run(compose_command(release, *args), timeout=timeout+10, stdin=stdin, secrets=secrets)
        require(result['exitCode'] != 127, 'not_supported', 'Install the standard timeout utility in this application image to enable bounded container diagnostics.')
        # GNU timeout returns 124, BusyBox preserves the termination signal
        # (143 for TERM, 137 for KILL). Both are standard image utilities.
        result['cancelled'] = result['cancelled'] or result['exitCode'] in (124, 137, 143)
        return {'execution': result, 'application': public_app(app)}
    with Lock(STATE/'state.lock'):
        if action == 'commit':
            operation_id = payload.get('operationId')
            operation_path = operation_dir(directory, operation_id)/'operation.json'
            operation = read(operation_path)
            require(app.get('latestOperationId') == operation['id'], 'operation_busy', 'This preparation is no longer the latest application operation.')
            require(operation['stage'] == 'validating' and operation['action'] == 'publish', 'not_allowed', 'This publication is not awaiting credential binding.')
            release = release_dir(directory, operation['releaseId'])
            if systemd_app: native_backend(config).validate_release(release, instance_id)
            install_values(release, envelope.get('values', {}), envelope.get('versions', {}))
        elif action == 'abandon':
            operation_path = operation_dir(directory, payload.get('operationId'))/'operation.json'
            require(read(operation_path)['stage'] == 'validating', 'not_allowed', 'Cannot abandon a running application job.')
            operation = operation_update(operation_path, 'failed', error={'code': 'credential_expired', 'message': 'The application credential bindings could not be resolved.'}, finishedAt=now())
            release = release_dir(directory, operation['releaseId'])
            metadata = read(release/'release.json'); metadata['status'] = 'failed'; atomic(release/'release.json', metadata)
            return {'application': public_app(app), 'operation': operation}
        elif action in ('control', 'rollback', 'unpublish'):
            busy(directory)
            operation_id = uuid.uuid4().hex
            operation_action = payload.get('action') if action == 'control' else action
            require(operation_action in ('start', 'stop', 'restart', 'rollback', 'unpublish'), 'not_allowed', 'Unknown application control.')
            release_id = payload.get('releaseId') if action == 'rollback' else app.get('currentReleaseId')
            pending_only = systemd_app and not release_id and app.get('pendingReleaseId') and operation_action in ('stop', 'unpublish')
            if pending_only: release_id = app['pendingReleaseId']
            require(release_id is not None, 'not_found', 'This application has no published release yet.')
            metadata = read(release_dir(directory, release_id)/'release.json')
            require(pending_only or metadata['status'] == 'ready', 'not_allowed', 'Only successfully published immutable releases can be started or restored.')
            if operation_action in ('start', 'restart', 'rollback'):
                if systemd_app: native_backend(config).validate_release(release_dir(directory, release_id), instance_id)
                versions = envelope.get('versions', {})
                require(isinstance(versions, dict) and set(versions) == set(metadata['credentialNames']) and
                        all(versions[name] == metadata['credentialVersions'].get(name) for name in metadata['credentialNames']) and
                        envelope.get('values', {}) == read(release_dir(directory, release_id)/'secrets.json', {}),
                        'credential_expired', 'Historical credential bindings require current T3 validation. Publish a new release after a credential change.')
            operation = {'id': operation_id, 'applicationId': app['id'], 'releaseId': release_id, 'action': operation_action,
                         'actor': instance_id, 'stage': 'queued', 'createdAt': now(), 'updatedAt': now()}
            atomic(directory/'operations'/operation_id/'operation.json', operation)
            app.update(latestOperationId=operation_id, updatedAt=now())
            atomic(directory/'application.json', app)
        else:
            require(False, 'not_allowed', 'Unknown application broker operation.')
        start_worker(directory, operation, config)
        return {'application': public_app(read(directory/'application.json')), 'operation': read(directory/'operations'/operation['id']/'operation.json'), 'release': read(release_dir(directory, operation['releaseId'])/'release.json')}


def main():
    require(os.geteuid() == 0, 'not_allowed', 'Use the installed root-owned application broker.')
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    rpc = sub.add_parser('request'); rpc.add_argument('instance'); rpc.add_argument('action')
    admin = sub.add_parser('deployment-admin'); admin.add_argument('instance'); admin.add_argument('action')
    work = sub.add_parser('worker'); work.add_argument('application'); work.add_argument('operation')
    args = parser.parse_args()
    config = load_config(int(os.environ.get('SUDO_UID', '0')))
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.mode == 'worker':
        worker(args.application, args.operation, config)
    else:
        data = sys.stdin.buffer.read(2*1024*1024+1)
        require(len(data) <= 2*1024*1024, 'invalid_manifest', 'Application broker request is too large.')
        result = deployments.handle(BrokerApi(), args.instance, args.action, json.loads(data), admin=True) if args.mode == 'deployment-admin' else request(args.instance, args.action, json.loads(data), config)
        print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never echo an argv, secret environment, request body or arbitrary OS exception.
        message = str(error) if isinstance(error, policy.PolicyError) else 'The application broker is unavailable. Ask the host administrator to check its configuration.'
        print(json.dumps({'code': getattr(error, 'code', 'not_configured'), 'message': message}), file=sys.stderr)
        sys.exit(1)
