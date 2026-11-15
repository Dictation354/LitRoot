"""Real CLI/session/manifest execution with synthetic acquisition and no network.

LITROOT_PAPER_FETCH_SOURCE selects the checkout under test. File gates let the
parent test order cancellation against acquisition and terminal publication.
"""

import json
import os
from pathlib import Path
import socket
import struct
import sys
import threading
import time
import zlib
from unittest.mock import patch

source = Path(os.environ["LITROOT_PAPER_FETCH_SOURCE"]).resolve()
sys.path[:0] = [str(source / "src"), str(source)]

from paper_fetch import cli
from paper_fetch.models import Asset
from paper_fetch.providers.base import ProviderFailure
from paper_fetch.publisher_identity import extract_doi, normalize_doi
from paper_fetch.quality.assets import build_asset_quality_summary
from paper_fetch.tracing import trace_event
from tests.support.workflow_acceptance import _envelope

root = Path(os.environ["LITROOT_CONTRACT_ROOT"])
log_lock = threading.Lock()


def log(name, value):
    with log_lock, (root / name).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value) + "\n")


class CaptureStderr:
    def write(self, value):
        with log_lock, (root / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(value)
        return sys.__stderr__.write(value)

    def flush(self):
        sys.__stderr__.flush()

    def isatty(self):
        return False


def wait_gate(name, context=None):
    deadline = time.monotonic() + 12
    while not (root / name).exists():
        if context is not None:
            context.raise_if_cancelled()
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Test gate was not released: {name}")
        time.sleep(0.01)


def doi_for(query):
    return normalize_doi(extract_doi(query) or "10.5555/shared")


def resolve(query, **_kwargs):
    return {"doi": doi_for(query), "landing_url": "https://example.test/paper"}


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def fetch(query, *, context, **_kwargs):
    doi = doi_for(query)
    log("fetches.jsonl", {"query": query, "doi": doi})
    context.report_progress("stage", stage="fetching")
    if "gated" in doi:
        wait_gate("release-fetch", context)
    context.raise_if_cancelled()
    if "failure" in doi:
        raise ProviderFailure("browser_context_create_failed", "Synthetic browser failure")
    events = None
    if "degraded" in doi:
        events = [
            trace_event("fulltext", "wiley_html", "fail", code="browser_runtime_prepare_timeout"),
            trace_event("fulltext", "wiley_pdf_fallback", "ok"),
        ]
    assets = []
    if "asset" in doi:
        path = context.download_dir / "assets" / "figure.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(
            b"\x89PNG\r\n\x1a\n"
            + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 2, 0, 0, 0))
            + png_chunk(b"IDAT", zlib.compress((b"\x00" + b"\x00\x00\xff" * 32) * 32))
            + png_chunk(b"IEND", b"")
        )
        assets.append(Asset(kind="figure", heading="Fixture figure", url="https://example.test/figure.png", path=str(path)))
    env = _envelope("abstract_only" if "limited" in doi else "fulltext", assets=assets, trace=events)
    env.doi = env.article.doi = doi
    env.article.metadata.title = doi.replace("/", " ")
    env.quality.asset_summary = build_asset_quality_summary(assets, asset_profile="body", archive_enabled=True)
    env.quality.asset_summary.expected = len(assets)
    env.article.quality.asset_summary = env.quality.asset_summary
    env.markdown = env.article.to_ai_markdown()
    if assets:
        env.markdown += "\n![Fixture figure](https://example.test/figure.png)\n"
    context.report_progress("stage", stage="assets")
    context.report_progress("assets", scope="body", counts=[
        {"kind": "figure", "completed": len(assets), "total": len(assets), "failed": 0}
    ])
    context.report_progress("stage", stage="validating")
    return env


original_complete = cli.FetchProgress.complete
original_control = cli.FetchProgress.control


def complete(progress, index, build):
    if os.environ.get("LITROOT_CONTRACT_COMMIT_GATE") == "1":
        # Batch completion has not taken the lock; single completion's caller
        # already holds it across manifest construction and publication.
        (root / "before-terminal").touch()
        wait_gate("release-terminal")
    return original_complete(progress, index, build)


def control(progress, value):
    log("received-controls.jsonl", value)
    original_control(progress, value)
    log("controls.jsonl", value)


with (
    patch.object(cli, "build_runtime_env", return_value={}),
    patch.object(cli, "resolve_paper", side_effect=resolve),
    patch.object(cli, "fetch_paper", side_effect=fetch),
    patch.object(cli.FetchProgress, "complete", complete),
    patch.object(cli.FetchProgress, "control", control),
    patch.object(sys, "stderr", CaptureStderr()),
    patch.object(socket.socket, "connect", side_effect=AssertionError("Offline contract attempted network access")),
    patch.object(socket.socket, "connect_ex", side_effect=AssertionError("Offline contract attempted network access")),
):
    raise SystemExit(cli.main(sys.argv[1:]))
