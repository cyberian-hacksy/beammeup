"""Trust-on-first-use origin policy for the WebSocket bridge.

Browsers attach an unforgeable Origin header, so unknown web origins can be
trusted dynamically: the first connection from one triggers a y/N prompt in
the helper's terminal, and approval is persisted so each origin only ever
costs one keypress. Stdlib-only so it stays testable without the BLE deps.
"""

import asyncio
import json
from pathlib import Path
from urllib.parse import urlsplit

CONFIG_PATH = Path.home() / ".beammeup" / "arq-origins.json"
PROMPT_TIMEOUT_S = 60

LOCAL_HOSTNAMES = {"localhost", "127.0.0.1"}


def statically_allowed(origin):
    # Non-browser clients send no Origin; file:// pages (the single-file
    # build) send the literal "null". Hostnames are matched exactly so
    # http://localhost.evil.com does not ride in on a prefix.
    if origin is None or origin == "null":
        return True
    try:
        parts = urlsplit(origin)
    except ValueError:
        return False
    return parts.scheme == "http" and parts.hostname in LOCAL_HOSTNAMES


async def terminal_prompt(origin):
    question = f"Allow WebSocket connections from {origin}? [y/N] "
    try:
        answer = await asyncio.to_thread(input, question)
    except EOFError:
        return False
    return answer.strip().lower() in ("y", "yes")


class OriginPolicy:
    def __init__(self, config_path=CONFIG_PATH, prompt=terminal_prompt, timeout_s=PROMPT_TIMEOUT_S):
        self.config_path = Path(config_path)
        self.prompt = prompt
        self.timeout_s = timeout_s
        self.approved = self._load()
        self._pending = {}
        self._prompt_lock = asyncio.Lock()

    def _load(self):
        try:
            data = json.loads(self.config_path.read_text())
        except (OSError, ValueError):
            return set()
        if not isinstance(data, list):
            return set()
        return {origin for origin in data if isinstance(origin, str)}

    def _save(self):
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(json.dumps(sorted(self.approved), indent=2) + "\n")

    async def allow(self, origin):
        if statically_allowed(origin) or origin in self.approved:
            return True
        task = self._pending.get(origin)
        if task is None:
            task = asyncio.get_running_loop().create_task(self._decide(origin))
            self._pending[origin] = task
            task.add_done_callback(lambda _: self._pending.pop(origin, None))
        # Shield so one closing connection doesn't cancel a decision that
        # other connections from the same origin are still waiting on.
        return await asyncio.shield(task)

    async def _decide(self, origin):
        # One prompt at a time: concurrent input() threads would race on stdin.
        async with self._prompt_lock:
            try:
                approved = await asyncio.wait_for(self.prompt(origin), self.timeout_s)
            except (asyncio.TimeoutError, EOFError, OSError):
                return False
            if approved:
                self.approved.add(origin)
                self._save()
                print(f"approved origin {origin} (saved to {self.config_path})")
            return bool(approved)
