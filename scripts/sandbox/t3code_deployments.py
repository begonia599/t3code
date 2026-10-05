"""Durable deployment requests. Only the authenticated administrator route grants policy."""
import os
from pathlib import Path
import pwd
import subprocess
import tempfile
import uuid


def public(record):
    return {key: record[key] for key in ('requestId', 'revision', 'proposal', 'instanceId',
                                         'runtimeUser', 'networkNamespace', 'createdAt', 'status')}


def record_visible(b, record, instance, roots):
    # A deleted project must not strand its pending request. Approval separately
    # revalidates the real directory; listing/dismissal use the original scoped path.
    return record['instanceId'] == instance and any(
        b.policy.inside(Path(record['proposal']['projectRoot']), Path(root).resolve()) for root in roots)


def resolve(b, config, instance, roots, proposal):
    b.require(isinstance(proposal, dict) and set(proposal) == {
        'profileId', 'projectRoot', 'applicationName', 'runtimeIdentity', 'network', 'listenPorts', 'build', 'runtime'},
        'invalid_manifest', 'Use the deployment authorization form fields only.')
    identity = proposal['profileId']
    b.require(isinstance(identity, str) and b.SLUG.fullmatch(identity), 'invalid_manifest', 'Invalid deployment profile name.')
    b.require(isinstance(proposal['projectRoot'], str) and os.path.isabs(proposal['projectRoot']),
              'invalid_manifest', 'Select an absolute project directory.')
    try: project = b.policy.authorized_project(proposal['projectRoot'], roots, config)
    except OSError: b.require(False, 'invalid_manifest', 'Deployment project is unavailable.')
    b.require(proposal['runtimeIdentity'] in ('owner', 'root') and proposal['network'] in ('instance', 'host'),
              'invalid_manifest', 'Select a runtime identity and network.')
    account = pwd.getpwuid(0 if proposal['runtimeIdentity'] == 'root' else config['ownerUid'])
    network = b.profile_for(config, instance)['network'] if proposal['network'] == 'instance' else {}
    b.require(proposal['network'] == 'host' or network.get('mode') in ('host', 'namespace'),
              'not_configured', 'The instance network configuration is unavailable.')
    namespace = network.get('path') if network.get('mode') == 'namespace' else None
    b.require(network.get('mode') != 'namespace' or isinstance(namespace, str) and namespace,
              'not_configured', 'The instance network namespace is unavailable.')
    resolver_source = network.get('resolvConf') if namespace else '/etc/resolv.conf'
    b.require(isinstance(resolver_source, str) and os.path.isabs(resolver_source), 'not_configured', 'The instance DNS configuration is unavailable.')
    value = {'projectRoot': str(project), 'applicationName': proposal['applicationName'], 'instances': [instance],
             'runtimeUser': account.pw_name, 'allowRoot': proposal['runtimeIdentity'] == 'root',
             'listenPorts': proposal['listenPorts'], 'build': proposal['build'], 'runtime': proposal['runtime'],
             'resolvConf': str(b.CONFIG.parent/'application-dns'/f'{identity}.conf')}
    if namespace: value['networkNamespacePath'] = namespace
    isolated = {**config, 'applications': {'systemdProfiles': {identity: value}}}
    normalized = b.native.profiles(isolated, b.policy)[identity]
    # The review binds the resolved account, namespace and DNS source as well as the form.
    return value, normalized, resolver_source


def write_file(path, content):
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def require_trusted_parent(b, path):
    for entry in (path, *path.parents):
        info = entry.lstat()
        b.require(not entry.is_symlink() and info.st_uid == 0 and not info.st_mode & 0o022,
                  'not_configured', 'Deployment policy directories must be owned and writable only by root.')


def save_policy(b, raw):
    import json
    write_file(b.CONFIG, (json.dumps(raw, indent=2)+'\n').encode())


