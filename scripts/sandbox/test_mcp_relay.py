import argparse
import asyncio
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("relay", Path(__file__).with_name("t3code-mcp-relay.py"))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_private_socket_preserves_stream_and_half_close_across_both_endpoints(self):
        received = asyncio.get_running_loop().create_future()

        async def upstream(reader, writer):
            body = await reader.read()
            received.set_result(body)
            writer.write(b"HTTP/1.1 200 OK\r\n\r\ndata: ready\n\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        with tempfile.TemporaryDirectory() as directory:
            target = await asyncio.start_server(upstream, "127.0.0.1", 0)
            socket = str(Path(directory) / "mcp.sock")
            host = await relay.serve(argparse.Namespace(
                listen_unix=socket, listen_tcp=None, connect_unix=None,
                connect_tcp=target.sockets[0].getsockname()[1],
            ))
            namespace = await relay.serve(argparse.Namespace(
                listen_unix=None, listen_tcp=0, connect_unix=socket, connect_tcp=None,
            ))
            async with target, host, namespace:
                reader, writer = await asyncio.open_connection("127.0.0.1", namespace.sockets[0].getsockname()[1])
                request = b"POST /mcp HTTP/1.1\r\nAuthorization: Bearer fixture\r\n\r\n\x00" + b"x" * 150000
                writer.write(request)
                await writer.drain()
                writer.write_eof()
                self.assertEqual(await reader.read(), b"HTTP/1.1 200 OK\r\n\r\ndata: ready\n\n")
                self.assertEqual(await received, request)
                self.assertEqual(Path(socket).stat().st_mode & 0o777, 0o600)
                writer.close()
                await writer.wait_closed()


if __name__ == "__main__":
    unittest.main()
