"""Trusted host policy shared by sandbox mounts and the application broker."""
import json
import os
from pathlib import Path
import stat

CONFIG = Path('/etc/t3code/resources.json')
DEFAULT_PROTECTED = ('/opt/t3code', '/etc/t3code', '/var/lib/t3code-applications',
                     '/var/lib/t3code-service-network', '/etc/systemd/system',
                     '/etc/caddy', '/usr/local/libexec', '/etc/sudoers.d')


class PolicyError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise PolicyError(code, message)


def trusted_json(path):
    path = Path(path)
    for parent in (path, *path.parents):
        info = parent.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'not_configured', 'Resource policy must be root-owned with trusted parents.')
    require(path.stat().st_size <= 1024 * 1024, 'not_configured', 'Resource policy is too large.')
    return json.loads(path.read_text())


def load_policy(owner_uid=None):
    config = trusted_json(CONFIG) if CONFIG.exists() else {}
    if owner_uid is not None and config:
        require(config.get('ownerUid') == owner_uid, 'not_allowed', 'Resource policy belongs to another host owner.')
    configured = config.get('protectedPaths', [])
    require(isinstance(configured, list), 'not_configured', 'Invalid protected path policy.')
    paths = [{'path': value, 'visibility': 'hidden'} for value in DEFAULT_PROTECTED]
    for entry in configured:
        require(isinstance(entry, dict) and set(entry) <= {'path', 'visibility'} and
                isinstance(entry.get('path'), str) and os.path.isabs(entry['path']) and
                entry.get('visibility') in ('read', 'hidden'), 'not_configured', 'Invalid protected path policy.')
        paths.append(entry)
    config['protectedPaths'] = paths
    return config


def inside(path, root):
    return path == root or root in path.parents


def overlaps(path, root):
    return inside(path, root) or inside(root, path)


def path_variants(path):
    # Check both the lexical view and the real target, including symlinked parents.
    return {Path(os.path.abspath(path)), Path(path).resolve()}


def protect_project(path, policy):
    for entry in policy['protectedPaths']:
        require(not any(overlaps(value, protected) for value in path_variants(path)
                        for protected in path_variants(entry['path'])), 'protected_resource',
                'The project overlaps a protected T3 management resource. Select a business project directory.')


def authorized_project(path, roots, policy):
    project = Path(path).resolve(strict=True)
    require(project.is_dir() and any(inside(project, Path(root).resolve()) for root in roots),
            'not_allowed', 'Project is outside this Harness workspace.')
    protect_project(project, policy)
    return project


def protected_mounts(visible_roots, policy, writable_roots=()):
    entries = {}
    for entry in policy['protectedPaths']:
        for path in path_variants(entry['path']):
            if path.exists() and any(inside(path, Path(root).resolve()) for root in visible_roots):
                old = entries.get(path)
                if old != 'hidden':
                    entries[path] = entry['visibility']
            for root in writable_roots:
                root = Path(root).resolve()
                if root.exists() and inside(root, path) and entries.get(root) != 'hidden':
                    entries[root] = entry['visibility']
    return sorted(entries.items(), key=lambda pair: len(pair[0].parts))
