"""Native application units with a private filesystem and administrator-selected authority."""
import copy
import hashlib
import json
import os
import posixpath
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import tempfile
import time
import uuid

UNITS = Path('/etc/systemd/system')
POLICIES = Path('/etc/t3code/application-policies')
OS_PATHS = ('/usr', '/bin', '/sbin', '/lib', '/lib64')
ETC_PATHS = ('/etc/ssl', '/etc/ca-certificates', '/etc/ld.so.cache', '/etc/localtime',
             '/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/hosts')
DEFAULT_BUILD = {'memoryMiB': 2048, 'cpuPercent': 100, 'tasks': 256, 'timeoutSeconds': 1200}
DEFAULT_RUNTIME = {'memoryMiB': 512, 'cpuPercent': 100, 'tasks': 128, 'timeoutSeconds': 90}


def verify_native_host(owner):
    """Run only during explicit administrator setup or GUI approval, never from a Harness request."""
    version = subprocess.run(['/usr/bin/systemctl', '--version'], check=True, capture_output=True, text=True).stdout
    match = re.match(r'systemd (\d+)', version)
    if not match or int(match[1]) < 257: raise ValueError('Native application hosting requires systemd 257+ for private PID namespaces')
    controllers_path = Path('/sys/fs/cgroup/cgroup.controllers')
    if not controllers_path.exists() or not {'memory', 'cpu', 'pids'} <= set(controllers_path.read_text().split()):
        raise ValueError('Native application hosting requires cgroup v2 memory, cpu and pids controllers')
    # Some hosts accept unit settings but cannot enforce them. Check PID isolation
    # and socket BPF enforcement before registering any root runtime grants.
    probe = '''import errno, os, socket, sys
assert os.stat('/proc/self/ns/pid').st_ino != int(sys.argv[1]), 'PrivatePIDs is not enforced'
for family, address in [(socket.AF_INET, ('127.0.0.1', 45001)), (socket.AF_INET6, ('::1', 45001))]:
    with socket.socket(family) as client:
        try: client.bind(address)
        except OSError as error:
            assert error.errno == errno.EPERM, 'Socket bind policy could not be verified'
        else: raise RuntimeError('SocketBindDeny is not enforced')
'''
    subprocess.run(['/usr/bin/systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit=t3-app-preflight-'+uuid.uuid4().hex,
                    '--property=User='+str(owner.pw_uid), '--property=Group='+str(owner.pw_gid),
                    '--property=PrivatePIDs=yes', '--property=PrivateNetwork=yes', '--property=SocketBindDeny=any',
                    '--property=MemoryMax=64M', '--property=MemorySwapMax=0', '--property=CPUQuota=25%',
                    '--property=TasksMax=16', '--property=RuntimeMaxSec=15s', '--property=TimeoutStopSec=5s',
                    '--expand-environment=no', '--', '/usr/bin/python3', '-I', '-c', probe,
                    str(Path('/proc/self/ns/pid').stat().st_ino)], check=True, timeout=30)



def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def budgets(value, defaults, require):
    require(isinstance(value, dict) and set(value) <= set(defaults), 'not_configured', 'Invalid application resource policy.')
    result = {**defaults, **value}
    ranges = {'memoryMiB': (64, 65536), 'cpuPercent': (1, 800), 'tasks': (16, 4096), 'timeoutSeconds': (1, 3600)}
    require(all(type(v) is int and ranges[k][0] <= v <= ranges[k][1] for k, v in result.items()),
            'not_configured', 'Application resource policy exceeds supported bounds.')
    return result


