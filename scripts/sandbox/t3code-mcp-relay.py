#!/usr/bin/python3 -I
"""Relay a namespace's loopback MCP port through a private host Unix socket.

Run one endpoint as the T3 owner on the host, and the other as that owner in
the existing network namespace. No route, interface or egress rule changes.
T3 still authenticates every request with its provider-scoped bearer.
"""

import argparse
import asyncio
import os
from pathlib import Path
import signal


async def forward(reader, writer):
    while data := await reader.read(65536):
        writer.write(data)
        await writer.drain()
    if writer.can_write_eof():
        writer.write_eof()


async def connection(reader, writer, connect):
    upstream = None
    try:
        remote_reader, upstream = await connect()
        await asyncio.gather(forward(reader, upstream), forward(remote_reader, writer))
    except (OSError, ConnectionError):
        # Do not log headers, bodies or bearer credentials.
        pass
    finally:
        for stream in (writer, upstream):
            if stream:
                stream.close()
                try:
                    await stream.wait_closed()
                except (OSError, ConnectionError):
                    pass


async def serve(args):
    if args.listen_unix:
        socket = Path(args.listen_unix)
        if socket.exists():
            raise ValueError("Relay socket already exists")
        connect = lambda: asyncio.open_connection("127.0.0.1", args.connect_tcp)
        server = await asyncio.start_unix_server(
            lambda reader, writer: connection(reader, writer, connect), path=str(socket),
        )
        socket.chmod(0o600)
    else:
        connect = lambda: asyncio.open_unix_connection(args.connect_unix)
        server = await asyncio.start_server(
            lambda reader, writer: connection(reader, writer, connect),
            host="127.0.0.1", port=args.listen_tcp,
        )
    return server


async def main(args):
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    server = await serve(args)
    try:
        async with server:
            await stop.wait()
    finally:
        if args.listen_unix:
            Path(args.listen_unix).unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    listen = parser.add_mutually_exclusive_group(required=True)
    listen.add_argument("--listen-unix")
    listen.add_argument("--listen-tcp", type=int)
    connect = parser.add_mutually_exclusive_group(required=True)
    connect.add_argument("--connect-unix")
    connect.add_argument("--connect-tcp", type=int)
    args = parser.parse_args()
    if bool(args.listen_unix) != bool(args.connect_tcp):
        parser.error("Use Unix-to-loopback or loopback-to-Unix endpoints")
    for path in (args.listen_unix, args.connect_unix):
        if path and not Path(path).is_absolute():
            parser.error("Unix socket paths must be absolute")
    os.umask(0o077)
    asyncio.run(main(args))
