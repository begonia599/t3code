#!/usr/bin/python3 -I
"""Configure trusted resource boundaries and Docker application hosting as administrator."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--protect-read', action='append', default=[])
    parser.add_argument('--protect-hidden', action='append', default=[])
    parser.add_argument('--protected-repository', action='append', default=[])
    parser.add_argument('--domain-suffix', action='append', default=[])
    parser.add_argument('--reserved-host', action='append', default=[])
    parser.add_argument('--instance-profile', action='append', default=[])
    parser.add_argument('--enable-applications', action='store_true')
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
    if args.enable_applications:
        for command in [['/usr/bin/docker','version','--format','{{.Server.Version}}'],['/usr/bin/docker','compose','version'],['/usr/bin/python3','-I','-c','import yaml']]:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        applications['enabled'] = True
    config['applications'] = applications
    installer.install_file(path, (json.dumps(config, indent=2)+'\n').encode(), 0o644)
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
    print('Configured trusted T3 resource boundaries'+(' and Docker application hosting.' if applications['enabled'] else '.'))


if __name__ == '__main__': main()
