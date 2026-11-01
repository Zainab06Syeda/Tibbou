"""Loopback HTTP evidence only: no Supabase credentials or hosted calls."""

import asyncio
import json
import statistics
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.auth_identity import AuthUnavailable, create_auth_client, fetch_auth_user


class AuthHttpTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                time.sleep(self.server.delay)
                body = json.dumps({"id": "offline-user", "identities": []}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass  # The timeout test deliberately cancels its connection.

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.delay = 0
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.issuer = f"http://127.0.0.1:{self.server.server_port}/auth/v1"

    async def asyncSetUp(self):
        self.client = create_auth_client()

    async def asyncTearDown(self):
        await self.client.aclose()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    async def lookup(self):
        start = time.perf_counter()
        await fetch_auth_user(self.issuer, "sb_publishable_offline", "offline-token", self.client)
        return (time.perf_counter() - start) * 1000

    async def test_loopback_latency_serial_and_concurrent(self):
        serial = [await self.lookup() for _ in range(20)]
        concurrent = await asyncio.gather(*(self.lookup() for _ in range(5)))
        self.server.delay = 0.1
        delayed = await self.lookup()
        p95 = sorted(serial)[18]
        print(
            f"Loopback HTTP only: serial n=20 p50={statistics.median(serial):.1f}ms "
            f"p95={p95:.1f}ms; concurrent n=5 max={max(concurrent):.1f}ms; "
            f"100ms server delay={delayed:.1f}ms. Not hosted/TLS performance."
        )

    async def test_real_http_stall_hits_five_second_deadline(self):
        self.server.delay = 6
        start = time.perf_counter()
        with self.assertRaises(AuthUnavailable):
            await self.lookup()
        elapsed = time.perf_counter() - start
        print(f"Loopback stalled HTTP request cancelled after {elapsed:.2f}s (5s deadline).")
        self.assertGreaterEqual(elapsed, 4.5)
        self.assertLess(elapsed, 5.75)
