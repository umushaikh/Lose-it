# Calorie Counter

A personal calorie counter and TDEE calculator, in the spirit of Lose It:
log food against a daily budget, track macros, log weigh-ins, and compute
your BMR/TDEE and calorie target from your stats and goal.

Everything is stored in the browser on your device (`localStorage`) — no
account, and by default no data leaves your phone. The one exception is opt-in:
if you join a group of friends (see **Friends**), your daily summary and your
actual food diary — what you've logged today, meal by meal — are both visible
to that group automatically, on your profile, along with a picture and a short
bio you can set. Nothing leaves your phone unless you join a group.

## Features

- **TDEE / calorie calculator** — enter sex, age, height, weight, and
  activity level to get your BMR, maintenance TDEE, and a daily calorie
  budget for losing, maintaining, or gaining weight at a chosen rate.
  Uses the Mifflin-St Jeor equation and the same six-level activity scale
  as calculator.net, so the numbers line up with it. You can also enter a
  custom daily calorie target to override the calculated budget entirely.
  Includes protein/carb/fat targets from an adjustable macro split.
- **Food diary** — log meals (breakfast/lunch/dinner/snacks) for any day,
  see calories and macros remaining against your budget, and log exercise
  to add calories back. Each meal shows a running total of protein, carbs,
  fat, fiber, sugar and sodium for what's logged in it so far.
- **Fuller nutrition** — protein, carbs and fat, plus fiber, sugar and
  sodium, on every food you log, save, or build into a recipe. Branded
  lookups pull the real figures from Open Food Facts; the built-in database
  and restaurant meals use close estimates the same way their calories and
  macros always have.
