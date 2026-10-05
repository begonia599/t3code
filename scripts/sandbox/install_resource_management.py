#!/usr/bin/python3 -I
"""Configure trusted resource boundaries and application hosting as administrator."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import subprocess

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
for module_name in ('t3code_resource_policy', 't3code_systemd'):
    module_spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(module_name+'.py'))
    module = importlib.util.module_from_spec(module_spec); module_spec.loader.exec_module(module)
    globals()[module_name] = module


verify_native_host = t3code_systemd.verify_native_host


def configure():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--protect-read', action='append', default=[])
    parser.add_argument('--protect-hidden', action='append', default=[])
    parser.add_argument('--protected-repository', action='append', default=[])
    parser.add_argument('--domain-suffix', action='append', default=[])
    parser.add_argument('--reserved-host', action='append', default=[])
    parser.add_argument('--instance-profile', action='append', default=[])
    parser.add_argument('--enable-applications', action='store_true')
    parser.add_argument('--systemd-profiles', help='Root-owned JSON object of native deployment profiles; replaces the registered profile set')
    parser.add_argument('--build-memory-mib', type=int)
    parser.add_argument('--build-cpu-percent', type=int)
    parser.add_argument('--configure-caddy', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0: raise ValueError('Resource policy requires direct host administrator execution')
    owner = pwd.getpwnam(args.owner)
    if owner.pw_uid == 0: raise ValueError('Choose the normal T3 host user')
    path = Path('/etc/t3code/resources.json'); path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    existing = json.loads(path.read_text()) if path.exists() else {}
    if existing and existing.get('ownerUid') != owner.pw_uid: raise ValueError('Existing resource policy belongs to another host owner')
    protected = {entry['path']: entry for entry in existing.get('protectedPaths', [])}
    for visibility, entries in [('read', args.protect_read), ('hidden', args.protect_hidden)]:
        for selected in entries:
            if not os.path.isabs(selected) or Path(selected).resolve() == Path('/'): raise ValueError('Use a specific absolute protected resource path')
            protected[str(Path(selected).absolute())] = {'path': str(Path(selected).absolute()), 'visibility': visibility}
    repositories = set(existing.get('protectedRepositories', []))
    for repository in args.protected_repository:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository): raise ValueError('Invalid protected GitHub repository')
        repositories.add(repository.lower())
    if not repositories: raise ValueError('Declare the controlling framework GitHub repository before enabling resource management')
    config = {**existing, 'ownerUid': owner.pw_uid, 'protectedPaths': list(protected.values()), 'protectedRepositories': sorted(repositories)}
    profiles = config.get('instanceProfiles', {})
    for entry in args.instance_profile:
        instance, separator, profile = entry.partition('=')
        if not separator or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', profile): raise ValueError('Use --instance-profile INSTANCE_ID=PROFILE')
        record = json.loads((Path('/etc/t3code/sandboxes')/(profile+'.json')).read_text())
        if record['instanceId'] != instance or record['ownerUid'] != owner.pw_uid: raise ValueError('Incorrect trusted instance profile')
        profiles[instance] = profile
    config['instanceProfiles'] = profiles
    network_path = Path('/etc/t3code/service-network.json')
    network = json.loads(network_path.read_text()) if network_path.exists() else {}
    config['reservedHosts'] = sorted(set([*config.get('reservedHosts', []), *args.reserved_host, *network.get('reservedHosts', []), *([network['publicHost']] if network.get('publicHost') else [])]))
    config['reservedPorts'] = sorted(set([*config.get('reservedPorts', []), *network.get('reservedPorts', []), 3773, 3774, 80, 443, 2019]))
    applications = config.get('applications', {'enabled': False, 'portRange': [42000,45999]})
    applications['allowedDomainSuffixes'] = sorted(set([*applications.get('allowedDomainSuffixes', []), *args.domain_suffix]))
    for domain in [*config['reservedHosts'], *applications['allowedDomainSuffixes']]:
        if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', domain): raise ValueError('Invalid publication hostname policy')
    if args.systemd_profiles:
        applications['systemdProfiles'] = t3code_resource_policy.trusted_json(Path(args.systemd_profiles))
    build = applications.get('build', {})
    if args.build_memory_mib is not None: build['memoryMiB'] = args.build_memory_mib
    if args.build_cpu_percent is not None: build['cpuPercent'] = args.build_cpu_percent
    applications['build'] = t3code_systemd.budgets(build, t3code_systemd.DEFAULT_BUILD, t3code_resource_policy.require)
    config['applications'] = applications
    # Include the implicit framework paths during profile validation too.
    validation = {**config, 'protectedPaths': [*config['protectedPaths'], *[{'path': value, 'visibility': 'hidden'} for value in t3code_resource_policy.DEFAULT_PROTECTED]]}
    profiles = t3code_systemd.profiles(validation, t3code_resource_policy)
    if profiles:
        verify_native_host(owner)
        for item in profiles.values():
            if item['networkNamespacePath'] and not Path(item['networkNamespacePath']).exists(): raise ValueError('The configured service network namespace is unavailable')
            resolver = Path(item['resolvConf']).resolve(strict=True)
            for entry in (resolver, *resolver.parents):
                info = entry.lstat()
                if info.st_uid != 0 or info.st_mode & 0o022: raise ValueError('DNS file and parents must be owned and writable only by root')
    if args.enable_applications:
        for command in [['/usr/bin/docker','version','--format','{{.Server.Version}}'],['/usr/bin/docker','compose','version'],['/usr/bin/docker','buildx','version'],['/usr/bin/python3','-I','-c','import yaml']]:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        applications['enabled'] = True
    config['applications'] = applications
    # Unit conditions prevent revoked or changed profiles from starting again after reboot.
    markers = t3code_systemd.POLICIES
    markers.mkdir(mode=0o755, parents=True, exist_ok=True)
    for entry in (markers, *markers.parents):
        info = entry.lstat()
        if entry.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Application policy marker directories must be owned and writable only by root')
    valid = {t3code_systemd.digest(item) for item in profiles.values()}
    for marker in markers.iterdir():
        if re.fullmatch(r'[a-f0-9]{64}', marker.name) and marker.name not in valid: marker.unlink()
    installer.install_file(path, (json.dumps(config, indent=2)+'\n').encode(), 0o644)
    for value in valid: installer.install_file(markers/value, b'Granted native application policy\n', 0o644)
    if args.configure_caddy:
        fragment = Path('/etc/caddy/t3code-applications.caddy')
        if not fragment.exists(): installer.install_file(fragment, b'# T3 managed applications\n', 0o644)
        caddy = Path('/etc/caddy/Caddyfile'); old = caddy.read_bytes()
        directive = b'import /etc/caddy/t3code-applications.caddy\n'
        if directive not in old:
            try:
                installer.install_file(caddy, directive+b'\n'+old, 0o644)
                subprocess.run(['/usr/bin/caddy','validate','--config',str(caddy)], check=True, stdout=subprocess.DEVNULL)
                subprocess.run(['/usr/bin/systemctl','reload','caddy.service'], check=True)
            except Exception:
                installer.install_file(caddy, old, 0o644)
                raise
    print('Configured trusted T3 resource boundaries. Docker hosting: '+str(applications.get('enabled', False))+'. Native deployment profiles: '+str(len(profiles))+'.')


def main():
    with t3code_resource_policy.configuration_lock():
        configure()


if __name__ == '__main__': main()
