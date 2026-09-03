#!/usr/bin/env python3
"""Read a D1 database's uuid out of `wrangler d1 list --json`.

Wrangler prints a banner (and, behind a proxy, a warning) before the JSON, and
that banner contains brackets of its own — so seeking to the first '[' finds
"[WARNING]", not the array. Try every '[' until one actually decodes.
"""
import json
import sys

want = sys.argv[1]
raw = sys.stdin.read()
decoder = json.JSONDecoder()

for i, ch in enumerate(raw):
    if ch != '[':
        continue
    try:
        data, _ = decoder.raw_decode(raw[i:])
    except ValueError:
        continue
    if not isinstance(data, list):
        continue
    for entry in data:
        if isinstance(entry, dict) and entry.get('name') == want:
            print(entry['uuid'])
            sys.exit(0)

sys.exit(f'No D1 database named {want} in the account')
