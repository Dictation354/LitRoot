import os, sys, time
from pathlib import Path
from unittest.mock import patch
source = Path(os.environ['LITROOT_PAPER_FETCH_SOURCE']).resolve()
sys.path[:0] = [str(source / 'src'), str(source)]
from paper_fetch import cli
from paper_fetch.tracing import trace_event
from paper_fetch.providers.base import ProviderFailure
from paper_fetch.failure import FailureDiagnostics
from paper_fetch.quality.assets import build_asset_quality_summary
from tests.support.workflow_acceptance import _envelope

def fetch(*args, **kwargs):
    query = str(kwargs.get('query', args[0] if args else ''))
    if 'rate' in query:
        raise ProviderFailure('rate_limited', 'Slow down.', retry_after_seconds=7)
    if 'auth' in query:
        raise ProviderFailure('auth_required', 'Manual authentication required.', diagnostics=FailureDiagnostics(provider='wiley', route='browser_html', stage='fulltext'))
    if 'runtime_failure' in query:
        raise ProviderFailure('browser_context_create_failed', 'Camoufox context failed.', trace=[trace_event('runtime_prepare', 'wiley_html', 'fail', code='browser_context_create_failed')])
    if 'slow' in query:
        time.sleep(1)
    env = _envelope('abstract_only' if 'limited' in query else 'fulltext', trace=[trace_event('fulltext', 'wiley_html', 'fail', code='browser_runtime_prepare_timeout', message='Camoufox preparation timed out.'), trace_event('fulltext', 'wiley_pdf_fallback', 'ok')] if 'degraded' in query else None)
    env.quality.asset_summary = build_asset_quality_summary([], asset_profile='body', archive_enabled=True)
    env.quality.asset_summary.expected = 0
    env.article.quality.asset_summary = env.quality.asset_summary
    if query.startswith('10.'):
        env.doi = query
        env.article.doi = query
        env.article.metadata.title = query.replace("/", " ")
    env.markdown = env.article.to_ai_markdown()
    return env

with patch.object(cli, 'build_runtime_env', return_value={}), patch.object(cli, 'fetch_paper', side_effect=fetch):
    raise SystemExit(cli.main(sys.argv[1:]))
