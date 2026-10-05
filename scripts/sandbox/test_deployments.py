"""Deployment review white-box tests; host policy, root ownership and systemd are mocked."""
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import test_applications as base

b = base.broker
d = b.deployments


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        base.ApplicationTests.setUp(self)
        self.config['applications']['enabled'] = False
        self.config['protectedRepositories'] = ['owner/framework']
        self.config['reservedPorts'] = [3773, 3774]
        self.config_file = self.root/'etc/resources.json'
        b.atomic(self.config_file, self.config)
        self.profile['network'] = {'mode': 'host'}
        extra = [
            patch.object(b, 'CONFIG', self.config_file),
            patch.object(b.policy, 'CONFIG_LOCK', self.root/'policy.lock'),
            patch.object(b.native, 'POLICIES', self.root/'markers'),
            patch.object(b.policy, 'trusted_json', side_effect=lambda path: json.loads(path.read_text())),
            patch.object(b, 'load_config', side_effect=lambda *_: json.loads(self.config_file.read_text())),
            patch.object(b.native, 'verify_native_host'),
            patch.object(d, 'require_trusted_parent'),
            patch.object(b, 'run', side_effect=AssertionError('Unexpected host command')),
        ]
        self.patchers += extra
        for item in extra: item.start()
        self.proposal = {'profileId': 'bot', 'projectRoot': str(self.project), 'applicationName': 'blog',
                         'runtimeIdentity': 'owner', 'network': 'instance', 'listenPorts': [],
                         'build': {'memoryMiB': 1024, 'cpuPercent': 100, 'tasks': 128, 'timeoutSeconds': 900},
                         'runtime': {'memoryMiB': 256, 'cpuPercent': 50, 'tasks': 64, 'timeoutSeconds': 60}}

    tearDown = base.ApplicationTests.tearDown

    def call(self, action, payload=None, *, admin=False, instance='codex', roots=None):
        return d.handle(b.BrokerApi(), instance, action,
                        {'roots': roots or [str(self.workspace)], 'input': payload or {}}, admin=admin)

    def propose(self, **changes):
        return next(item for item in self.call('deployment-propose', {**self.proposal, **changes})['deploymentRequests'] if item['status'] == 'pending')

    def review(self, request, **extra):
        return {'requestId': request['requestId'], 'revision': request['revision'], **extra}

    def approve(self, request, confirm=False):
        return self.call('approve', self.review(request, confirmRoot=confirm), admin=True)

    def test_draft_is_durable_scoped_and_does_not_change_policy(self):
        original = self.config_file.read_bytes()
        record = self.propose(runtimeIdentity='root')
        self.assertEqual(self.config_file.read_bytes(), original)
        b.native.verify_native_host.assert_not_called()
        self.assertEqual(self.propose(runtimeIdentity='root')['requestId'], record['requestId'])
        self.assertEqual(self.call('deployment-requests')['deploymentRequests'], [record])
        self.assertEqual(self.call('deployment-requests', instance='grok')['deploymentRequests'], [])
        other = self.workspace/'other'; other.mkdir()
        self.assertEqual(self.call('deployment-requests', roots=[str(other)])['deploymentRequests'], [])

    def test_harness_cannot_approve_and_root_requires_explicit_confirmation(self):
        record = self.propose(runtimeIdentity='root')
        with self.assertRaises(b.policy.PolicyError): self.call('approve', self.review(record, confirmRoot=True))
        with self.assertRaises(b.policy.PolicyError): self.approve(record)
        result = self.approve(record, True)
        self.assertEqual(result['deploymentRequests'][0]['status'], 'approved')
        self.assertEqual(result['deploymentProfiles'][0]['runtimeUser'], 'root')
        b.native.verify_native_host.assert_called_once()
        with self.assertRaises(b.policy.PolicyError): self.approve(record, True)

    def test_new_draft_invalidates_the_old_review_and_revision_is_checked(self):
        first = self.propose()
        second = self.propose(runtimeIdentity='root')
        self.assertNotEqual(first['requestId'], second['requestId'])
        with self.assertRaises(b.policy.PolicyError): self.approve(first)
        with self.assertRaises(b.policy.PolicyError): self.approve({**second, 'revision': first['revision']}, True)
        self.call('reject', self.review(second), admin=True)
        with self.assertRaises(b.policy.PolicyError): self.approve(second, True)

    def test_cancellation_and_cross_instance_approval_are_rejected(self):
        record = self.propose()
        with self.assertRaises(b.policy.PolicyError): self.call('approve', self.review(record, confirmRoot=False), admin=True, instance='grok')
        self.call('deployment-cancel', self.review(record))
        with self.assertRaises(b.policy.PolicyError): self.approve(record)

    def test_approval_merges_profiles_and_preserves_host_protection(self):
        first = self.propose()
        second = self.propose(profileId='second')
        self.approve(first)
        self.approve(second)
        config = json.loads(self.config_file.read_text())
        self.assertEqual(set(config['applications']['systemdProfiles']), {'bot', 'second'})
        for key in ['protectedPaths', 'protectedRepositories', 'reservedPorts']:
            self.assertEqual(config[key], self.config[key])
        self.assertFalse(config['applications']['enabled'])
        self.assertTrue(Path(config['applications']['systemdProfiles']['bot']['resolvConf']).exists())
        self.assertEqual(len(list(b.native.POLICIES.iterdir())), 2)

    def test_failed_preflight_or_write_never_grants_policy(self):
        record = self.propose()
        before = self.config_file.read_bytes()
        with patch.object(b.native, 'verify_native_host', side_effect=ValueError('fixture unsupported')):
            with self.assertRaises(b.policy.PolicyError): self.approve(record)
        self.assertEqual(self.config_file.read_bytes(), before)
        with patch.object(d, 'save_policy', side_effect=OSError('fixture disk full')):
            with self.assertRaises(OSError): self.approve(record)
        self.assertEqual(self.config_file.read_bytes(), before)
        self.assertEqual(list(b.native.POLICIES.iterdir()), [])
        self.assertEqual(self.call('deployment-requests')['deploymentRequests'][0]['status'], 'pending')

    def test_protected_project_reserved_ports_and_host_fields_are_rejected(self):
        for changes in [{'projectRoot': str(self.framework)}, {'projectRoot': str(self.workspace)},
                        {'listenPorts': [3773]}, {'listenPorts': [22]}, {'runtimeIdentity': 'dev'},
                        {'network': '/run/netns/other'}, {'resolvConf': '/etc/shadow'},
                        {'runtime': {**self.proposal['runtime'], 'memoryMiB': 1}}]:
            with self.subTest(changes=changes), self.assertRaises(b.policy.PolicyError): self.propose(**changes)

    def test_network_is_resolved_from_trusted_profile_and_changes_invalidate_review(self):
        resolver = self.root/'dns'; resolver.write_text('nameserver 1.1.1.1\n')
        self.profile['network'] = {'mode': 'namespace', 'path': '/run/netns/claude-egress', 'resolvConf': str(resolver)}
        network = copy.deepcopy(self.profile['network'])
        record = self.propose()
        self.assertEqual(record['networkNamespace'], network['path'])
        self.profile['network']['path'] = '/run/netns/changed'
        with self.assertRaises(b.policy.PolicyError): self.approve(record)
        self.profile['network'] = network
        self.approve(record)
        self.assertEqual(self.profile['network'], network)
        value = json.loads(self.config_file.read_text())['applications']['systemdProfiles']['bot']
        self.assertEqual(value['networkNamespacePath'], network['path'])
        self.assertEqual(Path(value['resolvConf']).read_text(), resolver.read_text())

    def test_existing_profile_cannot_be_overwritten_and_revocation_is_version_bound(self):
        result = self.approve(self.propose())
        selected = result['deploymentProfiles'][0]
        with self.assertRaises(b.policy.PolicyError): self.propose(runtimeIdentity='root')
        with self.assertRaises(b.policy.PolicyError): self.call('revoke', {'profileId': 'bot', 'revision': '0'*64}, admin=True)
        self.call('revoke', {'profileId': 'bot', 'revision': selected['revision']}, admin=True)
        self.assertEqual(self.call('deployment-requests')['deploymentProfiles'], [])
        self.assertEqual(list(b.native.POLICIES.iterdir()), [])
        self.propose()

    def test_running_application_blocks_revocation_without_stopping_it(self):
        result = self.approve(self.propose())
        selected = result['deploymentProfiles'][0]
        app = {'id': 'a'*32, 'projectRoot': str(self.project), 'name': 'blog', 'backend': 'systemd', 'deploymentProfile': 'bot', 'state': 'running'}
        directory = b.app_dir(app['id'])
        b.atomic(directory/'application.json', app)
        with self.assertRaises(b.policy.PolicyError): self.call('revoke', {'profileId': 'bot', 'revision': selected['revision']}, admin=True)
        self.assertEqual(json.loads((directory/'application.json').read_text())['state'], 'running')
        b.run.assert_not_called()
        self.assertEqual(len(self.call('deployment-requests')['deploymentProfiles']), 1)

    def test_scoped_list_works_before_any_application_backend_is_enabled(self):
        result = b.request('codex', 'deployment-requests', {'roots': [str(self.workspace)], 'input': {}}, self.config)
        self.assertEqual(result, {'deploymentRequests': [], 'deploymentProfiles': []})

    def test_missing_project_request_can_be_dismissed_but_not_approved(self):
        record = self.propose()
        self.project.rmdir()
        self.assertEqual(self.call('deployment-requests')['deploymentRequests'], [record])
        with self.assertRaises(b.policy.PolicyError): self.approve(record)
        self.call('reject', self.review(record), admin=True)
        self.assertEqual(self.call('deployment-requests')['deploymentRequests'][0]['status'], 'rejected')

    def test_policy_commit_survives_a_lost_approval_receipt(self):
        record = self.propose()
        with patch.object(b, 'atomic', side_effect=OSError('fixture receipt write failed')):
            with self.assertRaises(OSError): self.approve(record)
        result = self.call('deployment-requests')
        self.assertEqual(result['deploymentRequests'][0]['status'], 'approved')
        self.assertEqual(len(result['deploymentProfiles']), 1)
        with self.assertRaises(b.policy.PolicyError): self.call('reject', self.review(record), admin=True)


if __name__ == '__main__': unittest.main()
