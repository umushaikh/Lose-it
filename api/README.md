# Group board API

A Cloudflare Worker plus a D1 database. It holds one row per person per day
(a summary — calories eaten against budget, macros, how many items were
logged — plus the actual foods behind it, item by item, for that member's
profile) and a short feed of things worth looking at. Both the summary and
the item list are overwritten in place as someone logs, not appended to, so
the database stays one row per person per day regardless of how often they
log.

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
therefore on the order of a hundred thousand photos.

## Billing safety

Of the three services this uses, only R2 can actually charge you. Workers and
D1 stay on Cloudflare's free plan, which simply rejects requests once you're
over its limits rather than billing anything - reaching that limit would take
far more traffic than a group of friends ever produces. R2 is different
because Cloudflare requires a card on file to turn it on at all, and genuinely
bills for usage past its free tier.

Two things guard against that, enforced by the server itself rather than left
to Cloudflare's own after-the-fact usage alerts:

- **A hard storage ceiling.** The server tracks the total bytes it has ever
  written to R2 and refuses new uploads once that total would cross
  `PHOTO_STORAGE_CEILING_MB` (2048 by default - 2 GiB, tens of thousands of
  photos, deliberately far under the 10 GB free amount rather than sitting
  right at the edge of it). A rejected upload gets a clear "storage limit
  reached" message rather than a confusing error.
- **A kill switch.** Setting `PHOTOS_PAUSED = "true"` - in `wrangler.toml`, or
  directly in the Worker's dashboard under Settings → Variables, which takes
  effect immediately with no redeploy - stops all photo uploads at once. Use
  it if usage ever looks wrong and you want it stopped before you've had time
  to look into why.

Feed rows older than 90 days delete themselves automatically, and now their R2
photos go with them - not just the row, so storage stays bounded over time
instead of quietly growing forever underneath a feed that looks like it's
being cleaned up. (One narrow gap: a photo that gets uploaded but never
successfully attached to a feed post - e.g. the app closing between those two
requests - has no event to expire it later. This is rare and bounded by the
2 MB per-photo cap, so not worth the added complexity of a separate sweep for
now.) If you'd rather storage expire on Cloudflare's side too, add a lifecycle
rule to the bucket in the dashboard as a second layer.

## How access works

There are no passwords. Creating a group returns a join code; anyone with the
code and the server URL can join it and see everything in it, and members get a
random token that authenticates them from then on.

That is a deliberate trade for a group of friends — nobody has to make an
account — but be clear-eyed about it: the join code is the only thing standing
between your group and whoever it gets forwarded to. Share it the way you would
share a house key. Since every member's profile shows what they've actually
logged today, not just a summary, that trade now covers your food diary too —
do not put anyone in a group you would mind seeing what you ate.
