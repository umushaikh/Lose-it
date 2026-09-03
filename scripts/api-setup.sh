#!/usr/bin/env bash
# Creates the D1 database for the group board, writes its id into
# api/wrangler.toml, and applies the schema. Safe to run more than once.
set -euo pipefail

cd "$(dirname "$0")/.."
DB_NAME="calorie-counter-groups"

echo "==> Logging in to Cloudflare (a browser window may open)"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

echo "==> Creating the D1 database (skipped if it already exists)"
CREATE_OUT="$(npx wrangler d1 create "$DB_NAME" 2>&1 || true)"
echo "$CREATE_OUT"

# Whether we just created it or it was already there, ask for the real id.
DB_ID="$(npx wrangler d1 info "$DB_NAME" 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"

if [ -z "$DB_ID" ]; then
  echo
  echo "Could not read the database id automatically."
  echo "Run 'npx wrangler d1 info $DB_NAME', copy the uuid, and paste it into"
  echo "api/wrangler.toml as database_id. Then run: npm run api:deploy"
  exit 1
fi

echo "==> Writing database_id $DB_ID into api/wrangler.toml"
python3 - "$DB_ID" <<'PY'
import re, sys
path = 'api/wrangler.toml'
text = open(path).read()
text = re.sub(r'database_id\s*=\s*"[^"]*"', 'database_id = "%s"' % sys.argv[1], text, count=1)
open(path, 'w').write(text)
PY

echo "==> Applying the schema"
npx wrangler d1 execute "$DB_NAME" --remote --file=api/schema.sql --config api/wrangler.toml -y

echo
echo "Done. Now run:  npm run api:deploy"
