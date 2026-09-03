# Group board API

A Cloudflare Worker plus a D1 database. It holds one row per person per day and
a short feed of things worth looking at. It does not hold anyone's food diary —
that stays on each phone, as it always has. What gets shared is a summary:
calories eaten against budget, macros, and how many items were logged.

## Deploying it

You need a free Cloudflare account. There are two ways in.

### From a phone (or any browser) — no terminal

Use the **Deploy group server** GitHub Action. It creates the database, applies
the schema and publishes the Worker on a GitHub runner, then prints the address
to paste into the app. Setup is two secrets, added once:

1. Cloudflare dashboard → profile menu → **My Profile → API Tokens → Create
   Token → Create Custom Token**. Give it:
   - Account · **Workers Scripts** · Edit
   - Account · **D1** · Edit
   - Account · **Workers R2 Storage** · Edit — only if you want photos
2. Copy your **Account ID**: it is the hex string in the dashboard URL,
   `dash.cloudflare.com/<account-id>/...`
3. In this repo: **Settings → Secrets and variables → Actions → New repository
   secret**, twice — `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. **Actions → Deploy group server → Run workflow.** Tick the photos box if you
   want them.

The run summary shows the URL. Re-running is safe: it reuses the database it
already made and the schema is written with `IF NOT EXISTS`.

### From a terminal

```
npm run api:setup     # creates the D1 database and applies the schema
npm run api:deploy    # publishes the Worker, prints its URL
```

`api:setup` opens a browser once to log in to Cloudflare. It prints the
`database_id` it created; paste that into `api/wrangler.toml` if the script did
not manage to write it for you, then run `api:deploy`.

Take the URL that `api:deploy` prints (it looks like
`https://calorie-counter-groups.<your-subdomain>.workers.dev`) and paste it into
the app under **Goals → Friends → Server**. Your friends paste the same URL and
then the group's join code.

## What it costs

Nothing, at the size this is built for. A group of ten writing all day stays
inside Cloudflare's free allowances by a wide margin, because a day's numbers
are one row that gets overwritten rather than a row per meal. The Workers free
plan covers 100,000 requests a day; a ten-person group doing this all day uses
a few thousand.

## Photos

Photos are off until you bind an R2 bucket, because R2 asks for a payment method
on the account even for its free tier and the board is useful without it. To
turn them on:

```
npx wrangler r2 bucket create calorie-counter-photos
```

then uncomment the `[[r2_buckets]]` block in `wrangler.toml` and redeploy. The
app notices `photosEnabled` from the server and shows or hides the share button
to match, so nothing breaks either way.

R2's free tier is 10 GB. Photos are downscaled to 900px and recompressed before
they leave the phone: a 12 MB source measured 84 KB on the way out, and that was
random noise, which compresses far worse than a photograph. Ten gigabytes is
therefore on the order of a hundred thousand photos. If you would rather they
expire, add a lifecycle rule on the bucket in the Cloudflare dashboard; feed
rows delete themselves after 90 days regardless.

## How access works

There are no passwords. Creating a group returns a join code; anyone with the
code and the server URL can join it and see everything in it, and members get a
random token that authenticates them from then on.

That is a deliberate trade for a group of friends — nobody has to make an
account — but be clear-eyed about it: the join code is the only thing standing
between your group and whoever it gets forwarded to. Share it the way you would
share a house key, and do not put anything in the feed you would mind a
friend-of-a-friend seeing.