- **Food search** — a built-in database of 720 foods with an icon on each,
  including 352 named restaurant meals across 77 chains and cuisines, all
  of them actually operating in the UAE: common whole foods and staples,
  Emirati and Gulf cooking (machboos, harees, thereed, luqaimat, karak, camel
  meat), Levantine and Arabic dishes (shawarma, manakish, fattoush, knafeh),
  South, East and Southeast Asian, Mexican, and the fast-food chains found
  here, including a genuinely complete core McDonald's menu (burgers,
  chicken, breakfast, sides, McCafé, desserts) and a full rundown of
  Wendy's. Also 20 built-in low-calorie, high-protein recipes (grilled
  chicken & broccoli bowl, turkey chili, baked salmon & asparagus, and the
  like) for whenever you want something that isn't a restaurant meal or a
  raw ingredient. Values come from USDA FoodData Central plus published
  chain figures. There's also a "Search branded foods" lookup against
  [Open Food Facts](https://world.openfoodfacts.org) for packaged products.
  Anything you log from either is saved to My Foods so it's one tap away
  next time.
- **Eating out today** — from the Today tab, browse all 352 restaurant meals
  against the calories you have left. Everything is listed: what fits comes
  first (highest protein per calorie), and anything over budget follows in
  red, marked with how far over it is, still loggable if you want it. Filter
  by restaurant with the brand chips or search by dish or chain. Tap one to
  set the portion and log it. Chain figures are published values where the
  chain publishes them and close estimates otherwise; Gulf menus differ from
  Western ones, so regional items use GCC figures. Close, not exact.
- **Barcode scanning** — point the camera at a packaged product's barcode and
  it's looked up in Open Food Facts. Uses the browser's native barcode
  detector where available (Chrome/Android) and falls back to ZXing
  elsewhere; there's always a manual box for typing the number.
- **Photo estimates** (optional) — photograph a meal and get an estimated
  name, calories and macros to review before logging. This needs your own
  Anthropic API key, entered under Goals; it's stored on your device only,
  kept out of backups, and costs roughly a penny a photo on your account.
  Portion size is genuinely hard to judge from a photo, so treat the numbers
  as a starting point and correct them on the confirm screen.
- **Recipes** — build a recipe from its ingredients, say how many servings it
  makes, and it logs by the serving like any other food.
- **My Foods** — save your own foods with calories and macros per serving,
  then log them with a quantity/serving multiplier, or quick-add a one-off
  item without saving it.
- **Weight tracking** — log weigh-ins, see your trend chart and progress
  toward a goal weight.
- **Friends** — an optional shared board. Everyone in a group sees how each
  person's day is going against their own budget, who has room left and who is
  over, plus a feed of shared meal photos and weigh-ins. It needs a server, and
  there's a free one included: `npm run api:setup && npm run api:deploy` puts a
  Cloudflare Worker and a D1 database on your own Cloudflare account, which
  costs nothing at this size. See `api/README.md`. Without it the app behaves
  exactly as it always has.
  - **Profiles** — tap anyone in the group, including yourself, for their
    profile: a picture (pick any emoji, or leave it and your initials are
    used), a short bio you can set for yourself, and every meal they've
    logged today, item by item with full nutrition, each with its own
    "+ Add to my diary" (and one for the whole meal at once). This is
    automatic — it needs no tap from them, and it is the biggest privacy
    step in Friends: everywhere else only totals and whatever you
    deliberately post leave your phone, but a profile shows the actual
    foods behind those totals, live, to everyone in the group, for whatever
    date the Friends tab is showing (today by default, same as the rest of
    the board).
  - **Share a meal, or just one item** — the share icon (↗) next to a meal's
    + button posts that whole breakfast/lunch/dinner/snacks to the group
    *feed* (as opposed to a profile, which is looked up): every item in it,
    with full nutrition, plus the total. The same icon next to a single
    logged item shares just that one instead. Either way, anyone in the
    group can tap the post to add it to their own diary in one go. Useful
    for calling attention to something specific in the feed's timeline;
    profiles already show all of it either way.
- **Backup & restore** — export/import your data as a JSON file. API keys and
  group credentials are deliberately left out of the file.
- **Dark by default** — an OLED-black theme with rounded cards, an open-bottom
  calorie gauge that turns red once you're over, and per-meal calorie
  suggestions (20% breakfast / 25% lunch / 35% dinner / 20% snacks). Under
  Goals → Appearance you can switch to Light or have it follow your phone.

## Running it

```
npm install
npm start
```

Then open `http://localhost:3600` on this machine, or the printed network
address on your phone (same WiFi). Over plain HTTP, browsers disable
offline mode and home-screen install — for the full installable app,
serve it over HTTPS instead (see below).

## Installing it on your phone

This is a Progressive Web App: no app store needed.

1. Deploy `public/` somewhere served over HTTPS. The included GitHub Actions
   workflow (`.github/workflows/deploy-pages.yml`) publishes it to GitHub
   Pages automatically on every push — enable Pages for this repo once
   (Settings → Pages → Source: GitHub Actions) and it takes care of the rest.
2. Open the HTTPS URL on your phone.
3. iOS Safari: Share → Add to Home Screen. Android Chrome: menu → Install app
   (or "Add to Home Screen").

It then runs full-screen like a native app and works offline.

## Sharing it with friends

The app is useful on its own with no server at all, and that stays the default.
If you want a shared board, one person deploys the included Worker once — to
their own free Cloudflare account.

No terminal needed: add two Cloudflare secrets to this repo and run the
**Deploy group server** action from github.com, which works fine from a phone.
`api/README.md` has the steps. From a terminal it is instead:

```
npm run api:setup     # creates the D1 database on your Cloudflare account
npm run api:deploy    # publishes the Worker and prints its URL
```

Then in the app: **Friends → paste the URL → Start a new group**. It hands back
a six-character join code. Everyone else installs the app, opens Friends, and
enters the same URL plus that code.

What gets shared is a day's summary — calories eaten against budget, macros,
how many items were logged — and, on each person's profile, the actual meals
behind those numbers: what they had for breakfast, lunch, dinner and snacks
today, item by item. Both update as people log, not once a day: each person's
day is a single row that gets overwritten (both the summary and the item
list), which is why logging all day costs no more than logging once. Writes
made offline are queued on the phone and delivered when there's a connection.

Photo sharing is off until you bind an R2 bucket; `api/README.md` covers that,
and what the join code does and does not protect. It also covers billing: R2 is
the only one of the three Cloudflare services this uses that can actually
charge you (Workers and D1 stay on the free plan and just reject over-quota
requests instead of billing), and the server enforces its own storage ceiling
and a manual pause switch rather than relying on Cloudflare to catch it after
the fact.

The app itself (this repo's `public/` folder) redeploys automatically on every
push, so it's always current. The group server does not — it only updates when
someone re-runs **Deploy group server**. If a Friends feature stops working
after an update, that's almost always why: run the deploy again.
