"""Focused authority, snapshot, release and recovery tests without a Docker daemon."""
import copy
import datetime
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('applications', Path(__file__).with_name('t3code-applications.py'))
broker = importlib.util.module_from_spec(spec); spec.loader.exec_module(broker)


class ApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.workspace = self.root/'workspace'; self.workspace.mkdir()
        self.framework = self.workspace/'t3code'; self.framework.mkdir()
        self.project = self.workspace/'blog'; self.project.mkdir()
        self.config = {'ownerUid': os.getuid(), 'ownerGid': os.getgid(), 'runtimeUid': os.getuid(), 'runtimeGid': os.getgid(),
                       'protectedPaths': [{'path': str(self.framework), 'visibility': 'read'}], 'reservedHosts': ['agent.example.com'],
                       'applications': {'enabled': True, 'portRange': [42000, 42099], 'allowedDomainSuffixes': ['example.com']}}
        self.profile = {'instanceId': 'codex', 'uid': 1234, 'home': str(self.workspace), 'workspaces': [str(self.workspace)], 'providerHome': str(self.root/'private'), 'network': {'path': '/run/netns/t3-codex'}}
        self.manifest = {'services': {'web': {'image': 'node:24-alpine', 'ports': ['8080'], 'command': ['node', 'server.js'], 'healthcheck': {'test': ['CMD', 'node', '-e', 'fetch("http://127.0.0.1:8080").then(r=>{if(!r.ok)process.exit(1)})']}}}}
        self.patchers = [patch.object(broker, 'STATE', self.root/'state'), patch.object(broker, 'NETWORK_CONFIG', self.root/'network-config.json'), patch.object(broker, 'NETWORK_STATE', self.root/'network-state.json'), patch.object(broker, 'CADDY_FRAGMENT', self.root/'applications.caddy'), patch.object(broker, 'PUBLICATION_LOCK', self.root/'publication.lock'), patch.object(broker, 'profile_for', return_value=self.profile)]
        for item in self.patchers: item.start()
    def tearDown(self):
        for item in reversed(self.patchers): item.stop()
        self.temporary.cleanup()
    def declaration(self, manifest=None):
        (self.project/'compose.yaml').write_text(json.dumps(manifest or self.manifest))
        (self.project/'server.js').write_text('console.log("fixture");')
    def prepare(self, **extra):
        self.declaration()
        with patch.object(broker, 'run', return_value={'exitCode': 0, 'stdout': 'a'*40}):
            return broker.prepare(self.profile, [str(self.workspace)], {'projectRoot': str(self.project), 'name': 'blog', **extra}, self.config)
    def test_framework_parent_and_symlink_alias_are_protected(self):
        for path in [self.workspace, self.framework, self.framework/'child']:
            with self.assertRaises(broker.policy.PolicyError) as error:
                broker.policy.protect_project(path, self.config)
            self.assertEqual(error.exception.code, 'protected_resource')
        alias = self.project/'alias'; alias.symlink_to(self.framework)
        with self.assertRaises(broker.policy.PolicyError): broker.policy.protect_project(alias, self.config)
        self.assertEqual(broker.policy.authorized_project(self.project, [str(self.workspace)], self.config), self.project)
    def test_snapshot_ignores_secret_files_and_rejects_escaping_links_and_hardlinks(self):
        self.declaration()
        (self.project/'.env').write_text('SECRET=fixture-secret')
        digest = broker.safe_snapshot(self.project, self.root/'snapshot', self.config)
        self.assertFalse((self.root/'snapshot/.env').exists())
        self.assertEqual((self.root/'snapshot').stat().st_mode & 0o777, 0o755)
        (self.project/'server.js').write_text('changed')
        self.assertNotEqual(digest, broker.safe_snapshot(self.project, self.root/'snapshot2', self.config))
        escape = self.project/'escape'; escape.symlink_to('/etc/passwd')
        with self.assertRaises(broker.policy.PolicyError): broker.safe_snapshot(self.project, self.root/'snapshot3', self.config)
        escape.unlink(); os.link(self.project/'server.js', self.project/'alias.js')
        with self.assertRaises(broker.policy.PolicyError): broker.safe_snapshot(self.project, self.root/'snapshot4', self.config)
    def validate(self, manifest):
        directory = self.root/'state/apps'/('a'*32)/'releases'/('b'*32)
        directory.mkdir(parents=True, exist_ok=True)
        return broker.validate_compose(manifest, self.project, directory, self.config, iter(range(42000, 42099)).__next__)
    def test_compose_cannot_get_host_authority_or_choose_a_host_port(self):
        for field, value in [('privileged', True), ('network_mode', 'host'), ('pid', 'host'), ('devices', ['/dev/sda']), ('container_name', 'agent-web'), ('env_file', '/etc/t3code/secret'), ('volumes', ['/var/run/docker.sock:/sock']), ('volumes', [str(self.framework)+':/src:ro']), ('ports', ['0.0.0.0:8080:8080']), ('ports', ['3773:8080']), ('user', '0:0')]:
            manifest = copy.deepcopy(self.manifest); manifest['services']['web'][field] = value
            with self.subTest(field=field,value=value), self.assertRaises(broker.policy.PolicyError): self.validate(manifest)
        manifest = {**self.manifest, 'include': ['/etc/t3code/secret']}
        with self.assertRaises(broker.policy.PolicyError): self.validate(manifest)
    def test_healthcheck_and_no_host_environment_inheritance_are_required(self):
        for change in [{'healthcheck': None}, {'environment': ['HOST_SECRET']}, {'environment': {'HOST_SECRET': None}}, {'build': {'context': 'https://attacker.invalid/repo'}}]:
            manifest = copy.deepcopy(self.manifest); manifest['services']['web'].update(change)
            with self.subTest(change=change), self.assertRaises(broker.policy.PolicyError): self.validate(manifest)
    def test_compose_is_normalized_with_private_ports_identity_and_persistent_data(self):
        manifest = copy.deepcopy(self.manifest)
        manifest.update(volumes={'data': {}})
        manifest['services']['web']['volumes'] = ['data:/app/data']
        manifest['services']['web']['environment'] = {'EXPLICIT': '${HOST_SECRET}'}
        manifest['x-t3'] = {'credentials': {'web': {'APP_TOKEN': 'BUSINESS_TOKEN'}}}
        compose, ports, bindings, names = self.validate(manifest)
        self.assertEqual(compose['services']['web']['restart'], 'unless-stopped')
        self.assertEqual(compose['services']['web']['ports'][0]['host_ip'], '127.0.0.1')
        self.assertEqual(compose['services']['web']['user'], f'{os.getuid()}:{os.getgid()}')
        self.assertEqual(compose['services']['web']['environment']['EXPLICIT'], '$${HOST_SECRET}')
        self.assertEqual(names, ['BUSINESS_TOKEN']); self.assertNotIn('fixture-secret', json.dumps(compose))
        self.assertEqual(bindings, {'web': {'APP_TOKEN': 'BUSINESS_TOKEN'}})
        self.assertEqual(ports[0]['hostPort'], 42000)
    def test_application_identity_cross_instance_project_authority_and_reserved_hostname(self):
        prepared = self.prepare()
        identifier = prepared['application']['id']
        directory, app = broker.authorized_app(identifier, [str(self.workspace)], self.config)
        self.assertEqual(app['createdBy'], 'codex')
        # The directory authority, not creator identity, controls collaboration.
        other = {**self.profile, 'instanceId': 'grok'}
        with patch.object(broker, 'profile_for', return_value=other):
            result = broker.request('grok','list',{'roots':[str(self.workspace)],'input':{}},self.config)
        self.assertEqual(result['applications'][0]['id'], identifier)
        with self.assertRaises(broker.policy.PolicyError): broker.authorized_app(identifier, [str(self.framework)], self.config)
        for hostname in ['agent.example.com', 'attacker.invalid', 'bad\n.example.com']:
            with self.assertRaises(broker.policy.PolicyError): broker.checked_hostname(hostname, identifier, self.config)
        self.assertEqual(prepared['release']['sourceCommit'], 'a'*40)
        self.assertNotIn('source', prepared['application'])
    def test_only_registered_objects_can_be_operated_and_a_preparation_is_not_success(self):
        prepared = self.prepare()
        self.assertEqual(prepared['operation']['stage'], 'validating')
        self.assertEqual(prepared['release']['status'], 'prepared')
        with self.assertRaises(broker.policy.PolicyError): broker.release_dir(broker.app_dir(prepared['application']['id']), 'c'*32)
        with self.assertRaises(broker.policy.PolicyError): broker.app_dir('../../etc')
        with self.assertRaises(broker.policy.PolicyError): broker.busy(broker.app_dir(prepared['application']['id']))
    def test_job_uses_its_own_systemd_unit_and_secret_values_never_enter_argv(self):
        prepared = self.prepare()
        directory = broker.app_dir(prepared['application']['id'])
        with patch.object(broker, 'run', return_value={'exitCode':0}) as run:
            broker.start_worker(directory, prepared['operation'], self.config)
        argv = run.call_args.args[0]
        self.assertIn('/usr/bin/systemd-run', argv)
        self.assertIn('t3-application-'+prepared['operation']['id'], argv)
        self.assertNotIn('agent-web', ' '.join(argv)); self.assertNotIn('fixture-secret', ' '.join(argv))
    def test_runtime_logs_are_bounded_and_page_stable_and_inspect_hides_values(self):
        prepared = self.prepare()
        directory = broker.app_dir(prepared['application']['id']); app = prepared['application']; app['currentReleaseId'] = prepared['release']['id']
        release = broker.release_dir(directory, app['currentReleaseId']); broker.install_values(release, {}, {})
        output='\n'.join('line-'+str(i) for i in range(5))
        with patch.object(broker, 'run', return_value={'exitCode':0,'stdout':output,'stderr':'','truncated':False}):
            page1=broker.get_logs(directory,app,{'limit':2}); page2=broker.get_logs(directory,app,{'limit':2,'cursor':page1['cursor']})
        self.assertEqual([item['text'] for item in page1['entries']],['line-0','line-1'])
        self.assertEqual([item['text'] for item in page2['entries']],['line-2','line-3'])
    def test_worker_failure_records_stage_and_does_not_claim_success(self):
        prepared = self.prepare()
        directory = broker.app_dir(prepared['application']['id'])
        release = broker.release_dir(directory, prepared['release']['id']); broker.install_values(release, {}, {})
        def fail_build(argv, **kwargs):
            return {'exitCode':1,'stdout':'','stderr':'failure','truncated':False,'cancelled':False}
        with patch.object(broker,'run',side_effect=fail_build): broker.worker(directory.name,prepared['operation']['id'],self.config)
        operation=broker.read(directory/'operations'/prepared['operation']['id']/'operation.json')
        self.assertEqual(operation['stage'],'failed');self.assertEqual(operation['failedStage'],'building');self.assertEqual(operation['error']['code'],'build_failed')
        self.assertEqual(broker.read(release/'release.json')['status'],'failed')
        self.assertEqual(broker.read(directory/'application.json')['state'],'unpublished')

    def test_public_success_requires_verified_https_and_the_selected_release(self):
        prepared = self.prepare(hostname='blog.example.com')
        metadata = prepared['release']
        for response in [{'exitCode': 6, 'stdout': '', 'cancelled': False},
                         {'exitCode': 0, 'stdout': 'HTTP/2 200\nX-T3-Release: wrong\n', 'cancelled': False},
                         {'exitCode': 0, 'stdout': 'HTTP/2 502\nX-T3-Release: '+metadata['id']+'\n', 'cancelled': False}]:
            with patch.object(broker, 'run', return_value=response), self.assertRaises(broker.policy.PolicyError) as failure:
                broker.verify_public_route(metadata)
            self.assertEqual(failure.exception.code, 'route_failed')
        with patch.object(broker, 'run', return_value={'exitCode': 0, 'stdout': 'HTTP/2 404\nX-T3-Release: '+metadata['id']+'\n', 'cancelled': False}) as run:
            broker.verify_public_route(metadata)
        argv = run.call_args.args[0]
        self.assertNotIn('--insecure', argv)
        self.assertIn('https://blog.example.com/', argv)

    def test_failed_public_probe_restores_previous_route_and_version(self):
        first = self.prepare(hostname='blog.example.com')
        directory = broker.app_dir(first['application']['id'])
        old = first['release']; old['status'] = 'ready'; broker.atomic(directory/'releases'/old['id']/'release.json', old)
        app = first['application']; app.update(state='running', currentReleaseId=old['id'], hostname=old['hostname'])
        broker.atomic(directory/'application.json', app)
        broker.operation_update(directory/'operations'/first['operation']['id']/'operation.json', 'succeeded')
        second = self.prepare(applicationId=app['id'], hostname='new.example.com')
        release = directory/'releases'/second['release']['id']; broker.install_values(release, {}, {})
        containers = [{'component':'web','image':'sha256:'+'f'*64,'health':'healthy'}]
        def fake_run(argv, **kwargs):
            return {'exitCode':0,'stdout':'sha256:'+'f'*64 if argv[:3] == [broker.DOCKER,'image','inspect'] else '', 'stderr':'','truncated':False,'cancelled':False}
        routes = []
        with patch.object(broker, 'run', side_effect=fake_run), patch.object(broker, 'inspect_runtime', return_value=(containers,True)), patch.object(broker, 'apply_routes', side_effect=lambda: routes.append(broker.caddy_text())), patch.object(broker, 'verify_public_route', side_effect=broker.policy.PolicyError('route_failed','fixture DNS failure')):
            broker.worker(directory.name, second['operation']['id'], self.config)
        result = broker.read(directory/'application.json')
        self.assertEqual(result['currentReleaseId'], old['id']); self.assertEqual(result['hostname'],'blog.example.com')
        operation = broker.read(directory/'operations'/second['operation']['id']/'operation.json')
        self.assertEqual(operation['error']['code'], 'route_failed'); self.assertEqual(operation['recovery'],'restored')
        self.assertIn('new.example.com', routes[0]); self.assertNotIn('new.example.com',routes[-1])
        self.assertIn('X-T3-Release '+old['id'],routes[-1])

    def test_interrupted_jobs_and_abandoned_preparations_do_not_stay_busy_forever(self):
        prepared = self.prepare(); directory = broker.app_dir(prepared['application']['id'])
        path = directory/'operations'/prepared['operation']['id']/'operation.json'
        operation = broker.read(path)
        operation['updatedAt'] = (datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=6)).isoformat()
        broker.atomic(path,operation); broker.busy(directory)
        self.assertEqual(broker.read(path)['stage'],'failed')
        broker.operation_update(path,'building')
        with patch.object(broker,'run',return_value={'exitCode':0,'stdout':'active\n'}):
            with self.assertRaises(broker.policy.PolicyError): broker.busy(directory)
        with patch.object(broker,'run',return_value={'exitCode':0,'stdout':'inactive\n'}): broker.busy(directory)
        self.assertIn('interrupted',broker.read(path)['error']['message'])

    def test_history_cannot_restart_with_missing_or_changed_binding_values(self):
        prepared = self.prepare(); directory = broker.app_dir(prepared['application']['id'])
        release = directory/'releases'/prepared['release']['id']
        metadata = broker.read(release/'release.json'); metadata.update(status='ready', credentialNames=['APP_KEY'])
        broker.atomic(release/'release.json',metadata); broker.atomic(release/'bindings.json',{'web':{'API_KEY':'APP_KEY'}})
        broker.install_values(release,{'APP_KEY':'fixture-original'}, {'APP_KEY':1})
        app=prepared['application'];app.update(currentReleaseId=metadata['id'],state='stopped');broker.atomic(directory/'application.json',app)
        broker.operation_update(directory/'operations'/prepared['operation']['id']/'operation.json','succeeded')
        request={'roots':[str(self.workspace)],'input':{'applicationId':app['id'],'action':'start'}}
        for extra in [{}, {'versions':{'APP_KEY':1},'values':{'APP_KEY':'fixture-rotated'}}, {'versions':{'APP_KEY':2},'values':{'APP_KEY':'fixture-original'}}]:
            with patch.object(broker,'start_worker') as start, self.assertRaises(broker.policy.PolicyError) as error:
                broker.request('codex','control',{**request,**extra},self.config)
            self.assertEqual(error.exception.code,'credential_expired');start.assert_not_called()
        with patch.object(broker,'start_worker') as start:
            broker.request('codex','control',{**request,'versions':{'APP_KEY':1},'values':{'APP_KEY':'fixture-original'}},self.config)
        start.assert_called_once()


if __name__ == '__main__': unittest.main()
