# Calorie Counter

A personal calorie counter and TDEE calculator, in the spirit of Lose It:
log food against a daily budget, track macros, log weigh-ins, and compute
your BMR/TDEE and calorie target from your stats and goal.

Everything is stored only in the browser on your device (`localStorage`) —
there's no account, no server-side database, and no data leaves your phone.

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
  to add calories back.
- **Food search** — a built-in database of 648 foods with an icon on each,
  including 300 named restaurant meals across 76 chains and cuisines:
  common whole foods and staples, Emirati and Gulf cooking (machboos, harees,
  thereed, luqaimat, karak, camel meat), Levantine and Arabic dishes
  (shawarma, manakish, fattoush, knafeh), South, East and Southeast Asian,
  Mexican, and chains found in the UAE. Values come from USDA FoodData
  Central plus published chain figures. There's also a "Search branded foods"
  lookup against [Open Food Facts](https://world.openfoodfacts.org) for
  packaged products. Anything you log from either is saved to My Foods so
  it's one tap away next time.
- **Eating out today** — from the Today tab, browse all 300 restaurant meals
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
- **Backup & restore** — export/import your data as a JSON file.

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