def require_stopped(b, identity, config):
    for directory, app in b.all_apps():
        if app.get('backend') != 'systemd' or app.get('deploymentProfile') != identity: continue
        b.busy(directory)
        b.require(app['state'] in ('stopped', 'unpublished') and not app.get('pendingReleaseId'),
                  'operation_busy', 'Stop or withdraw the application before revoking its deployment authorization.')
        for metadata in (directory/'releases').glob('*/native.json'):
            release = metadata.parent
            units, available = b.native_backend(config).inspect(release)
            b.require(available and all(unit['state'] in ('inactive', 'failed') and unit['pid'] == 0 for unit in units),
                      'operation_busy', 'Could not confirm that all releases are stopped. Stop the application first.')


def handle(b, instance, action, envelope, *, admin=False):
    allowed = ('approve', 'reject', 'revoke') if admin else ('deployment-propose', 'deployment-requests', 'deployment-cancel')
    b.require(action in allowed, 'not_allowed', 'This operation requires the administrator review interface.')
    b.require(isinstance(envelope, dict) and set(envelope) <= {'roots', 'input'}, 'invalid_manifest', 'Invalid deployment request envelope.')
    payload = envelope.get('input', {})
    b.require(isinstance(payload, dict), 'invalid_manifest', 'Expected deployment request fields.')
    with b.Lock(b.STATE/'state.lock'), b.Lock(b.PUBLICATION_LOCK), b.policy.configuration_lock():
        # Re-read under the shared lock: simultaneous approvals must not overwrite other grants.
        config = b.load_config(int(os.environ.get('SUDO_UID', '0')))
        roots = b.scope_roots(b.profile_for(config, instance), envelope.get('roots'))
        b.require(roots, 'not_allowed', 'No authorized workspace for this instance.')
        path = b.STATE/'deployment-requests.json'
        records = b.read(path, {})
        profiles = b.native.profiles(config, b.policy)
        recovered = False
        for record in records.values():
            if record['status'] == 'pending' and profiles.get(record['proposal']['profileId']) == record['resolved']:
                # Recover a completed policy write if the process died before its receipt.
                record['status'] = 'approved'
                recovered = True
        if recovered: b.atomic(path, records)
        if action == 'deployment-propose':
            value, normalized, source = resolve(b, config, instance, roots, payload)
            b.require(payload['profileId'] not in profiles, 'not_allowed', 'This profile name is already registered. Revoke it before replacing it, or choose a new name.')
            # Identical retries return the same request. A revised draft supersedes only this
            # instance's pending request with this name; a stale review can never approve it.
            proposal = {**payload, 'projectRoot': normalized['projectRoot'], 'listenPorts': normalized['listenPorts'],
                        'build': normalized['build'], 'runtime': normalized['runtime']}
            for record in records.values():
                if record['status'] == 'pending' and record['instanceId'] == instance and record['proposal']['profileId'] == payload['profileId']:
                    if record['proposal'] == proposal and record['resolved'] == normalized and record['resolverSource'] == source:
                        return {'deploymentRequests': [public(record)]}
                    record['status'] = 'cancelled'
            b.require(sum(item['status'] == 'pending' for item in records.values()) < 100,
                      'operation_busy', 'Review or dismiss pending deployment requests before adding more.')
            record = {'requestId': uuid.uuid4().hex, 'proposal': proposal, 'instanceId': instance,
                      'runtimeUser': normalized['runtimeUser'], 'networkNamespace': normalized['networkNamespacePath'] or 'host',
                      'createdAt': b.now(), 'status': 'pending', 'resolved': normalized, 'resolverSource': source}
            record['revision'] = b.native.digest(record)
            records[record['requestId']] = record
        elif action == 'revoke':
            b.require(set(payload) == {'profileId', 'revision'}, 'invalid_manifest', 'Invalid revocation request.')
            selected = profiles.get(payload['profileId'])
            b.require(selected and instance in selected['instances'], 'not_found', 'Deployment profile unavailable.')
            b.policy.authorized_project(selected['projectRoot'], roots, config)
            b.require(b.native.digest(selected) == payload['revision'], 'not_allowed', 'The profile changed. Refresh and review it again.')
            require_stopped(b, payload['profileId'], config)
            raw = b.policy.trusted_json(b.CONFIG)
            del raw['applications']['systemdProfiles'][payload['profileId']]
            marker = b.native.POLICIES/b.native.digest(selected)
            marker.unlink(missing_ok=True)
            try: save_policy(b, raw)
            except Exception:
                write_file(marker, b'Granted native application policy\n')
                raise
            config['applications'] = raw['applications']
        elif action != 'deployment-requests':
            fields = {'requestId', 'revision', 'confirmRoot'} if action == 'approve' else {'requestId', 'revision'}
            b.require(set(payload) == fields, 'invalid_manifest', 'Invalid deployment review fields.')
            record = records.get(payload.get('requestId'))
            b.require(record and record_visible(b, record, instance, roots), 'not_found', 'Deployment request unavailable.')
            b.require(record['status'] == 'pending' and record['revision'] == payload['revision'],
                      'not_allowed', 'The request changed or was already reviewed. Refresh and review it again.')
            if action == 'approve':
                proposal = record['proposal']
                value, normalized, source = resolve(b, config, instance, roots, proposal)
                b.require(normalized == record['resolved'] and source == record['resolverSource'],
                          'not_allowed', 'The host or instance policy changed. Create a new request to review the current settings.')
                b.require(type(payload['confirmRoot']) is bool and (normalized['uid'] != 0 or payload['confirmRoot']),
                          'not_allowed', 'Explicitly confirm the root runtime identity before approval.')
                b.require(proposal['profileId'] not in profiles, 'not_allowed', 'A profile with this name is already registered.')
                b.require(len(profiles) < 128, 'not_allowed', 'The host has reached its deployment profile limit.')
                try: b.native.verify_native_host(pwd.getpwuid(config['ownerUid']))
                except (OSError, ValueError, subprocess.SubprocessError):
                    b.require(False, 'not_configured', 'Host isolation preflight failed. Ask the maintenance administrator to verify systemd 257+, cgroup v2 and namespace support.')
                if normalized['networkNamespacePath']:
                    try: require_trusted_parent(b, Path(normalized['networkNamespacePath']))
                    except OSError: b.require(False, 'not_configured', 'The selected network namespace is unavailable.')
                # Capture the administrator-selected resolver into a root-owned file. Host
                # systemd-resolved commonly owns its original file; never expose a path input.
                try:
                    with Path(source).open('rb') as stream: dns = stream.read(65537)
                except OSError: b.require(False, 'not_configured', 'The selected DNS configuration is unavailable.')
                b.require(len(dns) <= 65536 and b'\0' not in dns, 'not_configured', 'The selected DNS configuration is invalid.')
                for folder in (b.CONFIG.parent/'application-dns', b.native.POLICIES):
                    folder.mkdir(parents=True, exist_ok=True, mode=0o755)
                    require_trusted_parent(b, folder)
                write_file(Path(value['resolvConf']), dns)
                raw = b.policy.trusted_json(b.CONFIG)
                raw.setdefault('applications', {}).setdefault('systemdProfiles', {})[proposal['profileId']] = value
                marker = b.native.POLICIES/b.native.digest(normalized)
                write_file(marker, b'Granted native application policy\n')
                try: save_policy(b, raw)
                except Exception:
                    marker.unlink(missing_ok=True)
                    raise
                config['applications'] = raw['applications']
                record['status'] = 'approved'
            else:
                record['status'] = 'rejected' if action == 'reject' else 'cancelled'
        if action != 'deployment-requests':
            # Keep all pending requests and a bounded review history; survive server restarts.
            completed = sorted((item for item in records.values() if item['status'] != 'pending'), key=lambda item: item['createdAt'])
            for item in completed[:-100]: del records[item['requestId']]
            b.atomic(path, records)
        visible = []
        for record in records.values():
            if record_visible(b, record, instance, roots): visible.append(public(record))
        return {'deploymentRequests': sorted(visible, key=lambda item: item['createdAt'], reverse=True),
                'deploymentProfiles': b.native_backend(config).visible_profiles(instance, roots)}
