"""Verify the script client's observable HTTP protocol and authorization limits."""
import http.server
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest


class ResourceClientTests(unittest.TestCase):
    def test_client_initializes_calls_and_closes_only_its_own_session(self):
        calls = []
        class Api(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                message = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((message['method'], self.headers.get('Mcp-Session-Id'), self.headers.get('Authorization')))
                result = {'protocolVersion': '2025-06-18'} if message['method'] == 'initialize' else {'content': [{'type': 'text', 'text': json.dumps(message.get('params', {}).get('arguments', {}))}]}
                self.send_response(200 if 'id' in message else 202)
                self.send_header('Mcp-Session-Id', 'script-client-session')
                self.end_headers()
                if 'id' in message: self.wfile.write(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}).encode())
            def do_DELETE(self):
                calls.append(('DELETE', self.headers.get('Mcp-Session-Id'), self.headers.get('Authorization')))
                self.send_response(200); self.end_headers()
            def log_message(self, *_args): pass
        api = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Api)
        worker = threading.Thread(target=api.serve_forever, daemon=True); worker.start()
        try:
            with tempfile.TemporaryDirectory(prefix='t3-resource-client-') as root:
                context = Path(root) / 'context.json'
                data = {'endpoint': f'http://127.0.0.1:{api.server_port}/mcp/hosted/fixture', 'authorization': 'Bearer fixture-restricted-token', 'tools': ['identity'], 'expiresAt': time.time()*1000 + 60000}
                context.write_text(json.dumps(data)); context.chmod(0o600)
                command = [sys.executable, '-I', str(Path(__file__).with_name('t3-resource.py')), 'mcp', 'call', 'identity', '--context', str(context)]
                result = subprocess.run(command, input='{"batch":3}', text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('batch', result.stdout)
                self.assertNotIn('fixture-restricted-token', result.stdout + result.stderr)
                self.assertEqual([call[0] for call in calls], ['initialize', 'notifications/initialized', 'tools/call', 'DELETE'])
                self.assertIsNone(calls[0][1])
                self.assertTrue(all(call[1] == 'script-client-session' for call in calls[1:]))
                count = len(calls)
                command[5] = 'forbidden'
                rejected = subprocess.run(command, input='{}', text=True, capture_output=True, timeout=10)
                self.assertEqual(rejected.returncode, 1)
                self.assertIn('outside', rejected.stderr)
                self.assertEqual(len(calls), count)
                data['expiresAt'] = 0
                context.write_text(json.dumps(data))
                expired = subprocess.run(command, input='{}', text=True, capture_output=True, timeout=10)
                self.assertIn('expired', expired.stderr)
                self.assertEqual(len(calls), count)
        finally:
            api.shutdown(); api.server_close(); worker.join(timeout=5)


if __name__ == '__main__': unittest.main()
