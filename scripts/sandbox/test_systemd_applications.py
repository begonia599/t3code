"""Native deployment and BuildKit white-box tests; never contact the host service manager."""
import copy
import json
import importlib.util
from types import SimpleNamespace
import os
from pathlib import Path
import pwd
import unittest
from unittest.mock import patch
import test_applications as base

broker = base.broker

native = broker.native
OK = {'exitCode': 0, 'stdout': '', 'stderr': '', 'cancelled': False, 'truncated': False}


class NativeTests(unittest.TestCase):
    setUp = base.ApplicationTests.setUp
    tearDown = base.ApplicationTests.tearDown

    def setup_native(self, **grant):
        self.config['applications']['enabled'] = False
        self.config['applications']['systemdProfiles'] = {'bot': {
            'projectRoot': str(self.project), 'applicationName': 'blog', 'instances': ['codex'],
            'runtimeUser': pwd.getpwuid(os.getuid()).pw_name, **grant}}
        self.backend = broker.native_backend(self.config)
        self.manifest = {'command': ['/usr/bin/python3', '/app/bot.py'], 'healthcheck': {'type': 'process', 'retries': 1},
                         'credentials': {'BOT_TOKEN': 'BOT_KEY'}}
        self.units = self.root/'units'; self.units.mkdir()
        self.patchers.append(patch.object(native, 'UNITS', self.units)); self.patchers[-1].start()
        # Only resolver metadata is mocked: systemd-resolved may own the real DNS file.
        resolver = Path('/etc/resolv.conf').resolve()
        resolver_paths = {resolver, *resolver.parents}
        original_lstat = Path.lstat
        def resolver_lstat(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            if path in resolver_paths:
                fields = list(info); fields[4] = 0; fields[0] &= ~0o022
                return os.stat_result(fields)
            return info
        self.patchers.append(patch.object(Path, 'lstat', resolver_lstat)); self.patchers[-1].start()
        # Subprocesses are mocked globally for every native test, including exceptional cleanup.
        self.calls = []
        def fake_run(argv, **kwargs):
            self.calls.append((argv, kwargs))
            return {**OK, 'stdout': 'a'*40 if 'rev-parse' in argv else ''}
        self.patchers.append(patch.object(broker, 'run', side_effect=fake_run)); self.patchers[-1].start()

    def prepare(self, **extra):
        (self.project/'application.yaml').write_text(json.dumps(self.manifest))
        (self.project/'bot.py').write_text('print("fixture")')
        result = broker.prepare(self.profile, [str(self.workspace)], {
            'projectRoot': str(self.project), 'name': 'blog', 'backend': 'systemd', 'deploymentProfile': 'bot', **extra}, self.config)
        release = broker.app_dir(result['application']['id'])/'releases'/result['release']['id']
        broker.install_values(release, {'BOT_KEY': 'fixture-private-token'}, {'BOT_KEY': 1})
        return result, release

    def validate(self, manifest):
        return self.backend.validate(manifest, self.project, {'projectRoot': str(self.project), 'name': 'blog'}, 'bot', 'codex')

    def settings(self, release, spec, **kwargs):
        # No chown may touch the host; the isolated DNS metadata is supplied by setup_native.
        with patch.object(native.os, 'chown'):
            return self.backend._settings(release, spec, **kwargs)

    def ready(self, prepared, release):
        app = prepared['application']; app.update(currentReleaseId=release.name, state='running')
        broker.atomic(release.parent.parent/'application.json', app)
        metadata = broker.read(release/'release.json'); metadata['status'] = 'ready'
        broker.atomic(release/'release.json', metadata)
        broker.operation_update(release.parent.parent/'operations'/prepared['operation']['id']/'operation.json', 'succeeded')
        (release/'artifact').mkdir(exist_ok=True)

    def test_root_is_an_explicit_application_and_instance_grant(self):
        self.setup_native(runtimeUser='root')
        with self.assertRaises(broker.policy.PolicyError): self.validate(self.manifest)
        self.config['applications']['systemdProfiles']['bot']['allowRoot'] = True
        spec, _, _ = self.validate(self.manifest)
        self.assertEqual(spec['profile']['uid'], 0)
        for changes in [{'instances': ['grok']}, {'applicationName': 'other'}, {'projectRoot': str(self.framework)}, {'capabilities': ['CAP_SYS_ADMIN']}]:
            saved = copy.deepcopy(self.config)
            self.config['applications']['systemdProfiles']['bot'].update(changes)
            with self.subTest(changes=changes), self.assertRaises(broker.policy.PolicyError): self.validate(self.manifest)
            self.config.clear(); self.config.update(saved)

    def test_manifest_cannot_supply_host_authority_or_inherited_environment(self):
        self.setup_native()
        for changes in [{'user': 'root'}, {'mounts': ['/root']}, {'command': 'python bot.py'}, {'command': ['/usr/bin/../sbin/reboot']},
                        {'command': ['/usr/bin/python3', 'a\nExecStart=x']}, {'environment': {'HOME': '/root'}}, {'environment': {'TOKEN': None}},
                        {'healthcheck': {}}, {'credentials': {'TOKEN': 'bad key'}}]:
            with self.subTest(changes=changes), self.assertRaises(broker.policy.PolicyError): self.validate({**self.manifest, **changes})

    def test_prepare_native_without_docker_and_profile_visibility(self):
        self.setup_native()
        prepared, release = self.prepare()
        self.assertEqual(prepared['release']['manifestPath'], 'application.yaml')
        self.assertEqual(prepared['release']['components'], ['service'])
        self.assertFalse((release/'compose.json').exists())
        result = broker.request('codex', 'list', {'roots': [str(self.workspace)], 'input': {}}, self.config)
        self.assertEqual(result['backends'], ['systemd'])
        self.assertEqual(result['deploymentProfiles'][0]['id'], 'bot')
        self.assertEqual(self.backend.visible_profiles('grok', [str(self.workspace)]), [])
        with self.assertRaises(broker.policy.PolicyError): self.prepare(name='second', hostname='bot.example.com')

    def test_changed_profile_cannot_restore_historical_authority(self):
        self.setup_native()
        _, release = self.prepare()
        self.config['applications']['systemdProfiles']['bot']['runtime'] = {'memoryMiB': 256}
        with self.assertRaises(broker.policy.PolicyError) as error: self.backend.validate_release(release, 'codex')
        self.assertEqual(error.exception.code, 'not_allowed')

    def test_root_unit_has_private_filesystem_pids_limits_and_no_host_credentials(self):
        self.setup_native(runtimeUser='root', allowRoot=True, listenPorts=[8080])
        _, release = self.prepare(); spec = broker.read(release/'native.json')
        settings = self.settings(release, spec)
        self.assertEqual(settings['User'], '0'); self.assertEqual(settings['PrivatePIDs'], 'yes')
        self.assertEqual(settings['CapabilityBoundingSet'], ''); self.assertEqual(settings['NoNewPrivileges'], 'yes')
        self.assertEqual(settings['MemoryMax'], '512M'); self.assertEqual(settings['MemorySwapMax'], '0')
        self.assertEqual(settings['SocketBindDeny'], 'any')
        self.assertEqual(settings['SocketBindAllow'], ['ipv4:tcp:8080', 'ipv6:tcp:8080'])
        self.assertIn('artifact":"/app"', settings['BindReadOnlyPaths']); self.assertIn('data/native":"/data"', settings['BindPaths'])
        self.assertNotIn('/root', settings['BindReadOnlyPaths']); self.assertNotIn('/var/run', settings['BindPaths'])
        with patch.object(native.os, 'chown'):
            text = self.backend.unit_text(release, spec)
        self.assertIn('ConditionPathExists='+str(native.POLICIES/spec['profileDigest']), text)
        self.assertNotIn('fixture-private-token', text)
        self.assertIn('fixture-private-token', (release/'native.env').read_text())
        self.assertEqual((release/'native.env').stat().st_mode & 0o777, 0o600)

    def test_runtime_and_diagnostics_share_one_application_resource_budget(self):
        self.setup_native()
        _, release = self.prepare(); (release/'artifact').mkdir(); spec = broker.read(release/'native.json')
        with patch.object(native.os, 'chown'):
            self.backend.install(release, spec)
            self.backend.transient(release, spec, ['/usr/bin/true'], kind='exec', timeout=5)
        slice_name = self.backend.slice_name(release)
        self.assertIn('MemoryMax=512M', (self.units/slice_name).read_text())
        self.assertIn('Slice='+slice_name, (self.units/self.backend.unit_name(release)).read_text())
        self.assertIn('--property=Slice='+slice_name, next(argv for argv, _ in self.calls if argv[0] == '/usr/bin/systemd-run'))

    def test_stopping_an_already_removed_unit_is_idempotent(self):
        self.setup_native()
        _, release = self.prepare()
        def run(argv, **kwargs):
            return {**OK, 'stdout': 'LoadState=not-found\n'} if 'show' in argv else {**OK, 'exitCode': 1}
        with patch.object(broker, 'run', side_effect=run): self.backend.stop(release, remove=True)

    def test_transient_build_runs_as_owner_with_budget_and_stops_its_own_unit(self):
        self.setup_native(runtimeUser='root', allowRoot=True)
        _, release = self.prepare(); spec = broker.read(release/'native.json')
        self.backend.transient(release, spec, ['/usr/bin/printf', '$TOKEN', '%n'], kind='build', timeout=20)
        command = next(argv for argv, _ in self.calls if argv[0] == '/usr/bin/systemd-run')
        self.assertIn('--property=User='+str(os.getuid()), command)
        self.assertNotIn('--property=User=0', command)
        self.assertIn('--property=MemoryMax=2048M', command)
        self.assertIn('--property=RuntimeMaxSec=20s', command)
        self.assertIn('--expand-environment=no', command)
        self.assertEqual(command[-3:], ['/usr/bin/printf', '$TOKEN', '%n'])
        self.assertNotIn('fixture-private-token', str(command))
        self.assertNotIn('EnvironmentFile', str(command))
        self.assertEqual(self.calls[-1][0][-1], command[command.index('--unit')+1]+'.service')

    def test_argv_escaping_and_credential_environment_do_not_expand(self):
        self.assertEqual(native.command_line(['/usr/bin/echo', '$TOKEN', '%n', 'a"b']), '"/usr/bin/echo" "$$TOKEN" "%%n" "a\\"b"')
        self.setup_native()
        _, release = self.prepare(); spec = broker.read(release/'native.json')
        spec['environment'] = {'LITERAL': '$HOME %n "quoted" \\ tail'}
        self.backend.environment(release, spec)
        self.assertIn('LITERAL="$HOME %n \\"quoted\\" \\\\ tail"'.replace('\\\\"', '\\"'), (release/'native.env').read_text())

    def test_bind_paths_preserve_quoted_paths_and_an_unquoted_separator(self):
        self.assertEqual(native.bind_path('/source with spaces:literal', '/app'),
                         '"/source with spaces:literal":"/app"')
        self.assertEqual(native.bind_path('/source%name', '/data'), '"/source%%name":"/data"')

    def test_dns_rejects_nonroot_ownership_and_writable_parent_directories(self):
        self.setup_native()
        _, release = self.prepare(); spec = broker.read(release/'native.json')
        resolver = Path('/etc/resolv.conf').resolve()
        trusted_lstat = Path.lstat
        for offender, field, value in [(resolver, 4, 1), (resolver.parent, 4, 1),
                                      (resolver, 0, 0o100666), (resolver.parent, 0, 0o40777)]:
            def unsafe_lstat(path, *args, **kwargs):
                info = trusted_lstat(path, *args, **kwargs)
                if path == offender:
                    fields = list(info); fields[field] = value
                    return os.stat_result(fields)
                return info
            with self.subTest(path=str(offender), field=field), patch.object(Path, 'lstat', unsafe_lstat):
                with self.assertRaises(broker.policy.PolicyError) as error: self.settings(release, spec)
                self.assertEqual(error.exception.code, 'not_configured')

    def test_fixed_network_fails_closed_when_missing(self):
        self.setup_native(networkNamespacePath='/run/netns/t3-nonexistent-test', resolvConf='/etc/resolv.conf')
        _, release = self.prepare()
        with self.assertRaises(broker.policy.PolicyError): self.settings(release, broker.read(release/'native.json'))
        self.assertFalse(any('systemd-run' in str(call[0]) for call in self.calls))

    def test_freeze_keeps_built_dependencies_and_virtual_links_and_strips_modes(self):
        self.setup_native()
        source = self.root/'built'; source.mkdir()
        (source/'node_modules').mkdir(); (source/'node_modules/package.js').write_text('built dependency')
        (source/'bin').mkdir(); (source/'bin/tool').write_text('tool'); (source/'bin/tool').chmod(0o6777)
        (source/'python').symlink_to('/usr/bin/python3'); (source/'tool').symlink_to('/app/bin/tool')
        first = self.backend.freeze(source, self.root/'artifact1', allow_external=True)
        second = self.backend.freeze(source, self.root/'artifact2', allow_external=True)
        self.assertEqual(first, second)
        self.assertEqual((self.root/'artifact1/bin/tool').stat().st_mode & 0o7777, 0o755)
        self.assertEqual((self.root/'artifact1/node_modules/package.js').read_text(), 'built dependency')
        (source/'escape').symlink_to('/root/.ssh')
        with self.assertRaises(broker.policy.PolicyError): self.backend.freeze(source, self.root/'bad', allow_external=True)

    def test_special_files_are_rejected(self):
        self.setup_native()
        source = self.root/'built'; source.mkdir(); os.mkfifo(source/'pipe')
        with self.assertRaises(broker.policy.PolicyError): self.backend.freeze(source, self.root/'artifact')

    def test_build_freezes_output_and_discards_work_directory(self):
        self.setup_native()
        self.manifest['build'] = [['/usr/bin/printf', 'fixture']]
        _, release = self.prepare(); spec = broker.read(release/'native.json')
        def build(*args, **kwargs):
            (release/'build-work/dependency').write_text('generated')
            return OK
        with patch.object(native.os, 'chown'), patch.object(self.backend, 'transient', side_effect=build):
            self.backend.build(release, spec, release/'build.log')
        self.assertEqual((release/'artifact/dependency').read_text(), 'generated')
        self.assertFalse((release/'build-work').exists())
        self.assertRegex(broker.read(release/'release.json')['artifactDigest'], r'^[a-f0-9]{64}$')

    def run_worker(self, prepared, release, health=None, fail_stop=None):
        events = []
        def control(item, action, **kwargs):
            events.append((item.name, action))
            if action == 'stop' and item == fail_stop: raise broker.policy.PolicyError('start_failed', 'fixture stop failure')
            return OK
        def build(item, *args): (item/'artifact').mkdir(exist_ok=True)
        def check(item, *args):
            events.append((item.name, 'health'))
            if health: health(item)
        with patch.object(self.backend, 'control', side_effect=control), patch.object(self.backend, 'build', side_effect=build), patch.object(self.backend, 'install'), patch.object(self.backend, 'health', side_effect=check):
            self.backend.worker(release.parent.parent, prepared['operation']['id'])
        operation = broker.read(release.parent.parent/'operations'/prepared['operation']['id']/'operation.json')
        return events, operation

    def test_candidate_enabled_only_after_health_and_old_stopped_before_start(self):
        self.setup_native()
        first, old = self.prepare(); self.ready(first, old)
        second, release = self.prepare(applicationId=first['application']['id'])
        events, operation = self.run_worker(second, release)
        self.assertEqual(operation['stage'], 'succeeded')
        self.assertLess(events.index((old.name, 'stop')), events.index((release.name, 'start')))
        self.assertLess(events.index((release.name, 'health')), events.index((release.name, 'enable')))
        self.assertEqual(broker.read(release.parent.parent/'application.json')['currentReleaseId'], release.name)

    def test_failed_health_stops_candidate_then_restores_old(self):
        self.setup_native()
        first, old = self.prepare(); self.ready(first, old)
        second, release = self.prepare(applicationId=first['application']['id'])
        def health(item):
            if item == release: raise broker.policy.PolicyError('health_failed', 'fixture-private-token failed')
        events, operation = self.run_worker(second, release, health=health)
        self.assertEqual(operation['stage'], 'failed'); self.assertEqual(operation['recovery'], 'restored')
        self.assertLess(events.index((release.name, 'stop')), events.index((old.name, 'start')))
        self.assertNotIn((release.name, 'enable'), events)
        self.assertNotIn('fixture-private-token', json.dumps(operation))
        self.assertEqual(broker.read(release.parent.parent/'application.json')['currentReleaseId'], old.name)

    def test_cannot_stop_candidate_never_launches_duplicate_old_bot(self):
        self.setup_native()
        first, old = self.prepare(); self.ready(first, old)
        second, release = self.prepare(applicationId=first['application']['id'])
        def health(item): raise broker.policy.PolicyError('health_failed', 'fixture failed')
        events, operation = self.run_worker(second, release, health=health, fail_stop=release)
        self.assertEqual(operation['recovery'], 'failed')
        self.assertNotIn((old.name, 'start'), events)
        self.assertEqual(broker.read(release.parent.parent/'application.json')['state'], 'failed')

    def test_later_publish_cleans_up_an_unconfirmed_candidate_before_any_start(self):
        self.setup_native()
        first, old = self.prepare(); self.ready(first, old)
        second, pending = self.prepare(applicationId=first['application']['id'])
        def health(item): raise broker.policy.PolicyError('health_failed', 'fixture failed')
        self.run_worker(second, pending, health=health, fail_stop=pending)
        self.assertEqual(broker.read(old.parent.parent/'application.json')['pendingReleaseId'], pending.name)
        third, release = self.prepare(applicationId=first['application']['id'])
        events, operation = self.run_worker(third, release, fail_stop=pending)
        self.assertEqual(operation['recovery'], 'failed')
        self.assertFalse(any(action == 'start' for _, action in events))
        fourth, release = self.prepare(applicationId=first['application']['id'])
        events, operation = self.run_worker(fourth, release)
        self.assertEqual(operation['stage'], 'succeeded')
        self.assertLess(events.index((pending.name, 'stop')), events.index((release.name, 'start')))
        self.assertNotIn('pendingReleaseId', broker.read(old.parent.parent/'application.json'))

    def test_interrupted_first_publication_can_be_stopped_without_a_ready_release(self):
        self.setup_native()
        prepared, release = self.prepare()
        directory = release.parent.parent
        app = prepared['application']; app.update(pendingReleaseId=release.name, state='failed')
        broker.atomic(directory/'application.json', app)
        broker.operation_update(directory/'operations'/prepared['operation']['id']/'operation.json', 'failed')
        with patch.object(broker, 'start_worker'):
            result = broker.request('codex', 'control', {'roots': [str(self.workspace)], 'input': {'applicationId': app['id'], 'action': 'stop'}}, self.config)
        events, operation = self.run_worker(result, release)
        self.assertEqual(operation['stage'], 'succeeded')
        self.assertEqual(events, [(release.name, 'disable'), (release.name, 'stop')])
        self.assertEqual(broker.read(directory/'application.json')['state'], 'stopped')

    def test_stop_and_unpublish_preserve_data_and_release(self):
        self.setup_native()
        prepared, release = self.prepare(); self.ready(prepared, release)
        data = release.parent.parent/'data/native'; data.mkdir(parents=True); (data/'state').write_text('persistent')
        path = release.parent.parent/'operations'/prepared['operation']['id']/'operation.json'
        for action in ('stop', 'unpublish'):
            operation = broker.read(path); operation['action'] = action; broker.atomic(path, operation)
            events, result = self.run_worker(prepared, release)
            self.assertEqual(result['stage'], 'succeeded')
            self.assertEqual(events, [(release.name, 'disable'), (release.name, 'stop')])
            self.assertEqual((data/'state').read_text(), 'persistent'); self.assertTrue((release/'artifact').exists())

    def test_process_health_and_probe_failure_observe_actual_service(self):
        self.setup_native()
        _, release = self.prepare(); spec = broker.read(release/'native.json')
        running = ([{'state': 'active', 'subState': 'running', 'pid': 5}], True)
        with patch.object(self.backend, 'inspect', return_value=running): self.backend.health(release, spec, None)
        spec['healthcheck'].update(type='command', command=['/usr/bin/true'])
        with patch.object(self.backend, 'inspect', side_effect=[running, ([], True)]), patch.object(self.backend, 'transient', return_value=OK):
            with self.assertRaises(broker.policy.PolicyError): self.backend.health(release, spec, None)

    def test_logs_and_inspect_use_only_registered_unit_and_hide_bindings(self):
        self.setup_native()
        _, release = self.prepare()
        self.backend.logs(release, {'since': '2026-10-01'}, ['fixture-private-token'])
        argv, kwargs = self.calls[-1]
        self.assertIn('--unit='+self.backend.unit_name(release), argv)
        self.assertEqual(kwargs['limit'], 256*1024)
        self.assertEqual(kwargs['secrets'], ['fixture-private-token'])
        self.assertNotIn('fixture-private-token', json.dumps(self.backend.inspect_configuration(release)))

    def test_native_exec_cannot_use_cwd_prefix_alias(self):
        self.setup_native()
        prepared, release = self.prepare(); self.ready(prepared, release)
        with self.assertRaises(broker.policy.PolicyError):
            broker.request('codex', 'exec', {'roots': [str(self.workspace)], 'input': {'applicationId': prepared['application']['id'],
                           'component': 'service', 'argv': ['/usr/bin/true'], 'cwd': '/app-escape'}}, self.config)

    def test_systemd_runtime_timeout_reports_cancellation_and_cleans_up(self):
        self.setup_native()
        _, release = self.prepare(); spec = broker.read(release/'native.json')
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            if argv[0] == '/usr/bin/systemd-run': return {**OK, 'exitCode': 1}
            return {**OK, 'stdout': 'timeout\n'} if 'show' in argv else OK
        with patch.object(broker, 'run', side_effect=run):
            result = self.backend.transient(release, spec, ['/usr/bin/true'], kind='build', timeout=5)
        self.assertTrue(result['cancelled'])
        self.assertEqual(calls[-2][1], 'stop'); self.assertEqual(calls[-1][1], 'reset-failed')

    def test_unconfirmed_transient_cleanup_never_returns_build_success(self):
        self.setup_native()
        _, release = self.prepare(); spec = broker.read(release/'native.json')
        def failed_stop(argv, **kwargs):
            return {**OK, 'exitCode': 1} if 'stop' in argv else OK
        with patch.object(broker, 'run', side_effect=failed_stop), self.assertRaises(broker.policy.PolicyError):
            self.backend.transient(release, spec, ['/usr/bin/true'], kind='build', timeout=5)

    def test_native_historical_credentials_are_revalidated_before_worker_start(self):
        self.setup_native()
        prepared, release = self.prepare(); self.ready(prepared, release)
        request = {'roots': [str(self.workspace)], 'input': {'applicationId': prepared['application']['id'], 'action': 'start'}}
        with patch.object(broker, 'start_worker') as start, self.assertRaises(broker.policy.PolicyError) as error:
            broker.request('codex', 'control', {**request, 'values': {'BOT_KEY': 'rotated'}, 'versions': {'BOT_KEY': 2}}, self.config)
        self.assertEqual(error.exception.code, 'credential_expired'); start.assert_not_called()


class InstallationTests(unittest.TestCase):
    def test_host_preflight_rejects_old_systemd_without_starting_a_probe(self):
        spec = importlib.util.spec_from_file_location('resource_installer', Path(__file__).with_name('install_resource_management.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(stdout='systemd 256')) as run:
            with self.assertRaises(ValueError): module.verify_native_host(SimpleNamespace(pw_uid=1000, pw_gid=1000))
        self.assertEqual(run.call_count, 1)

    def test_host_preflight_requires_actual_namespace_and_bind_enforcement(self):
        spec = importlib.util.spec_from_file_location('resource_installer', Path(__file__).with_name('install_resource_management.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(stdout='systemd 259')) as run, patch.object(module.Path, 'read_text', return_value='cpu memory pids'), patch.object(module.Path, 'exists', return_value=True):
            module.verify_native_host(SimpleNamespace(pw_uid=1000, pw_gid=1000))
        argv = run.call_args.args[0]
        self.assertIn('--property=PrivatePIDs=yes', argv)
        self.assertIn('--property=PrivateNetwork=yes', argv)
        self.assertIn('--property=SocketBindDeny=any', argv)
        self.assertIn('--property=User=1000', argv)
        self.assertIn('PrivatePIDs is not enforced', argv[-2])
        self.assertIn('SocketBindDeny is not enforced', argv[-2])


class BuildKitTests(unittest.TestCase):
    setUp = base.ApplicationTests.setUp
    tearDown = base.ApplicationTests.tearDown

    def test_limits_are_verified_on_buildkit_container_before_compose_build(self):
        prepared = base.ApplicationTests.prepare(self)
        release = broker.app_dir(prepared['application']['id'])/'releases'/prepared['release']['id']
        broker.atomic(release/'compose.json', {'services': {'bot': {'build': {'context': str(release/'source')}}}})
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            if argv[1:3] == ['buildx', 'inspect'] and '--bootstrap' not in argv: return {**OK, 'exitCode': 1}
            if argv[1] == 'inspect': return {**OK, 'stdout': json.dumps({'Memory': 2048*1024*1024, 'MemorySwap': 2048*1024*1024, 'CpuPeriod': 100000, 'CpuQuota': 100000, 'PidsLimit': 256})}
            return OK
        with patch.object(broker, 'run', side_effect=run): broker.build_compose(release, self.config, None, [])
        build = next(argv for argv in calls if 'compose' in argv and 'build' in argv)
        self.assertIn('--builder', build)
        update = next(argv for argv in calls if argv[1] == 'update')
        self.assertIn('--pids-limit', update); self.assertLess(calls.index(update), calls.index(build))
        self.assertEqual(calls[-1][1:3], ['buildx', 'stop'])

    declaration = base.ApplicationTests.declaration

    def test_default_driver_and_mismatched_memory_fail_closed(self):
        broker.STATE.mkdir()
        name = 't3-app-build-'+'a'*32
        broker.atomic(broker.STATE/'buildkit.json', {'name': name, 'limits': native.DEFAULT_BUILD})
        for driver in ('docker', 'docker-container'):
            def run(argv, **kwargs):
                if argv[1] == 'inspect': return {**OK, 'stdout': '{}'}
                return {**OK, 'stdout': 'Name: '+name+'\nDriver: '+driver+'\n'}
            with self.subTest(driver=driver), patch.object(broker, 'run', side_effect=run), self.assertRaises(broker.policy.PolicyError): broker.ensure_builder(self.config)

    def test_invalid_record_never_controls_an_unrelated_builder(self):
        broker.atomic(broker.STATE/'buildkit.json', {'name': 'default', 'limits': {}})
        with patch.object(broker, 'run') as run, self.assertRaises(broker.policy.PolicyError): broker.ensure_builder(self.config)
        run.assert_not_called()


if __name__ == '__main__': unittest.main()
