#!/usr/bin/env python3
"""Check a Cloudflare token before the deploy uses it.

Wrangler's own failures for a mis-scoped token are opaque - you get an
authentication error naming an internal endpoint, not "your token cannot touch
D1". This probes each capability the deploy actually needs and says which
checkbox to go back and tick.

Runs on the GitHub runner, where api.cloudflare.com is reachable.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get('CF_API_BASE', 'https://api.cloudflare.com/client/v4')
# Defense in depth: the workflow already strips whitespace before this runs,
# but this script gets invoked from a plain terminal too (see api/README.md),
# where a pasted value carries the same risk.
TOKEN = os.environ.get('CLOUDFLARE_API_TOKEN', '').strip()
ACCOUNT = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '').strip()
WANT_PHOTOS = '--photos' in sys.argv


def get(path):
    """Returns (status, parsed_body_or_None)."""
    req = urllib.request.Request(
        BASE + path,
        headers={'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/json'}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as err:
        body = None
        try:
            body = json.loads(err.read() or b'{}')
        except ValueError:
            pass
        return err.code, body
    except Exception as err:  # network, DNS, TLS
        print(f'::error::Could not reach the Cloudflare API: {err}')
        sys.exit(1)


problems = []


def check(label, path, remedy, optional=False):
    status, body = get(path)
    if status == 200 and (body is None or body.get('success', True)):
        print(f'  ok       {label}')
        return True
    if status in (401, 403):
        print(f'  MISSING  {label}')
        problems.append(remedy)
        return False
    # Something else went wrong - surface it rather than blaming permissions.
    detail = ''
    if isinstance(body, dict):
        errors = body.get('errors') or []
        if errors:
            detail = ' — ' + '; '.join(str(e.get('message', e)) for e in errors)
    print(f'  ERROR    {label} (HTTP {status}{detail})')
    problems.append(f'{label} returned HTTP {status}{detail}')
    return False


print('Checking your Cloudflare token and account...')

if not TOKEN:
    print('::error::CLOUDFLARE_API_TOKEN is empty.')
    sys.exit(1)
if not ACCOUNT:
    print('::error::CLOUDFLARE_ACCOUNT_ID is empty.')
    sys.exit(1)

status, body = get('/user/tokens/verify')
if status in (401, 403):
    print('::error::That API token was rejected by Cloudflare. It may be mistyped, '
          'revoked, or copied with whitespace. Create a fresh one and update the '
          'CLOUDFLARE_API_TOKEN secret.')
    sys.exit(1)
if status != 200:
    print(f'::error::Cloudflare would not verify the token (HTTP {status}).')
    sys.exit(1)
print('  ok       the token itself is valid and active')

status, _ = get(f'/accounts/{ACCOUNT}')
if status == 404:
    print(f'::error::No account with id {ACCOUNT}. Copy the Account ID out of the '
          'dashboard URL: dash.cloudflare.com/<account-id>/... and update the '
          'CLOUDFLARE_ACCOUNT_ID secret.')
    sys.exit(1)
if status in (401, 403):
    print(f'::error::The token is valid but cannot see account {ACCOUNT}. When you '
          'created it, "Account Resources" needs to include this account.')
    sys.exit(1)
print('  ok       the account id resolves and the token can see it')

check('D1 access (Account · D1 · Edit)',
      f'/accounts/{ACCOUNT}/d1/database',
      'Add "Account · D1 · Edit" to the token.')

check('Workers access (Account · Workers Scripts · Edit)',
      f'/accounts/{ACCOUNT}/workers/scripts',
      'Add "Account · Workers Scripts · Edit" to the token.')

if WANT_PHOTOS:
    check('R2 access (Account · Workers R2 Storage · Edit)',
          f'/accounts/{ACCOUNT}/r2/buckets',
          'Add "Account · Workers R2 Storage · Edit" to the token, and make sure R2 '
          'is enabled on the account (Cloudflare asks for a payment method once, '
          'even for the free tier). Or re-run with the photos box unticked.')

if problems:
    print()
    print('::error::The token is missing something. Edit it at Cloudflare -> My Profile '
          '-> API Tokens, then re-run this workflow.')
    for item in problems:
        print(f'::error::{item}')
    sys.exit(1)

print()
print('Everything the deploy needs is present.')
