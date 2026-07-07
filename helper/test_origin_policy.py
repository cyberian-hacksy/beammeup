"""Tests for the WebSocket origin trust policy.

Run from the repo root:
    python3 -m unittest discover -s helper -b
or from helper/:
    python3 -m unittest test_origin_policy -b
"""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from origin_policy import OriginPolicy, statically_allowed


ORIGIN = "https://cyberian-hacksy.github.io"


class StaticTierTests(unittest.TestCase):
    def test_missing_origin_allowed(self):
        self.assertTrue(statically_allowed(None))

    def test_file_null_origin_allowed(self):
        self.assertTrue(statically_allowed("null"))

    def test_localhost_allowed_with_and_without_port(self):
        self.assertTrue(statically_allowed("http://localhost:5173"))
        self.assertTrue(statically_allowed("http://localhost"))

    def test_loopback_ip_allowed(self):
        self.assertTrue(statically_allowed("http://127.0.0.1:8080"))

    def test_remote_https_origin_not_static(self):
        self.assertFalse(statically_allowed(ORIGIN))

    def test_localhost_prefix_spoof_rejected(self):
        self.assertFalse(statically_allowed("http://localhost.evil.com"))
        self.assertFalse(statically_allowed("http://127.0.0.1.evil.com"))

    def test_malformed_origin_rejected(self):
        self.assertFalse(statically_allowed("http://["))


def _never_prompt(origin):
    raise AssertionError(f"prompt should not have been called for {origin}")


class PolicyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.config_path = Path(self._tmp.name) / "arq-origins.json"

    def make_policy(self, prompt, **kwargs):
        return OriginPolicy(config_path=self.config_path, prompt=prompt, **kwargs)

    async def test_static_origins_never_prompt(self):
        policy = self.make_policy(_never_prompt)
        for origin in (None, "null", "http://localhost:5173", "http://127.0.0.1:8080"):
            self.assertTrue(await policy.allow(origin))

    async def test_persisted_origin_allows_without_prompt(self):
        self.config_path.write_text(json.dumps([ORIGIN]))
        policy = self.make_policy(_never_prompt)
        self.assertTrue(await policy.allow(ORIGIN))

    async def test_approval_persists_and_skips_future_prompts(self):
        calls = []

        async def prompt(origin):
            calls.append(origin)
            return True

        policy = self.make_policy(prompt)
        self.assertTrue(await policy.allow(ORIGIN))
        self.assertEqual(calls, [ORIGIN])
        self.assertEqual(json.loads(self.config_path.read_text()), [ORIGIN])

        # Same policy instance: no second prompt.
        self.assertTrue(await policy.allow(ORIGIN))
        self.assertEqual(calls, [ORIGIN])

        # Fresh instance reloads the persisted approval.
        fresh = self.make_policy(_never_prompt)
        self.assertTrue(await fresh.allow(ORIGIN))

    async def test_config_dir_created_on_first_approval(self):
        nested = Path(self._tmp.name) / "deep" / "nested" / "origins.json"

        async def prompt(origin):
            return True

        policy = OriginPolicy(config_path=nested, prompt=prompt)
        self.assertTrue(await policy.allow(ORIGIN))
        self.assertEqual(json.loads(nested.read_text()), [ORIGIN])

    async def test_denial_rejects_without_persisting(self):
        calls = []

        async def prompt(origin):
            calls.append(origin)
            return False

        policy = self.make_policy(prompt)
        self.assertFalse(await policy.allow(ORIGIN))
        self.assertFalse(self.config_path.exists())

        # A denied origin asks again on the next attempt.
        self.assertFalse(await policy.allow(ORIGIN))
        self.assertEqual(calls, [ORIGIN, ORIGIN])

    async def test_concurrent_same_origin_prompts_once(self):
        calls = []
        gate = asyncio.Event()

        async def prompt(origin):
            calls.append(origin)
            await gate.wait()
            return True

        policy = self.make_policy(prompt)
        tasks = [asyncio.create_task(policy.allow(ORIGIN)) for _ in range(3)]
        await asyncio.sleep(0.01)
        gate.set()
        self.assertEqual(await asyncio.gather(*tasks), [True, True, True])
        self.assertEqual(calls, [ORIGIN])

    async def test_different_origins_prompt_sequentially(self):
        active = 0
        max_active = 0

        async def prompt(origin):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0.02)
            active -= 1
            return False

        policy = self.make_policy(prompt)
        await asyncio.gather(
            policy.allow("https://a.example"),
            policy.allow("https://b.example"),
        )
        self.assertEqual(max_active, 1)

    async def test_prompt_timeout_denies_without_persisting(self):
        async def prompt(origin):
            await asyncio.sleep(5)
            return True

        policy = self.make_policy(prompt, timeout_s=0.05)
        self.assertFalse(await policy.allow(ORIGIN))
        self.assertFalse(self.config_path.exists())

    async def test_prompt_eof_denies(self):
        async def prompt(origin):
            raise EOFError

        policy = self.make_policy(prompt)
        self.assertFalse(await policy.allow(ORIGIN))

    async def test_corrupt_config_treated_as_empty(self):
        self.config_path.write_text("not json {")

        async def prompt(origin):
            return False

        policy = self.make_policy(prompt)
        self.assertFalse(await policy.allow(ORIGIN))
        self.assertTrue(await policy.allow("http://localhost:5173"))

    async def test_non_list_config_treated_as_empty(self):
        self.config_path.write_text(json.dumps({"origins": [ORIGIN]}))

        async def prompt(origin):
            return False

        policy = self.make_policy(prompt)
        self.assertFalse(await policy.allow(ORIGIN))


if __name__ == "__main__":
    unittest.main()