def profiles(config, policy):
    """The input comes from the root-owned resource policy, never a project manifest."""
    require = policy.require
    values = config.get('applications', {}).get('systemdProfiles', {})
    require(isinstance(values, dict) and len(values) <= 128, 'not_configured', 'Invalid systemd deployment profiles.')
    result = {}
    for name, value in values.items():
        require(isinstance(name, str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', name) and isinstance(value, dict),
                'not_configured', 'Invalid systemd deployment profile name.')
        require(set(value) <= {'projectRoot', 'applicationName', 'instances', 'runtimeUser', 'allowRoot', 'capabilities',
                               'networkNamespacePath', 'resolvConf', 'listenPorts', 'build', 'runtime'}, 'not_configured', 'Unknown systemd profile field.')
        project = value.get('projectRoot')
        require(isinstance(project, str) and os.path.isabs(project), 'not_configured', 'A deployment profile needs an absolute projectRoot.')
        project = Path(project).resolve(strict=True)
        require(project.is_dir(), 'not_configured', 'Deployment project is unavailable.')
        policy.protect_project(project, config)
        app_name = value.get('applicationName')
        instances = value.get('instances')
        require(isinstance(app_name, str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', app_name), 'not_configured', 'A profile needs its applicationName.')
        require(isinstance(instances, list) and instances and len(instances) <= 128 and
                all(isinstance(item, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', item) for item in instances),
                'not_configured', 'A profile needs explicitly allowed Harness instance IDs.')
        user = value.get('runtimeUser')
        require(isinstance(user, str) and re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_-]{0,63}', user), 'not_configured', 'Select an existing runtime user.')
        try:
            account = pwd.getpwnam(user)
        except KeyError:
            require(False, 'not_configured', 'The systemd runtime user does not exist.')
        require(account.pw_uid != 0 or value.get('allowRoot') is True, 'not_configured', 'Root runtime requires allowRoot in the host profile.')
        ports = value.get('listenPorts', [])
        require(isinstance(ports, list) and len(ports) <= 32 and all(type(port) is int and 1024 <= port <= 65535 and port not in config.get('reservedPorts', [22, 80, 443, 2019, 3773, 3774]) for port in ports),
                'not_configured', 'Native listenPorts must be non-reserved ports above 1023.')
        capabilities = value.get('capabilities', [])
        require(isinstance(capabilities, list) and set(capabilities) <= {'CAP_NET_BIND_SERVICE'}, 'not_configured', 'Only CAP_NET_BIND_SERVICE can be granted to native applications.')
        network = value.get('networkNamespacePath')
        resolver = value.get('resolvConf', '/etc/resolv.conf')
        require(network is None or isinstance(network, str) and re.fullmatch(r'/run/netns/[A-Za-z0-9_-]+', network), 'not_configured', 'Select an existing named network namespace.')
        require(network is None or 'resolvConf' in value, 'not_configured', 'A fixed network namespace requires its explicit resolvConf.')
        require(isinstance(resolver, str) and os.path.isabs(resolver) and not any(c in resolver for c in '\n\r\0'), 'not_configured', 'Select an absolute DNS configuration path.')
        result[name] = {'id': name, 'projectRoot': str(project), 'applicationName': app_name, 'instances': sorted(set(instances)),
                        'listenPorts': sorted(set(ports)), 'runtimeUser': user, 'uid': account.pw_uid, 'gid': account.pw_gid, 'capabilities': sorted(set(capabilities)),
                        'networkNamespacePath': network, 'resolvConf': resolver,
                        'build': budgets(value.get('build', {}), DEFAULT_BUILD, require),
                        'runtime': budgets(value.get('runtime', {}), DEFAULT_RUNTIME, require)}
    return result


def quote(value):
    # Unit files have specifier expansion, their own word parser, and ExecStart variable expansion.
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('\n', '\\n').replace('\r', '\\r') + '"'


def command_line(argv):
    return ' '.join(quote(item.replace('$', '$$')) for item in argv)


def bind_path(source, target):
    # systemd splits on unquoted colons; quoting the entire tuple hides its separator.
    return quote(str(source))+':'+quote(target)


class Backend:
    def __init__(self, broker, config):
        self.b = broker
        self.config = config

    def authorized_profile(self, identity, project, name, instance):
        profile = profiles(self.config, self.b.policy).get(identity)
        self.b.require(profile is not None, 'not_configured', 'The systemd deployment profile is unavailable. Ask the host administrator to register it.')
        self.b.require(profile['projectRoot'] == str(project) and profile['applicationName'] == name and instance in profile['instances'],
                       'not_allowed', 'This deployment profile is not granted to this application and Harness instance.')
        return profile

    def visible_profiles(self, instance, roots):
        visible = []
        for item in profiles(self.config, self.b.policy).values():
            if instance in item['instances'] and any(self.b.policy.inside(Path(item['projectRoot']), Path(root).resolve()) for root in roots):
                visible.append({key: item[key] for key in ('id', 'projectRoot', 'applicationName', 'runtimeUser', 'build', 'runtime')} |
                               {'networkNamespace': item['networkNamespacePath'] or 'host', 'rootFilesystem': 'private', 'listenPorts': item['listenPorts'], 'revision': digest(item), 'instances': item['instances']})
        return visible

    def validate(self, declaration, source, app, identity, instance):
        b = self.b
        profile = self.authorized_profile(identity, app['projectRoot'], app['name'], instance)
        b.require(isinstance(declaration, dict) and set(declaration) <= {'command', 'build', 'environment', 'credentials', 'healthcheck'},
                  'invalid_manifest', 'Native manifests accept command, build, environment, credentials and healthcheck only.')
        def argv(value):
            b.require(isinstance(value, list) and 1 <= len(value) <= 128 and all(isinstance(s, str) and s and '\0' not in s and '\n' not in s and '\r' not in s and len(s) <= 4096 for s in value),
                      'invalid_manifest', 'Native commands must be nonempty argv arrays with single-line arguments.')
            b.require(value[0].startswith(('/usr/', '/bin/', '/app/')) and '..' not in Path(value[0]).parts,
                      'invalid_manifest', 'Use an absolute executable under /usr, /bin or /app.')
            return value
        command = argv(declaration.get('command'))
        build = declaration.get('build', [])
        b.require(isinstance(build, list) and len(build) <= 16, 'invalid_manifest', 'Declare at most 16 native build commands.')
        build = [argv(item) for item in build]
        env = declaration.get('environment', {})
        bindings = declaration.get('credentials', {})
        for mapping in (env, bindings):
            b.require(isinstance(mapping, dict) and len(mapping) <= 64 and all(isinstance(k, str) and b.ENV_NAME.fullmatch(k) and isinstance(v, str) and len(v) <= 16384 and not any(c in v for c in '\0\n\r') for k, v in mapping.items()),
                      'invalid_manifest', 'Use explicit single-line environment values and named credential bindings.')
        b.require(all(b.ENV_NAME.fullmatch(v) for v in bindings.values()) and not set(env) & set(bindings), 'invalid_manifest', 'Credentials map environment names to vault names, without duplicate literal values.')
        reserved = {'HOME', 'PATH', 'TMPDIR', 'T3_APP_DATA', 'T3_RELEASE_ID'}
        b.require(not (set(env) | set(bindings)) & reserved, 'invalid_manifest', 'The native runtime owns HOME, PATH, TMPDIR, T3_APP_DATA and T3_RELEASE_ID.')
        health = declaration.get('healthcheck')
        b.require(isinstance(health, dict) and set(health) <= {'type', 'command', 'timeoutSeconds', 'intervalSeconds', 'retries'} and health.get('type') in ('process', 'command'),
                  'invalid_manifest', 'Declare a process or command healthcheck; no HTTP endpoint is required.')
        if health['type'] == 'command': argv(health.get('command'))
        else: b.require('command' not in health, 'invalid_manifest', 'Process healthchecks do not run a command.')
        health = {'timeoutSeconds': 10, 'intervalSeconds': 2, 'retries': 5, **health}
        b.require(all(type(health[k]) is int and 1 <= health[k] <= hi for k, hi in [('timeoutSeconds', 30), ('intervalSeconds', 30), ('retries', 30)]), 'invalid_manifest', 'Invalid healthcheck timing.')
        return {'command': command, 'build': build, 'environment': env, 'healthcheck': health,
                'profile': profile, 'profileDigest': digest(profile)}, {'service': bindings}, sorted(set(bindings.values()))

    def validate_release(self, release, instance):
        b = self.b
        spec = b.read(release/'native.json')
        app = b.read(release.parent.parent/'application.json')
        current = self.authorized_profile(app['deploymentProfile'], app['projectRoot'], app['name'], instance)
        b.require(digest(current) == spec['profileDigest'], 'not_allowed', 'The deployment policy changed. Publish a new release; historical policy grants are not revived.')
        return spec

    def _root(self, release, kind):
        root = release / (kind+'-root')
        root.mkdir(mode=0o755, exist_ok=True)
        for name in ('app', 'data', 'tmp', 'run', 'proc', 'dev', 'etc'):
            (root/name).mkdir(mode=0o755, exist_ok=True)
        return root

    def _settings(self, release, spec, *, build=False, cwd='/app'):
        b = self.b
        profile = spec['profile']
        limits = profile['build' if build else 'runtime']
        uid = self.config['ownerUid'] if build else profile['uid']
        gid = self.config['ownerGid'] if build else profile['gid']
        root = self._root(release, 'build' if build else 'runtime')
        app = release / ('build-work' if build else 'artifact')
        data = release.parent.parent/'data'/'native'
        if not build:
            data.mkdir(parents=True, exist_ok=True, mode=0o750)
            os.chown(data, uid, gid)
        resolver = Path(profile['resolvConf']).resolve(strict=True)
        b.require(resolver.is_file(), 'not_configured', 'The configured DNS file is unavailable.')
        for path in (resolver, *resolver.parents):
            info = path.lstat()
            b.require(info.st_uid == 0 and not info.st_mode & 0o022, 'not_configured', 'The DNS file and parents must be owned and writable only by root.')
        if profile['networkNamespacePath']:
            b.require(Path(profile['networkNamespacePath']).exists(), 'not_configured', 'The configured network namespace is unavailable; no host-network fallback is allowed.')
        ro = [quote(p) for p in (*OS_PATHS, *ETC_PATHS) if Path(p).exists()]
        ro.append(bind_path(resolver, '/etc/resolv.conf'))
        if not build: ro.append(bind_path(app, '/app'))
        rw = [bind_path(app, '/app')] if build else [bind_path(data, '/data')]
        caps = [] if build else profile['capabilities']
        properties = {
            'User': str(uid), 'Group': str(gid), 'SupplementaryGroups': '',
            'RootDirectory': str(root), 'WorkingDirectory': cwd,
            'ProtectSystem': 'strict', 'ProtectHome': 'yes', 'PrivateTmp': 'yes', 'PrivateDevices': 'yes',
            'PrivateMounts': 'yes', 'PrivatePIDs': 'yes', 'PrivateIPC': 'yes', 'BindLogSockets': 'no', 'ProtectProc': 'invisible', 'ProcSubset': 'pid',
            'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': ' '.join(caps), 'AmbientCapabilities': ' '.join(caps),
            'ProtectKernelTunables': 'yes', 'ProtectKernelModules': 'yes', 'ProtectKernelLogs': 'yes',
            'ProtectControlGroups': 'yes', 'ProtectClock': 'yes', 'RestrictNamespaces': 'yes',
            'RestrictRealtime': 'yes', 'RestrictSUIDSGID': 'yes', 'LockPersonality': 'yes',
            'SystemCallFilter': '~@mount @reboot @swap @raw-io @debug @module',
            'SocketBindDeny': 'any',
            'SocketBindAllow': [] if build else [f'{family}:tcp:{port}' for family in ('ipv4', 'ipv6') for port in profile['listenPorts']],
            'RestrictAddressFamilies': 'AF_UNIX AF_INET AF_INET6', 'KillMode': 'control-group',
            'TimeoutStopSec': '15s', 'UMask': '0077', 'MemoryHigh': str(limits['memoryMiB']*3//4)+'M',
            'MemoryMax': str(limits['memoryMiB'])+'M', 'MemorySwapMax': '0',
            'CPUQuota': str(limits['cpuPercent'])+'%', 'TasksMax': str(limits['tasks']),
            'BindReadOnlyPaths': ' '.join(ro), 'BindPaths': ' '.join(rw),
            'ReadWritePaths': '/app /tmp' if build else '/data /tmp',
            'InaccessiblePaths': ' '.join(quote('-'+p['path']) for p in self.config['protectedPaths']),
        }
        if profile['networkNamespacePath']: properties['NetworkNamespacePath'] = profile['networkNamespacePath']
        # systemd reads the environment file on the host before entering RootDirectory.
        if not build:
            properties['EnvironmentFile'] = str(release/'native.env')
            properties['Slice'] = self.slice_name(release)
        return properties

    def environment(self, release, spec):
        env = {'HOME': '/data', 'PATH': '/usr/local/bin:/usr/bin:/bin', 'TMPDIR': '/tmp',
               'T3_APP_DATA': '/data', 'T3_RELEASE_ID': release.name, **spec['environment']}
        bindings = self.b.read(release/'bindings.json')['service']
        values = self.b.read(release/'secrets.json', {})
        env.update({key: values[name] for key, name in bindings.items()})
        path = release/'native.env'
        path.write_text(''.join(key+'='+quote(value).replace('%%', '%')+'\n' for key, value in env.items()))
        path.chmod(0o600)

    def transient(self, release, spec, argv, *, kind, timeout, stdin=None, cwd='/app', log=None, step=None):
        b = self.b
        building = kind == 'build'
        settings = self._settings(release, spec, build=building, cwd=cwd)
        settings.update(Type='exec', RuntimeMaxSec=str(timeout)+'s')
        if building:
            settings['Environment'] = 'HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp'
        else:
            self.environment(release, spec)
        unit = 't3-app-'+kind+'-'+uuid.uuid4().hex
        command = ['/usr/bin/systemd-run', '--wait', '--pipe', '--unit', unit,
                   '--description=T3 application '+kind,
                   '--property=ConditionPathExists='+str(POLICIES/spec['profileDigest'])]
        command += ['--property='+key+'='+entry for key, value in settings.items() for entry in (value if isinstance(value, list) else [value])]
        # --expand-environment=no prevents systemd-run from expanding supplied argv.
        command += ['--expand-environment=no', '--', *argv]
        phase = 'recovery' if log and b.read(log.parent/'diagnostic-target.json', {}).get('phase') == 'recovery' else kind
        target = b.begin_diagnostic(release, unit+'.service', phase, log=log, step=step)
        try:
            result = b.run(command, timeout=timeout+20, stdin=stdin, secrets=list(b.read(release/'secrets.json', {}).values()), log=log)
            if result['exitCode'] != 0 or result.get('cancelled'):
                diagnostic = b.capture_diagnostic(release, target, result=result, log=log)
                if diagnostic['state'].get('Result') == 'timeout': result['cancelled'] = True
                result['diagnostics'] = [diagnostic]
            return result
        except Exception:
            b.capture_diagnostic(release, target, log=log)
            raise
        finally:
            # Only this invocation's generated unit can be stopped, even after caller timeout.
            stopped = b.run(['/usr/bin/systemctl', 'stop', unit+'.service'], timeout=20)
            if stopped['exitCode'] != 0 or stopped.get('cancelled'):
                b.capture_diagnostic(release, target, result=stopped, log=log)
                state = b.run(['/usr/bin/systemctl', 'show', unit+'.service', '--property=LoadState,ActiveState'], timeout=10)
                values = dict(line.split('=', 1) for line in state['stdout'].splitlines() if '=' in line)
                b.require(state['exitCode'] == 0 and values.get('LoadState') == 'not-found', 'start_failed',
                          'Could not confirm the temporary application process has stopped.')
            b.run(['/usr/bin/systemctl', 'reset-failed', unit+'.service'], timeout=5)

    def freeze(self, source, target, *, allow_external=False):
        """Copy completed build output, discarding ownership and special modes; never follow links."""
        b = self.b
        target.mkdir(mode=0o755)
        count = total = 0
        hashed = hashlib.sha256()
        for parent, directories, files in os.walk(source, followlinks=False):
            directories.sort()
            relative = Path(parent).relative_to(source)
            destination = target/relative
            destination.mkdir(mode=0o755, exist_ok=True)
            for name in sorted([*directories, *files]):
                item = Path(parent)/name
                info = item.lstat()
                count += 1
                b.require(count <= 200000, 'build_failed', 'Native artifact contains too many files.')
                hashed.update(os.fsencode(str(relative/name))+b'\0')
                out = destination/name
                if stat.S_ISLNK(info.st_mode):
                    link = os.readlink(item)
                    # Build output uses paths in RootDirectory, not paths on the host.
                    resolved = Path(posixpath.normpath(posixpath.join('/app', str(relative), link)))
                    permitted = b.policy.inside(resolved, Path('/app')) or allow_external and any(b.policy.inside(resolved, Path(root)) for root in OS_PATHS)
                    b.require(permitted, 'build_failed', 'Native artifact symlink escapes its application filesystem.')
                    out.symlink_to(link); hashed.update(b'L'+os.fsencode(link)+b'\0')
                elif stat.S_ISDIR(info.st_mode):
                    out.mkdir(mode=0o755, exist_ok=True)
                    hashed.update(b'D')
                elif stat.S_ISREG(info.st_mode):
                    content = hashlib.sha256()
                    with item.open('rb') as src, out.open('wb') as dst:
                        while chunk := src.read(65536):
                            total += len(chunk)
                            b.require(total <= 1024*1024*1024, 'build_failed', 'Native artifact exceeds 1 GiB.')
                            content.update(chunk); dst.write(chunk)
                    executable = bool(info.st_mode & 0o111)
                    out.chmod(0o755 if executable else 0o644); hashed.update(b'F'+content.digest()+(b'x' if executable else b'-'))
                else:
                    b.require(False, 'build_failed', 'Native artifacts cannot contain devices, FIFOs or sockets.')
        return hashed.hexdigest()

    def build(self, release, spec, log):
        b = self.b
        work = release/'build-work'
        self.freeze(release/'source', work)
        for parent, directories, files in os.walk(work, followlinks=False):
            os.chown(parent, self.config['ownerUid'], self.config['ownerGid'])
            for name in files:
                os.chown(Path(parent)/name, self.config['ownerUid'], self.config['ownerGid'], follow_symlinks=False)
        deadline = time.monotonic()+spec['profile']['build']['timeoutSeconds']
        try:
            for step, argv in enumerate(spec['build'], 1):
                remaining = int(deadline-time.monotonic())
                b.require(remaining > 0, 'build_failed', 'The native build exceeded its time budget.')
                result = self.transient(release, spec, argv, kind='build', timeout=remaining, log=log, step=step)
                b.require(result['exitCode'] == 0 and not result['cancelled'], 'build_failed',
                          f"Native build step {step} failed (launcher exit {result['exitCode']}, cancelled={result['cancelled']}). Inspect operation diagnostics and logs.")
            artifact = release/'artifact'
            value = self.freeze(work, artifact, allow_external=True)
            metadata = b.read(release/'release.json'); metadata['artifactDigest'] = value
            b.atomic(release/'release.json', metadata)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def unit_name(self, release):
        metadata = self.b.read(release/'release.json')
        return 't3-app-'+metadata['applicationId']+'-'+metadata['id']+'.service'

    def slice_name(self, release):
        return 't3-app-'+self.b.read(release/'release.json')['applicationId']+'.slice'

    def unit_text(self, release, spec):
        self.environment(release, spec)
        settings = self._settings(release, spec)
        text = '[Unit]\nDescription=T3 application '+release.parent.parent.name+'\nAfter=network-online.target\nWants=network-online.target\n'
        text += 'ConditionPathExists='+str(POLICIES/spec['profileDigest'])+'\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\n'
        text += 'Type=exec\nRestart=on-failure\nRestartSec=5\n'
        text += ''.join(key+'='+entry+'\n' for key, value in settings.items() for entry in (value if isinstance(value, list) else [value]))
        text += 'ExecStart='+command_line(spec['command'])+'\nStandardOutput=journal\nStandardError=journal\nLogRateLimitIntervalSec=30s\nLogRateLimitBurst=200\n\n[Install]\nWantedBy=multi-user.target\n'
        return text

    def install(self, release, spec):
        self.b.require((release/'artifact').is_dir(), 'start_failed', 'This release has no completed native artifact.')
        limits = spec['profile']['runtime']
        # Probes and concurrent diagnostics share the application's total budget.
        slice_text = '[Slice]\nMemoryHigh='+str(limits['memoryMiB']*3//4)+'M\nMemoryMax='+str(limits['memoryMiB'])+'M\nMemorySwapMax=0\nCPUQuota='+str(limits['cpuPercent'])+'%\nTasksMax='+str(limits['tasks'])+'\n'
        for name, content in [(self.slice_name(release), slice_text), (self.unit_name(release), self.unit_text(release, spec))]:
            fd, temporary = tempfile.mkstemp(prefix='.t3-app-', dir=UNITS)
            try:
                with os.fdopen(fd, 'w') as stream: stream.write(content)
                os.chmod(temporary, 0o644)
                os.replace(temporary, UNITS/name)
            finally:
                if os.path.exists(temporary): os.unlink(temporary)
        self.b.checked_run(['/usr/bin/systemctl', 'daemon-reload'], 'start_failed', 'Could not reload the managed systemd unit.')

    def control(self, release, action, *, check=True, log=None):
        argv = ['/usr/bin/systemctl', action, self.unit_name(release)]
        result = self.b.run(argv, timeout=45, secrets=list(self.b.read(release/'secrets.json', {}).values()), log=log)
        if check and (result['exitCode'] != 0 or result.get('cancelled')):
            target = self.b.read(log.parent/'diagnostic-target.json') if log else self.b.begin_diagnostic(release, self.unit_name(release), action)
            self.b.capture_diagnostic(release, target, result=result, log=log)
            self.b.require(False, 'start_failed', 'The managed systemd service could not '+action+'. Inspect operation diagnostics.')
        return result

    def stop(self, release, *, remove=False, check=True):
        disabled = self.control(release, 'disable', check=False)
        stopped = self.control(release, 'stop', check=False)
        if check and any(result['exitCode'] != 0 or result.get('cancelled') for result in (disabled, stopped)):
            state = self.b.run(['/usr/bin/systemctl', 'show', self.unit_name(release), '--property=LoadState'], timeout=10)
            # Withdrawal and interrupted cleanup may already have removed the unit.
            self.b.require(state['exitCode'] == 0 and state['stdout'].strip() == 'LoadState=not-found', 'start_failed',
                           'Could not confirm the managed service is stopped and disabled.')
        if remove:
            (UNITS/self.unit_name(release)).unlink(missing_ok=True)
            self.b.run(['/usr/bin/systemctl', 'daemon-reload'])

    def inspect(self, release):
        b = self.b
        spec = b.read(release/'native.json')
        fields = ['LoadState', 'ActiveState', 'SubState', 'ExecMainStatus', 'NRestarts', 'ExecMainStartTimestamp', 'MainPID', 'Result', 'MemoryCurrent']
        result = b.run(['/usr/bin/systemctl', 'show', self.unit_name(release), '--property='+','.join(fields)], timeout=10)
        if result['exitCode'] != 0: return [], False
        values = dict(line.split('=', 1) for line in result['stdout'].splitlines() if '=' in line)
        if not values or values.get('LoadState') == 'not-found': return [], True
        def number(key):
            value = values.get(key, '0')
            return int(value) if value.isdigit() else 0
        return [{'component': 'service', 'unit': self.unit_name(release), 'state': values.get('ActiveState', 'unknown'),
                 'subState': values.get('SubState', 'unknown'), 'exitCode': number('ExecMainStatus'), 'restartCount': number('NRestarts'),
                 'startedAt': values.get('ExecMainStartTimestamp', ''), 'user': spec['profile']['runtimeUser'],
                 'command': spec['command'], 'result': values.get('Result', ''), 'pid': number('MainPID'), 'memoryBytes': number('MemoryCurrent')}], True

    def health(self, release, spec, log):
        b = self.b
        health = spec['healthcheck']
        deadline = time.monotonic()+spec['profile']['runtime']['timeoutSeconds']
        current_target = b.read(log.parent/'diagnostic-target.json', {}) if log else {}
        phase = 'recovery' if current_target.get('phase') == 'recovery' else 'checking-health'
        since = b.read(log.parent/'operation.json')['createdAt'] if log else b.read(release/'release.json')['createdAt']
        # This is the production readiness probe, not a test synchronization mechanism.
        for attempt in range(health['retries']):
            b.begin_diagnostic(release, self.unit_name(release), phase, log=log, since=since)
            units, available = self.inspect(release)
            active = available and len(units) == 1 and units[0]['state'] == 'active' and units[0]['subState'] == 'running' and units[0]['pid'] > 0
            if active:
                if health['type'] == 'process': return
                remaining = int(deadline-time.monotonic())
                if remaining <= 0: break
                result = self.transient(release, spec, health['command'], kind='health', timeout=min(remaining, health['timeoutSeconds']), log=log)
                if result['exitCode'] == 0 and not result['cancelled']:
                    units, available = self.inspect(release)
                    if available and len(units) == 1 and units[0]['state'] == 'active' and units[0]['subState'] == 'running' and units[0]['pid'] > 0: return
            if attempt+1 < health['retries']:
                remaining = deadline-time.monotonic()
                if remaining <= 0: break
                time.sleep(min(health['intervalSeconds'], remaining))
        b.require(False, 'health_failed', 'The native service failed its declared readiness check. Inspect its journal and operation logs.')

    def logs(self, release, payload, secrets):
        argv = ['/usr/bin/journalctl', '--no-pager', '--output=short-iso-precise', '--lines=2000', '--unit='+self.unit_name(release)]
        for field in ('since', 'until'):
            if payload.get(field):
                self.b.require(isinstance(payload[field], str) and len(payload[field]) <= 64, 'invalid_manifest', 'Use an RFC3339 log time.')
                argv += ['--'+field+'='+payload[field]]
        return self.b.run(argv, timeout=15, limit=256*1024, secrets=secrets)

    def inspect_configuration(self, release):
        spec = self.b.read(release/'native.json')
        return {'service': {key: spec[key] for key in ('command', 'build', 'healthcheck')} |
                {'runtimeUser': spec['profile']['runtimeUser'], 'limits': spec['profile']['runtime'], 'buildLimits': spec['profile']['build'],
                 'networkNamespace': spec['profile']['networkNamespacePath'] or 'host', 'rootFilesystem': 'private',
                 'applicationPath': '/app', 'dataPath': '/data', 'listenPorts': spec['profile']['listenPorts'], 'capabilities': spec['profile']['capabilities']}}

    def worker(self, directory, operation_id):
        b = self.b
        operation_path = b.operation_dir(directory, operation_id)/'operation.json'
        operation = b.read(operation_path)
        previous = b.read(directory/'application.json')
        release = b.release_dir(directory, operation['releaseId'])
        old = b.release_dir(directory, previous['currentReleaseId']) if previous.get('currentReleaseId') else None
        log = operation_path.parent/'output.jsonl'
        secrets = list(b.read(release/'secrets.json', {}).values())
        touched_old = started_new = False
        unconfirmed = previous.get('pendingReleaseId')
        cleaned_pending = None
        def target(candidate, phase):
            b.begin_diagnostic(candidate, self.unit_name(candidate), phase, log=log, since=operation['createdAt'])
        try:
            action = operation['action']
            if unconfirmed:
                # A killed worker or failed cleanup can leave a candidate alive.
                # Reconcile it before any later start, including another publish.
                pending = b.release_dir(directory, unconfirmed)
                target(pending, 'stopping')
                self.stop(pending, remove=pending != old or action == 'unpublish')
                cleaned_pending = pending
                unconfirmed = None
                previous.pop('pendingReleaseId', None)
                with b.Lock(b.STATE/'state.lock'):
                    app = b.read(directory/'application.json'); app.pop('pendingReleaseId', None)
                    b.atomic(directory/'application.json', app)
            if action in ('publish', 'rollback', 'start', 'restart'):
                spec = self.validate_release(release, operation['actor'])
                if action == 'publish':
                    # One host build at a time, including Docker builds. Runtime units have their own budgets.
                    b.operation_update(operation_path, 'queued')
                    with b.Lock(b.STATE/'build.lock'):
                        b.operation_update(operation_path, 'building')
                        self.build(release, spec, log)
                b.operation_update(operation_path, 'starting')
                if old:
                    touched_old = True
                    target(old, 'stopping')
                    self.stop(old)
                target(release, 'starting')
                self.install(release, spec)
                unconfirmed = release.name
                with b.Lock(b.STATE/'state.lock'):
                    app = b.read(directory/'application.json'); app['pendingReleaseId'] = release.name
                    b.atomic(directory/'application.json', app)
                started_new = True
                self.control(release, 'start', log=log)
                b.operation_update(operation_path, 'checking-health')
                target(release, 'checking-health')
                self.health(release, spec, log)
                target(release, 'enabling')
                # An unsuccessful candidate must never become a boot-time service.
                self.control(release, 'enable', log=log)
                metadata = b.read(release/'release.json'); metadata['status'] = 'ready'
                b.atomic(release/'release.json', metadata)
                with b.Lock(b.STATE/'state.lock'):
                    app = b.read(directory/'application.json')
                    app.update(currentReleaseId=release.name, state='running', updatedAt=b.now())
                    app.pop('pendingReleaseId', None)
                    b.atomic(directory/'application.json', app)
                unconfirmed = None
                if old and old != release: self.stop(old, remove=True, check=False)
            elif action in ('stop', 'unpublish'):
                b.operation_update(operation_path, 'stopping')
                target(release, 'stopping')
                if release != cleaned_pending: self.stop(release, remove=action == 'unpublish')
                with b.Lock(b.STATE/'state.lock'):
                    app = b.read(directory/'application.json')
                    app.update(state='unpublished' if action == 'unpublish' else 'stopped', updatedAt=b.now())
                    b.atomic(directory/'application.json', app)
            else:
                b.require(False, 'not_allowed', 'Unknown native application operation.')
            b.operation_update(operation_path, 'succeeded', finishedAt=b.now())
        except Exception as error:
            stage = b.read(operation_path)['stage']
            b.capture_pending_diagnostic(directory, log)
            # A probe has its own temporary unit; retain the service state as well.
            if stage == 'checking-health' and b.read(log.parent/'diagnostic-target.json', {}).get('unit') != self.unit_name(release):
                target(release, stage)
                b.capture_pending_diagnostic(directory, log)
            failure_diagnostics = b.read(operation_path).get('diagnostics', [])
            recovery = 'unchanged'
            try:
                if started_new:
                    # Do not start the previous bot if stopping the candidate failed.
                    target(release, 'recovery')
                    self.stop(release, remove=release != old)
                    unconfirmed = None
                if touched_old and old and previous['state'] == 'running':
                    target(old, 'recovery')
                    old_spec = self.validate_release(old, operation['actor'])
                    self.install(old, old_spec)
                    self.control(old, 'start', log=log)
                    self.health(old, old_spec, log)
                    target(old, 'recovery')
                    self.control(old, 'enable', log=log)
                    recovery = 'restored'
            except Exception:
                b.capture_pending_diagnostic(directory, log)
                recovery = 'failed'
            # Recovery probes must not evict the evidence that triggered rollback.
            latest = b.read(operation_path)
            failure_ids = {item['id'] for item in failure_diagnostics}
            recovery_diagnostics = [item for item in latest.get('diagnostics', []) if item['id'] not in failure_ids]
            latest['diagnostics'] = failure_diagnostics[-4:]+recovery_diagnostics[-2:]
            b.atomic(operation_path, latest)
            if unconfirmed:
                recovery = 'failed'
            if operation['action'] in ('stop', 'unpublish'):
                recovery = 'failed'
            with b.Lock(b.STATE/'state.lock'):
                restored = copy.deepcopy(previous)
                restored.update(updatedAt=b.now())
                if unconfirmed: restored['pendingReleaseId'] = unconfirmed
                else: restored.pop('pendingReleaseId', None)
                if recovery == 'failed': restored['state'] = 'failed'
                b.atomic(directory/'application.json', restored)
            message = str(error) if isinstance(error, b.policy.PolicyError) else 'The native application operation failed. Inspect its operation log and journal.'
            b.append_log(log, 'broker', b.redact(message, secrets))
            b.operation_update(operation_path, 'failed', failedStage=stage, recovery=recovery, finishedAt=b.now(),
                               error={'code': getattr(error, 'code', 'internal_error'), 'message': b.redact(message, secrets)})
            if operation['action'] == 'publish':
                metadata = b.read(release/'release.json'); metadata['status'] = 'failed'; b.atomic(release/'release.json', metadata)
