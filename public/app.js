// Replaced with the commit sha at deploy time, the same way the service worker
// is stamped. Shown in the backup sheet so the running version can be checked
// against what was last deployed.
const BUILD_ID = '__BUILD_ID__';

// `share` is the slice of the day's budget suggested for each meal, the same
// rough split Lose It shows (20/25/35/20).
const MEALS = [
  { key: 'breakfast', label: 'Breakfast', share: 0.20 },
  { key: 'lunch', label: 'Lunch', share: 0.25 },
  { key: 'dinner', label: 'Dinner', share: 0.35 },
  { key: 'snacks', label: 'Snacks', share: 0.20 }
];

// Everything the Friends tab knows between renders. Kept out of `state` so a
// failed board fetch can never take the rest of the app down with it.
const friends = {
  group: null,
  board: null,
  error: '',
  loading: false,
  pending: 0,
  pollTimer: null,
  lastPushed: new Map()
};

// Visible length of the budget gauge's arc: 270° of a circle with r=80.
const GAUGE_ARC = 2 * Math.PI * 80 * 0.75;

// Applies the chosen theme to the document and keeps the browser chrome
// (status bar tint on an installed PWA) in step with it.
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
  const dark = theme === 'dark'
    || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#000000' : '#f4f5f7');
}

// Multipliers and wording match calculator.net's TDEE calculator, which uses a
// six-level scale — note its "Moderate" is 1.465, not the 1.55 of the older
// five-level Harris-Benedict table.
const ACTIVITY_LEVELS = [
  { key: 'sedentary', label: 'Sedentary: little or no exercise', mult: 1.2 },
  { key: 'light', label: 'Light: exercise 1-3 times/week', mult: 1.375 },
  { key: 'moderate', label: 'Moderate: exercise 4-5 times/week', mult: 1.465 },
  { key: 'active', label: 'Active: daily exercise or intense exercise 3-4 times/week', mult: 1.55 },
  { key: 'veryActive', label: 'Very Active: intense exercise 6-7 times/week', mult: 1.725 },
  { key: 'extraActive', label: 'Extra Active: very intense exercise daily, or physical job', mult: 1.9 }
];

// 3500 kcal per lb of fat, spread over 7 days.
const CALORIES_PER_LB_PER_WEEK = 500;
const LB_PER_KG = 2.20462262;

const RATE_OPTIONS = {
  imperial: [0.5, 1, 1.5, 2].map(lb => ({ lb, label: `${lb} lb / week` })),
  metric: [0.25, 0.5, 0.75, 1].map(kg => ({ lb: kg * LB_PER_KG, label: `${kg} kg / week` }))
};

const state = {
  settings: null,
  foods: [],
  currentDate: todayStr(),
  diaryDay: null,
  mealSummaryOpen: {}, // { breakfast: true } while its macro line is expanded
  exerciseDay: [],
  weightLog: [],
  activeTab: 'today',
  foodSearch: '',
  foodEditing: null, // { id? } while the add/edit food sheet is open
  searchResults: [], // online (branded) hits merged into the picker
  visibleResults: [], // exactly what the picker last rendered, indexed by row
  visibleFoodRows: [], // same, for the Foods tab
  logFoodTarget: null, // food chosen from the Foods tab, awaiting meal + servings
  recipes: [],
  recipeDraft: null, // recipe being built in the editor
  recipePickerRows: [], // ingredient search results, indexed by row
  suggestRows: [], // eating-out list as rendered, indexed by row
  suggestBrand: 'all', // active restaurant filter
  suggestSearch: '',
  confirmFood: null, // scanned or photographed food awaiting confirmation
  pendingMeal: null, // meal the scan/photo was started from
  scanStream: null, // live camera stream while scanning (BarcodeDetector path)
  scanTimer: null,
  zxingReader: null, // ZXing owns its own stream when it is the decoder
  scanHandled: false, // guards ZXing's callback firing repeatedly on one code
  editingEntry: null // diary entry open in the edit sheet
};

// Tracks which units the settings form is currently displaying, independent of
// state.settings.units, so a unit toggle mid-edit converts the entered values
// instead of discarding them.
let formUnits = 'imperial';

if ('serviceWorker' in navigator) {
  // Whether a worker was already in charge when this page loaded. If one was,
  // a later handover means a new version has been deployed, so reload once to
  // show it. Guarded so a first-ever install doesn't reload, and so this can
  // never loop.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Dates are handled entirely in local time. Going through toISOString() here
// would format the UTC day, which is the previous or next calendar day for most
// of the world's timezones, so stepping through the diary would skip or stick.
function toDateStr(d) {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function todayStr() {
  return toDateStr(new Date());
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A stable background color per name, so the same person's initials avatar
// looks the same everywhere without any storage - just a hash of their name
// picking a hue.
function nameColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 55%, 38%)`;
}

// A member's picture, everywhere it's shown: their chosen avatar emoji if
// they've set one, otherwise their initials on a color derived from their
// name. Never needs a network request, so it renders instantly even before
// any photo infrastructure exists for this server.
function avatarHtml(member, size = 'small') {
  const name = member?.name || '?';
  const initials = name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const cls = `avatar-circle ${size === 'large' ? 'large' : 'small'}`;
  if (member?.avatar) {
    return `<span class="${cls} avatar-emoji">${escapeHtml(member.avatar)}</span>`;
  }
  return `<span class="${cls}" style="background:${nameColor(name)}">${escapeHtml(initials)}</span>`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (dateStr === todayStr()) return 'Today';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === toDateStr(yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

// ---- Unit conversions ----
const KG_PER_LB = 0.45359237;
const CM_PER_IN = 2.54;
const kgToLb = kg => kg / KG_PER_LB;
const lbToKg = lb => lb * KG_PER_LB;
const cmToIn = cm => cm / CM_PER_IN;
const inToCm = inches => inches * CM_PER_IN;

function displayWeight(kg, units) {
  return units === 'metric' ? Math.round(kg * 10) / 10 : Math.round(kgToLb(kg) * 10) / 10;
}
function weightUnitLabel(units) {
  return units === 'metric' ? 'kg' : 'lb';
}

// ---- TDEE / calorie math ----
function calcBMR({ sex, weightKg, heightCm, age }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(sex === 'male' ? base + 5 : base - 161);
}

function activityMultiplier(key) {
  const level = ACTIVITY_LEVELS.find(a => a.key === key);
  return level ? level.mult : 1.375;
}

function calcTDEE(bmr, activityKey) {
  return Math.round(bmr * activityMultiplier(activityKey));
}

function calcGoalCalories(tdee, goal, rateLbPerWeek) {
  const dailyAdjust = Math.round((Number(rateLbPerWeek) || 0) * CALORIES_PER_LB_PER_WEEK);
  if (goal === 'lose') return tdee - dailyAdjust;
  if (goal === 'gain') return tdee + dailyAdjust;
  return tdee;
}

// Rate choices read in whichever unit the form is set to, but are always stored
// as lb/week so the calorie math has a single basis.
function renderRateOptions(units, selectedLb) {
  const select = document.getElementById('settings-form').rate;
  const options = RATE_OPTIONS[units] || RATE_OPTIONS.imperial;
  select.innerHTML = options
    .map(o => `<option value="${o.lb.toFixed(4)}">${o.label}</option>`)
    .join('');
  const closest = options.reduce((best, o) =>
    Math.abs(o.lb - selectedLb) < Math.abs(best.lb - selectedLb) ? o : best, options[0]);
  select.value = closest.lb.toFixed(4);
}

function calcMacroGrams(calories, split) {
  return {
    proteinG: Math.round((calories * split.proteinPct / 100) / 4),
    carbsG: Math.round((calories * split.carbsPct / 100) / 4),
    fatG: Math.round((calories * split.fatPct / 100) / 9)
  };
}

function computeGoals(settings) {
  const bmr = calcBMR(settings);
  const tdee = calcTDEE(bmr, settings.activity);
  const rawGoal = calcGoalCalories(tdee, settings.goal, settings.rateLbPerWeek);
  const goalCalories = settings.calorieOverride != null ? settings.calorieOverride : Math.max(rawGoal, 0);
  const macros = calcMacroGrams(goalCalories, settings.macroSplit);
  return { bmr, tdee, rawGoal, goalCalories, macros };
}

// ---- Data loading ----
async function loadDayData() {
  const [diaryDay, exerciseDay] = await Promise.all([
    db.getDiaryDay(state.currentDate),
    db.getExerciseDay(state.currentDate)
  ]);
  state.diaryDay = diaryDay;
  state.exerciseDay = exerciseDay;
}

async function refreshAll() {
  state.settings = await db.getSettings();
  friends.group = await db.getGroup();
  state.foods = await db.getFoods();
  state.weightLog = await db.getWeightLog();
  state.recipes = await db.getRecipes();
  await loadDayData();
  render();
}

// ---- Rendering ----
function render() {
  applyTheme(state.settings.theme || 'dark');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${state.activeTab}`));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.activeTab));

  if (!state.settings.onboarded) {
    state.activeTab = 'settings';
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-settings'));
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'settings'));
    document.getElementById('onboarding-banner').classList.remove('hidden');
  } else {
    document.getElementById('onboarding-banner').classList.add('hidden');
  }

  renderToday();
  renderFriends();
  renderFoods();
  renderRecipes();
  renderWeight();
  populateSettingsForm();
}

// Sums one meal's logged items into a single macro line, scaled by qty like
// everywhere else nutrition gets totalled.
function sumMeal(items) {
  return items.reduce((acc, i) => {
    const t = scaleNutrition(i, i.qty);
    return {
      calories: acc.calories + t.calories,
      protein: acc.protein + t.protein,
      carbs: acc.carbs + t.carbs,
      fat: acc.fat + t.fat,
      fiber: acc.fiber + t.fiber,
      sugar: acc.sugar + t.sugar,
      sodium: acc.sodium + t.sodium
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 });
}

function sumDay(diaryDay) {
  let calories = 0, protein = 0, carbs = 0, fat = 0;
  MEALS.forEach(m => {
    diaryDay[m.key].forEach(item => {
      calories += item.calories * item.qty;
      protein += item.protein * item.qty;
      carbs += item.carbs * item.qty;
      fat += item.fat * item.qty;
    });
  });
  return { calories: Math.round(calories), protein: Math.round(protein), carbs: Math.round(carbs), fat: Math.round(fat) };
}

function renderToday() {
  document.getElementById('diary-date-label').textContent = formatDate(state.currentDate);
  document.getElementById('diary-next-btn').disabled = state.currentDate === todayStr();

  const goals = computeGoals(state.settings);
  const eaten = sumDay(state.diaryDay);
  const exerciseCal = state.exerciseDay.reduce((s, e) => s + e.calories, 0);
  const remaining = goals.goalCalories - eaten.calories + exerciseCal;

  document.getElementById('budget-goal').textContent = goals.goalCalories.toLocaleString();
  document.getElementById('budget-food').textContent = eaten.calories.toLocaleString();
  document.getElementById('budget-exercise').textContent = exerciseCal.toLocaleString();
  document.getElementById('budget-remaining').textContent = remaining.toLocaleString();
  document.getElementById('budget-remaining').classList.toggle('negative', remaining < 0);

  // The gauge is a 270° arc of a circle with r=80, so its full sweep is
  // 0.75 × 2πr ≈ 377 units of stroke; the dash pattern draws that fraction.
  const budget = goals.goalCalories + exerciseCal;
  const pct = budget > 0 ? Math.min(1, eaten.calories / budget) : 0;
  const gauge = document.getElementById('gauge-fill');
  gauge.setAttribute('stroke-dasharray', `${(pct * GAUGE_ARC).toFixed(1)} 503`);
  gauge.classList.toggle('over', remaining < 0);

  renderMacroBar('protein', eaten.protein, goals.macros.proteinG);
  renderMacroBar('carbs', eaten.carbs, goals.macros.carbsG);
  renderMacroBar('fat', eaten.fat, goals.macros.fatG);

  MEALS.forEach(m => {
    const items = state.diaryDay[m.key];
    const total = Math.round(items.reduce((s, i) => s + i.calories * i.qty, 0));
    const list = document.getElementById(`meal-${m.key}-list`);
    document.getElementById(`meal-${m.key}-total`).textContent = `${total.toLocaleString()} cal`;
    const suggested = Math.round((goals.goalCalories + exerciseCal) * m.share);
    document.getElementById(`meal-${m.key}-suggested`).textContent =
      suggested > 0 ? `${suggested.toLocaleString()} calories suggested` : '';

    // The macro line only ever shows once someone taps "Summary" for this
    // meal - state.mealSummaryOpen tracks that per meal key so it survives
    // the re-renders every diary change triggers, but resets on reload.
    const summaryBtn = document.getElementById(`meal-${m.key}-summary-btn`);
    const macrosEl = document.getElementById(`meal-${m.key}-macros`);
    summaryBtn.classList.toggle('hidden', items.length === 0);
    const isOpen = items.length > 0 && Boolean(state.mealSummaryOpen[m.key]);
    macrosEl.classList.toggle('hidden', !isOpen);
    if (isOpen) {
      const s = sumMeal(items);
      macrosEl.textContent =
        `P${Math.round(s.protein)} · C${Math.round(s.carbs)} · F${Math.round(s.fat)} · ` +
        `Fiber ${Math.round(s.fiber)} · Sugar ${Math.round(s.sugar)} · Na ${Math.round(s.sodium)}mg`;
    }

    // Sharing needs a group to share to and something worth sharing.
    const shareBtn = document.getElementById(`meal-${m.key}-share-btn`);
    shareBtn.classList.toggle('hidden', items.length === 0 || !(friends.group && friends.group.groupId));
    const inGroup = Boolean(friends.group && friends.group.groupId);
    list.innerHTML = items.length
      ? items.map(i => {
        const t = scaleNutrition(i, i.qty);
        const grams = parseServingGrams(i.servingDesc);
        const amount = grams
          ? `${Math.round(i.qty * grams * 10) / 10} g`
          : `${Math.round(i.qty * 100) / 100} × ${escapeHtml(i.servingDesc || 'serving')}`;
        return `
        <div class="entry-row" data-entry-id="${i.id}" data-meal="${m.key}">
          <button type="button" class="entry-info entry-open" data-meal="${m.key}" data-entry-id="${i.id}">
            <div class="entry-name">${foodEmoji(i.name)} ${escapeHtml(i.name)}</div>
            <div class="entry-sub">${amount} · ${t.calories} cal · P${t.protein} C${t.carbs} F${t.fat}</div>
          </button>
          ${inGroup ? `<button class="icon-btn small share-entry-btn" data-meal="${m.key}" data-entry-id="${i.id}" title="Share this item">↗</button>` : ''}
          <button class="icon-btn small remove-entry-btn" data-meal="${m.key}" data-entry-id="${i.id}" title="Remove">✕</button>
        </div>`;
      }).join('')
      : `<div class="empty-hint">No items logged</div>`;
  });

  // Everything that changes the diary ends up re-rendering, so this one call
  // site covers every add, edit and delete without threading sync through them.
  //
  // `items` rides along with the totals: the actual foods behind them, so a
  // group profile can show what someone had today, not just their numbers.
  // This is automatic, same as the totals - unlike the meal-share feed post
  // below, it needs no tap. See README.
  const dayItems = {};
  MEALS.forEach(m => {
    dayItems[m.key] = state.diaryDay[m.key].map(i => ({
      name: i.name,
      servingDesc: i.servingDesc || '1 serving',
      qty: i.qty,
      calories: i.calories,
      protein: i.protein,
      carbs: i.carbs,
      fat: i.fat,
      fiber: i.fiber,
      sugar: i.sugar,
      sodium: i.sodium
    }));
  });
  queueDaySync({
    date: state.currentDate,
    eaten: eaten.calories,
    budget: goals.goalCalories,
    exercise: exerciseCal,
    protein: eaten.protein,
    carbs: eaten.carbs,
    fat: eaten.fat,
    entries: MEALS.reduce((n, m) => n + state.diaryDay[m.key].length, 0),
    items: dayItems
  });

  const exList = document.getElementById('exercise-list');
  exList.innerHTML = state.exerciseDay.length
    ? state.exerciseDay.map(e => `
      <div class="entry-row" data-entry-id="${e.id}">
        <div class="entry-info">
          <div class="entry-name">${escapeHtml(e.name)}</div>
          <div class="entry-sub">${e.calories} cal burned</div>
        </div>
        <button class="icon-btn small remove-exercise-btn" data-entry-id="${e.id}" title="Remove">✕</button>
      </div>`).join('')
    : `<div class="empty-hint">No exercise logged</div>`;
}

function renderMacroBar(key, eaten, goal) {
  const pct = goal > 0 ? Math.min(100, Math.round((eaten / goal) * 100)) : 0;
  document.getElementById(`macro-${key}-fill`).style.width = `${pct}%`;
  document.getElementById(`macro-${key}-label`).textContent = `${eaten}g / ${goal}g`;
}

// Lists your saved foods and the whole built-in database together, so the
// database is visible by browsing rather than only turning up once you search.
function renderFoods() {
  const q = state.foodSearch.trim().toLowerCase();
  const matches = f => !q
    || f.name.toLowerCase().includes(q)
    || String(f.brand || '').toLowerCase().includes(q);
  const rows = [
    ...state.foods.filter(matches).map(f => ({ ...f, source: 'mine' })),
    ...FOOD_DB.filter(matches).map(f => ({ ...f, source: 'db' }))
  ];
  state.visibleFoodRows = rows;

  document.getElementById('foods-count').textContent =
    `${state.foods.length} saved · ${FOOD_DB.length} built-in`;

  const container = document.getElementById('foods-list');
  container.innerHTML = rows.length
    ? rows.map((f, i) => `
      <div class="food-row" data-idx="${i}">
        <div class="entry-info">
          <div class="entry-name">${foodEmoji(f.name)} ${escapeHtml(mealLabel(f))}</div>
          <div class="entry-sub">${escapeHtml(f.servingDesc)} · ${f.calories} cal · P${f.protein} C${f.carbs} F${f.fat}
            <span class="source-tag">${SOURCE_LABEL[f.source]}</span></div>
        </div>
        <div class="food-actions">
          <button class="secondary-btn small log-food-btn" data-idx="${i}">Log</button>
          ${f.source === 'mine' ? `
            <button class="icon-btn small edit-food-btn" data-idx="${i}" title="Edit">✎</button>
            <button class="icon-btn small delete-food-btn" data-idx="${i}" title="Delete">✕</button>` : ''}
        </div>
      </div>`).join('')
    : `<div class="empty-hint">Nothing matches that. Tap + on a meal to search branded foods online.</div>`;
}

function renderWeight() {
  const units = state.settings.units;
  const goalW = state.settings.goalWeightKg;
  const log = state.weightLog;
  const current = log.length ? log[log.length - 1].weightKg : state.settings.weightKg;

  document.getElementById('weight-current').textContent = `${displayWeight(current, units)} ${weightUnitLabel(units)}`;
  document.getElementById('weight-goal').textContent = goalW != null
    ? `${displayWeight(goalW, units)} ${weightUnitLabel(units)}`
    : 'Not set';

  if (log.length >= 2) {
    const start = log[0].weightKg;
    const change = current - start;
    const label = change <= 0 ? `${displayWeight(Math.abs(change), units)} ${weightUnitLabel(units)} lost` : `${displayWeight(change, units)} ${weightUnitLabel(units)} gained`;
    document.getElementById('weight-change').textContent = `Since ${formatDate(log[0].date)}: ${label}`;
  } else {
    document.getElementById('weight-change').textContent = 'Log a couple of entries to see your trend';
  }

  const chart = document.getElementById('weight-chart');
  chart.innerHTML = buildWeightChart(log, units);
  // Nothing to draw with fewer than two weigh-ins — hide the box rather than
  // leaving an empty card sitting on the page.
  chart.classList.toggle('hidden', log.length < 2);

  const list = document.getElementById('weight-list');
  list.innerHTML = log.length
    ? [...log].reverse().map(w => `
      <div class="entry-row" data-entry-id="${w.id}">
        <div class="entry-info">
          <div class="entry-name">${formatDate(w.date)}</div>
          <div class="entry-sub">${displayWeight(w.weightKg, units)} ${weightUnitLabel(units)}</div>
        </div>
        <button class="icon-btn small delete-weight-btn" data-entry-id="${w.id}" title="Remove">✕</button>
      </div>`).join('')
    : `<div class="empty-hint">No weigh-ins yet</div>`;
}

function buildWeightChart(log, units) {
  if (log.length < 2) return '';
  const width = 320, height = 120, pad = 10;
  const values = log.map(w => displayWeight(w.weightKg, units));
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const step = (width - pad * 2) / (log.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * step;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" class="trend-svg" preserveAspectRatio="none">
    <polyline points="${points.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
    ${points.map(p => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="3" fill="var(--accent)" />`).join('')}
  </svg>`;
}

// Writes saved state into the form. Only call this when opening/reloading the
// tab, never on 'input' — otherwise every keystroke would overwrite itself.
function populateSettingsForm() {
  const s = state.settings;
  formUnits = s.units;
  const form = document.getElementById('settings-form');
  form.units.value = s.units;
  form.sex.value = s.sex;
  form.age.value = s.age;
  form.activity.value = s.activity;
  form.goal.value = s.goal;
  renderRateOptions(s.units, s.rateLbPerWeek);
  form.proteinPct.value = s.macroSplit.proteinPct;
  form.carbsPct.value = s.macroSplit.carbsPct;
  form.fatPct.value = s.macroSplit.fatPct;
  form.calorieOverride.value = s.calorieOverride != null ? s.calorieOverride : '';
  form.theme.value = s.theme || 'dark';
  form.apiKey.value = s.apiKey || '';

  if (s.units === 'metric') {
    form.heightCm.value = Math.round(s.heightCm);
    form.weightKg.value = Math.round(s.weightKg * 10) / 10;
    form.goalWeightKg.value = s.goalWeightKg != null ? Math.round(s.goalWeightKg * 10) / 10 : '';
  } else {
    const totalIn = cmToIn(s.heightCm);
    form.heightFt.value = Math.floor(totalIn / 12);
    form.heightIn.value = Math.round(totalIn % 12);
    form.weightLb.value = Math.round(kgToLb(s.weightKg) * 10) / 10;
    form.goalWeightLb.value = s.goalWeightKg != null ? Math.round(kgToLb(s.goalWeightKg) * 10) / 10 : '';
  }

  updateSettingsPreview();
}

// Reads the live form and updates the computed preview. Safe to call on
// every keystroke since it never writes back into the input fields.
function updateSettingsPreview() {
  const form = document.getElementById('settings-form');
  const units = form.units.value;

  document.getElementById('rate-row').classList.toggle('hidden', form.goal.value === 'maintain');
  document.getElementById('height-imperial').classList.toggle('hidden', units === 'metric');
  document.getElementById('height-metric').classList.toggle('hidden', units !== 'metric');
  document.getElementById('weight-imperial').classList.toggle('hidden', units === 'metric');
  document.getElementById('weight-metric').classList.toggle('hidden', units !== 'metric');

  const pctSum = Number(form.proteinPct.value) + Number(form.carbsPct.value) + Number(form.fatPct.value);
  document.getElementById('macro-sum-hint').textContent = `Total: ${pctSum}%`;
  document.getElementById('macro-sum-hint').classList.toggle('negative', pctSum !== 100);

  const liveSettings = readSettingsFromForm();
  const goals = computeGoals(liveSettings);
  document.getElementById('result-bmr').textContent = goals.bmr.toLocaleString();
  document.getElementById('result-tdee').textContent = goals.tdee.toLocaleString();
  document.getElementById('result-goal').textContent = goals.goalCalories.toLocaleString();
  document.getElementById('result-calculated').textContent = goals.rawGoal.toLocaleString();
  document.getElementById('override-active-row').classList.toggle('hidden', liveSettings.calorieOverride == null);
  document.getElementById('result-protein').textContent = `${goals.macros.proteinG}g`;
  document.getElementById('result-carbs').textContent = `${goals.macros.carbsG}g`;
  document.getElementById('result-fat').textContent = `${goals.macros.fatG}g`;
  document.getElementById('low-cal-warning').classList.toggle('hidden', goals.goalCalories >= (liveSettings.sex === 'male' ? 1500 : 1200));
}

// Converts whatever the user has typed so far into the newly selected unit's
// fields, rather than discarding the in-progress edit.
function convertAndSwitchUnits(newUnits) {
  if (newUnits === formUnits) return;
  const form = document.getElementById('settings-form');
  let heightCm, weightKg, goalWeightKg = null;
  if (formUnits === 'metric') {
    heightCm = Number(form.heightCm.value) || state.settings.heightCm;
    weightKg = Number(form.weightKg.value) || state.settings.weightKg;
    goalWeightKg = form.goalWeightKg.value ? Number(form.goalWeightKg.value) : null;
  } else {
    const ft = Number(form.heightFt.value) || 0;
    const inches = Number(form.heightIn.value) || 0;
    heightCm = (ft || inches) ? inToCm(ft * 12 + inches) : state.settings.heightCm;
    weightKg = form.weightLb.value ? lbToKg(Number(form.weightLb.value)) : state.settings.weightKg;
    goalWeightKg = form.goalWeightLb.value ? lbToKg(Number(form.goalWeightLb.value)) : null;
  }

  const currentRateLb = Number(form.rate.value) || state.settings.rateLbPerWeek;
  formUnits = newUnits;
  renderRateOptions(newUnits, currentRateLb);
  if (newUnits === 'metric') {
    form.heightCm.value = Math.round(heightCm);
    form.weightKg.value = Math.round(weightKg * 10) / 10;
    form.goalWeightKg.value = goalWeightKg != null ? Math.round(goalWeightKg * 10) / 10 : '';
  } else {
    const totalIn = cmToIn(heightCm);
    form.heightFt.value = Math.floor(totalIn / 12);
    form.heightIn.value = Math.round(totalIn % 12);
    form.weightLb.value = Math.round(kgToLb(weightKg) * 10) / 10;
    form.goalWeightLb.value = goalWeightKg != null ? Math.round(kgToLb(goalWeightKg) * 10) / 10 : '';
  }
  updateSettingsPreview();
}

// Reads the live form without saving, so the calculator preview updates as you type.
function readSettingsFromForm() {
  const form = document.getElementById('settings-form');
  const units = form.units.value;
  let heightCm, weightKg, goalWeightKg = null;
  if (units === 'metric') {
    heightCm = Number(form.heightCm.value) || state.settings.heightCm;
    weightKg = Number(form.weightKg.value) || state.settings.weightKg;
    goalWeightKg = form.goalWeightKg.value ? Number(form.goalWeightKg.value) : null;
  } else {
    const ft = Number(form.heightFt.value) || 0;
    const inches = Number(form.heightIn.value) || 0;
    heightCm = (ft || inches) ? inToCm(ft * 12 + inches) : state.settings.heightCm;
    weightKg = form.weightLb.value ? lbToKg(Number(form.weightLb.value)) : state.settings.weightKg;
    goalWeightKg = form.goalWeightLb.value ? lbToKg(Number(form.goalWeightLb.value)) : null;
  }
  return {
    units,
    sex: form.sex.value,
    age: Number(form.age.value) || state.settings.age,
    heightCm,
    weightKg,
    goalWeightKg,
    activity: form.activity.value,
    goal: form.goal.value,
    rateLbPerWeek: Number(form.rate.value) || 0,
    macroSplit: {
      proteinPct: Number(form.proteinPct.value) || 0,
      carbsPct: Number(form.carbsPct.value) || 0,
      fatPct: Number(form.fatPct.value) || 0
    },
    calorieOverride: form.calorieOverride.value ? Number(form.calorieOverride.value) : null,
    theme: form.theme.value,
    apiKey: form.apiKey.value.trim()
  };
}

// ---- Photo estimate ----
// Shrinks the photo before upload: the API bills per visual token, and a 1024px
// image is plenty to recognise a plate of food.
function fileToScaledJpeg(file, maxEdge = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      resolve(dataUrl.split(',')[1]);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // Usually a HEIC the browser can't decode; a screenshot or shared copy is JPEG.
      reject(new Error('That image could not be read. Try a different photo, or screenshot it first.'));
    };
    img.src = url;
  });
}

const PHOTO_PROMPT = `Identify the food in this photo and estimate the nutrition for the portion shown.
Respond with ONLY a JSON object and no other text, in exactly this shape:
{"name": "short food name", "serving": "the portion you see, e.g. 1 plate", "calories": 0, "protein": 0, "carbs": 0, "fat": 0, "confidence": "high|medium|low", "note": "one short sentence on what you assumed"}
Calories are for the whole portion visible. Protein, carbs and fat are grams. If you cannot tell what the food is, set confidence to "low" and give your best guess anyway.`;

async function estimateFromPhoto(base64Jpeg, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for calling the API straight from a browser.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 1024,
      output_config: { effort: 'low' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg } },
          { type: 'text', text: PHOTO_PROMPT }
        ]
      }]
    })
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message = detail && detail.error && detail.error.message ? detail.error.message : `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('That API key was rejected. Check it in Goals → Photo estimates.');
    throw new Error(message);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to analyse that image.');
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No estimate came back. Try another photo.');
  return parseEstimate(textBlock.text);
}

// The model is asked for bare JSON, but tolerate it being wrapped in prose or a
// code fence rather than failing the whole estimate.
function parseEstimate(text) {
  let raw = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Could not read the estimate. Try another photo.');
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('Could not read the estimate. Try another photo.');
  }
  const num = v => Math.max(0, Math.round((Number(v) || 0) * 10) / 10);
  return {
    name: String(parsed.name || 'Photo estimate').slice(0, 80),
    servingDesc: String(parsed.serving || '1 portion').slice(0, 60),
    calories: Math.round(Number(parsed.calories) || 0),
    protein: num(parsed.protein),
    carbs: num(parsed.carbs),
    fat: num(parsed.fat),
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    note: String(parsed.note || '').slice(0, 200),
    source: 'photo'
  };
}

async function runPhotoEstimate(file) {
  const status = document.getElementById('photo-status');
  const key = (state.settings.apiKey || '').trim();
  if (!key) {
    status.textContent = 'Not set up yet — follow the steps below.';
    document.getElementById('photo-setup').classList.remove('hidden');
    return;
  }
  status.textContent = 'Reading the photo…';
  try {
    const b64 = await fileToScaledJpeg(file);
    status.textContent = 'Estimating calories…';
    const estimate = await estimateFromPhoto(b64, key);
    closeModal('photo-modal');
    const confidenceNote = estimate.confidence === 'high' ? '' : ` (${estimate.confidence} confidence)`;
    openConfirmFood(estimate, `Photo estimate${confidenceNote}. ${estimate.note}`);
  } catch (err) {
    status.textContent = err.message || 'That did not work. Try again.';
  }
}

// ---- Modals ----
// The page behind a sheet is frozen while it is open. Without this, focusing the
// search box makes the phone keyboard scroll the whole page, pushing the results
// out of sight underneath the sheet.
function syncBodyScrollLock() {
  const anyOpen = !!document.querySelector('.modal:not(.hidden)');
  document.body.classList.toggle('modal-open', anyOpen);
}

// iOS does not shrink dvh for the on-screen keyboard, so a bottom-anchored
// sheet ends up underneath it. visualViewport does report the space actually
// left above the keyboard - publish it so sheets can size to it.
function syncViewportHeight() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--vvh', `${Math.round(height)}px`);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportHeight);
  window.visualViewport.addEventListener('scroll', syncViewportHeight);
}
window.addEventListener('resize', syncViewportHeight);
syncViewportHeight();

function openModal(id) {
  const modal = document.getElementById(id);
  // A sheet opened from another sheet has to sit above it, whatever their order
  // in the document - otherwise the one underneath swallows the taps.
  const alreadyOpen = document.querySelectorAll('.modal:not(.hidden)').length;
  modal.style.zIndex = String(20 + alreadyOpen);
  modal.classList.remove('hidden');
  syncBodyScrollLock();
}
function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('hidden');
  modal.classList.remove('searching', 'has-query');
  modal.style.zIndex = '';
  syncBodyScrollLock();
}

// Once something is logged, every sheet that led there is done - leaving one
// open would show figures that the new entry has already changed.
function closeAllModals() {
  document.querySelectorAll('.modal:not(.hidden)').forEach(m => closeModal(m.id));
}

function openAddEntryModal(meal) {
  const modal = document.getElementById('add-entry-modal');
  modal.dataset.meal = meal;
  document.getElementById('add-entry-title').textContent = `Add to ${MEALS.find(m => m.key === meal).label}`;
  state.pendingMeal = meal;
  document.getElementById('add-entry-search').value = '';
  document.getElementById('quick-add-form').reset();
  document.getElementById('add-entry-tab-search').click();
  state.searchResults = [];
  renderAddEntryFoodList('');
  openModal('add-entry-modal');
  document.getElementById('add-entry-search').focus();
}

// An empty box shows your saved foods; typing searches those plus the built-in
// database. Online (branded) results are merged in when you ask for them.
function localMatches(query) {
  const q = query.trim().toLowerCase();
  // Brand counts as a match, so "cinnabon" or "kfc" finds their menu items even
  // though the brand is stored separately from the dish name.
  const matches = f => !q
    || f.name.toLowerCase().includes(q)
    || String(f.brand || '').toLowerCase().includes(q);
  const mine = state.foods.filter(matches).map(f => ({ ...f, source: 'mine' }));
  const builtIn = FOOD_DB.filter(matches).map(f => ({ ...f, source: 'db' }));
  return [...mine, ...builtIn];
}

const SOURCE_LABEL = { mine: 'My food', db: 'Built-in', online: 'Branded' };

function renderAddEntryFoodList(query) {
  const results = [...localMatches(query), ...state.searchResults];
  const container = document.getElementById('add-entry-food-list');
  if (!results.length) {
    container.innerHTML = `<div class="empty-hint">No matches. Try “Search branded foods” below, or Quick Add.</div>`;
    return;
  }
  // Tapping the food opens the editor (serving, grams, macros); the Add button
  // stays for logging one serving without a detour. The chevron is there so the
  // row reads as tappable rather than looking like plain text.
  container.innerHTML = `<div class="list-hint">Tap a food to set grams or servings · or Add one serving</div>`
    + results.map((f, i) => `
    <div class="food-row pick-row" data-idx="${i}">
      <button type="button" class="entry-info entry-open pick-open" data-idx="${i}">
        <div class="entry-name">${foodEmoji(f.name)} ${escapeHtml(mealLabel(f))} <span class="chev">›</span></div>
        <div class="entry-sub">${escapeHtml(f.servingDesc)} · ${f.calories} cal · P${f.protein} C${f.carbs} F${f.fat}
          <span class="source-tag">${SOURCE_LABEL[f.source] || ''}</span></div>
      </button>
      <div class="qty-picker">
        <input type="number" class="qty-input" min="0" step="any" value="1" data-idx="${i}" />
        <button class="primary-btn small add-picked-food-btn" data-idx="${i}">Add</button>
      </div>
    </div>`).join('');
  // Keep the rendered order addressable by index for the click handler.
  state.visibleResults = results;
}

// Open Food Facts is a free, openly licensed product database (barcodes and
// branded items), which is what fills the gap the built-in list can't cover.
async function searchOnlineFoods(query) {
  const url = 'https://world.openfoodfacts.org/cgi/search.pl'
    + `?search_terms=${encodeURIComponent(query)}`
    + '&search_simple=1&action=process&json=1&page_size=25'
    + '&fields=product_name,brands,nutriments,serving_size';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Search service is unavailable right now.');
  const data = await res.json();
  return (data.products || []).map(mapOnlineProduct).filter(Boolean);
}

// ---- Barcode scanning ----
// Looks a barcode up in Open Food Facts, which indexes packaged products by
// their EAN/UPC - the same barcodes on supermarket packaging.
async function lookupBarcode(code) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`
    + '?fields=product_name,brands,nutriments,serving_size';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Lookup failed.');
  const data = await res.json();
  if (!data || data.status !== 1 || !data.product) return null;
  return mapOnlineProduct(data.product);
}

const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];

async function nativeDetectorFormats() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const wanted = BARCODE_FORMATS.filter(f => supported.includes(f));
    return wanted.length ? wanted : null;
  } catch {
    return null;
  }
}

function loadZxing() {
  if (window.ZXing) return Promise.resolve();
  if (loadZxing.pending) return loadZxing.pending;
  loadZxing.pending = new Promise(resolve => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
    script.onload = () => resolve();
    script.onerror = () => resolve(); // caller falls back to manual entry
    document.head.appendChild(script);
  });
  return loadZxing.pending;
}

// Exactly one thing owns the camera at a time. With BarcodeDetector we open the
// stream ourselves and poll frames; with ZXing we hand the camera to ZXing and
// never call getUserMedia, because its reader resets the video element (and
// stops the tracks) when it takes over one we opened - which looked like the
// camera opening and immediately closing.
async function startScanner() {
  const status = document.getElementById('scan-status');
  const video = document.getElementById('scan-video');
  video.setAttribute('playsinline', 'true');
  video.setAttribute('muted', 'true');
  status.textContent = 'Starting camera…';

  const formats = await nativeDetectorFormats();
  if (formats) {
    await startNativeScanner(video, status, formats);
    return;
  }

  status.textContent = 'Loading scanner…';
  await loadZxing();
  if (window.ZXing && typeof window.ZXing.BrowserMultiFormatReader === 'function') {
    await startZxingScanner(video, status);
    return;
  }
  status.textContent = 'Scanning is not supported on this browser. Type the barcode below instead.';
}

async function startNativeScanner(video, status, formats) {
  try {
    state.scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    });
  } catch {
    status.textContent = 'No camera access. Allow the camera, or type the barcode below.';
    return;
  }
  video.srcObject = state.scanStream;
  try {
    await video.play();
  } catch {
    // Autoplay refusal still leaves a usable manual-entry box.
  }

  const detector = new window.BarcodeDetector({ formats });
  status.textContent = 'Point the camera at the barcode…';
  let busy = false;
  state.scanTimer = setInterval(async () => {
    // Guarded so a slow detect never overlaps the next tick.
    if (busy || !state.scanStream) return;
    busy = true;
    try {
      const codes = await detector.detect(video);
      if (codes.length && codes[0].rawValue) {
        const code = codes[0].rawValue;
        stopScanner();
        await handleBarcode(code);
        return;
      }
    } catch {
      // A dropped frame is normal; keep scanning.
    } finally {
      busy = false;
    }
  }, 300);
}

async function startZxingScanner(video, status) {
  try {
    state.zxingReader = new window.ZXing.BrowserMultiFormatReader();
    status.textContent = 'Point the camera at the barcode…';
    // ZXing opens the camera itself here, so we never hold a competing stream.
    await state.zxingReader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } } },
      video,
      (result, err) => {
        if (!result || state.scanHandled) return;
        state.scanHandled = true;
        const code = result.getText();
        stopScanner();
        handleBarcode(code);
      }
    );
  } catch {
    stopScanner();
    status.textContent = 'Could not start the camera. Type the barcode number below instead.';
  }
}

function stopScanner() {
  if (state.scanTimer) clearInterval(state.scanTimer);
  state.scanTimer = null;
  if (state.zxingReader) {
    try {
      state.zxingReader.reset();
    } catch {
      // Already torn down.
    }
    state.zxingReader = null;
  }
  if (state.scanStream) {
    state.scanStream.getTracks().forEach(t => t.stop());
    state.scanStream = null;
  }
  const video = document.getElementById('scan-video');
  if (video) video.srcObject = null;
  state.scanHandled = false;
}

async function handleBarcode(code) {
  const status = document.getElementById('scan-status');
  status.textContent = `Looking up ${code}…`;
  let food;
  try {
    food = await lookupBarcode(code);
  } catch {
    status.textContent = 'Could not reach the food database — check your connection.';
    return;
  }
  if (!food) {
    status.textContent = `No product found for ${code}. Try Quick Add instead.`;
    return;
  }
  closeModal('scan-modal');
  openConfirmFood(food, `Scanned: ${code}`);
}

function mapOnlineProduct(p) {
  if (!p.product_name) return null;
  const n = p.nutriments || {};
  // Prefer the manufacturer's own serving when it carries nutrition, else
  // fall back to the per-100g figures every product has.
  const perServing = p.serving_size && n['energy-kcal_serving'] != null;
  const calories = perServing ? n['energy-kcal_serving'] : n['energy-kcal_100g'];
  if (calories == null) return null;
  const brand = p.brands ? p.brands.split(',')[0].trim() : '';
  const round = v => Math.round((Number(v) || 0) * 10) / 10;
  return {
    name: brand ? `${p.product_name} (${brand})` : p.product_name,
    servingDesc: perServing ? p.serving_size : '100 g',
    calories: Math.round(calories),
    protein: round(perServing ? n.proteins_serving : n.proteins_100g),
    carbs: round(perServing ? n.carbohydrates_serving : n.carbohydrates_100g),
    fat: round(perServing ? n.fat_serving : n.fat_100g),
    fiber: round(perServing ? n.fiber_serving : n.fiber_100g),
    sugar: round(perServing ? n.sugars_serving : n.sugars_100g),
    // Open Food Facts reports sodium in grams, not milligrams like everywhere else here.
    sodium: Math.round((Number(perServing ? n.sodium_serving : n.sodium_100g) || 0) * 1000),
    source: 'online'
  };
}

// ---- Amount editing ----
// A serving written as "100 g" or "170 g container" gives a gram basis, which
// lets the amount be entered in grams instead of fractional servings.
function parseServingGrams(servingDesc) {
  const match = String(servingDesc || '').match(/(\d+(?:\.\d+)?)\s*g\b/i);
  const grams = match ? Number(match[1]) : null;
  return grams && grams > 0 ? grams : null;
}

function scaleNutrition(base, qty) {
  const round = v => Math.round((Number(v) || 0) * qty * 10) / 10;
  return {
    calories: Math.round((Number(base.calories) || 0) * qty),
    protein: round(base.protein),
    carbs: round(base.carbs),
    fat: round(base.fat),
    fiber: round(base.fiber),
    sugar: round(base.sugar),
    sodium: Math.round((Number(base.sodium) || 0) * qty)
  };
}

// Reads the per-serving numbers out of a form and paints the scaled totals, so
// changing the amount visibly changes calories and macros before you save.
function refreshAmountTotals(prefix) {
  const form = document.getElementById(`${prefix}-form`);
  const qty = Number(document.getElementById(`${prefix}-qty`).value) || 0;
  const totals = scaleNutrition({
    calories: form.calories.value,
    protein: form.protein.value,
    carbs: form.carbs.value,
    fat: form.fat.value,
    fiber: form.fiber ? form.fiber.value : 0,
    sugar: form.sugar ? form.sugar.value : 0,
    sodium: form.sodium ? form.sodium.value : 0
  }, qty);
  document.getElementById(`${prefix}-totals`).textContent =
    `${totals.calories} cal · P${totals.protein} C${totals.carbs} F${totals.fat} · Fiber ${totals.fiber} · Sugar ${totals.sugar} · Na ${totals.sodium}mg`;
  return totals;
}

// Keeps the grams box and the servings box describing the same amount, and
// keeps the reference nutrition honest when the serving itself is redefined.
function wireGramsAndServings(prefix) {
  const qtyInput = document.getElementById(`${prefix}-qty`);
  const gramsInput = document.getElementById(`${prefix}-grams`);
  const gramsRow = document.getElementById(`${prefix}-grams-row`);
  const form = document.getElementById(`${prefix}-form`);

  const basis = () => parseServingGrams(form.servingDesc.value);

  const syncFromQty = () => {
    const g = basis();
    if (g && gramsInput) {
      const qty = Number(qtyInput.value) || 0;
      gramsInput.value = Math.round(qty * g * 10) / 10;
    }
    refreshAmountTotals(prefix);
  };

  const syncFromGrams = () => {
    const g = basis();
    if (!g) return;
    const grams = Number(gramsInput.value) || 0;
    qtyInput.value = Math.round((grams / g) * 1000) / 1000;
    refreshAmountTotals(prefix);
  };

  qtyInput.addEventListener('input', syncFromQty);
  if (gramsInput) gramsInput.addEventListener('input', syncFromGrams);
  ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'].forEach(name => {
    if (form[name]) form[name].addEventListener('input', () => refreshAmountTotals(prefix));
  });

  // Editing "100 g" into "150 g" redefines what one serving is, so the
  // reference nutrition has to move with it - otherwise 150 g of chicken
  // breast keeps reporting the calories of 100 g.
  form.servingDesc.addEventListener('input', () => {
    const previous = Number(form.dataset.gramBasis) || null;
    const current = basis();
    if (previous && current && current !== previous) {
      const factor = current / previous;
      ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'].forEach(name => {
        if (!form[name]) return;
        const value = Number(form[name].value) || 0;
        form[name].value = (name === 'calories' || name === 'sodium')
          ? Math.round(value * factor)
          : Math.round(value * factor * 10) / 10;
      });
    }
    form.dataset.gramBasis = current || '';
    if (gramsRow) gramsRow.classList.toggle('hidden', !current);
    syncFromQty();
  });
}

// Reads a form's nutrition fields back out into a plain object. The
// counterpart to fillNutritionFields, and for the same reason: every submit
// handler that saves an amount editor's contents needs this, and writing it
// once here is what stops one of them quietly dropping a field.
function readNutritionFields(form) {
  return {
    calories: Number(form.calories.value) || 0,
    protein: Number(form.protein.value) || 0,
    carbs: Number(form.carbs.value) || 0,
    fat: Number(form.fat.value) || 0,
    fiber: form.fiber ? Number(form.fiber.value) || 0 : 0,
    sugar: form.sugar ? Number(form.sugar.value) || 0 : 0,
    sodium: form.sodium ? Number(form.sodium.value) || 0 : 0
  };
}

// Fills a form's nutrition fields from any food-shaped object. Shared by
// every place that opens an amount editor, so the extended macros
// (fiber/sugar/sodium) only have to be wired here once.
function fillNutritionFields(form, food) {
  form.calories.value = food.calories || 0;
  form.protein.value = food.protein || 0;
  form.carbs.value = food.carbs || 0;
  form.fat.value = food.fat || 0;
  if (form.fiber) form.fiber.value = food.fiber || 0;
  if (form.sugar) form.sugar.value = food.sugar || 0;
  if (form.sodium) form.sodium.value = food.sodium || 0;
}

// Called whenever an editor is opened, so the reference label and the stored
// gram basis match the food being edited.
function primeAmountEditor(prefix, servingDesc) {
  const form = document.getElementById(`${prefix}-form`);
  const grams = parseServingGrams(servingDesc);
  form.dataset.gramBasis = grams || '';
  document.getElementById(`${prefix}-grams-row`).classList.toggle('hidden', !grams);
  if (grams) document.getElementById(`${prefix}-grams`).value = grams;
  // Naming the basis makes clear these are reference values, not the total.
  document.getElementById(`${prefix}-per-label`).textContent =
    `Nutrition per ${servingDesc || '1 serving'}`;
}

function openEntryEditor(meal, entry) {
  state.editingEntry = { meal, id: entry.id };
  const form = document.getElementById('edit-entry-form');
  form.name.value = entry.name;
  form.servingDesc.value = entry.servingDesc || '1 serving';
  fillNutritionFields(form, entry);
  document.getElementById('edit-entry-qty').value = entry.qty;
  document.getElementById('edit-entry-meal').value = meal;

  primeAmountEditor('edit-entry', form.servingDesc.value);
  const grams = parseServingGrams(entry.servingDesc);
  if (grams) document.getElementById('edit-entry-grams').value = Math.round(entry.qty * grams * 10) / 10;
  refreshAmountTotals('edit-entry');
  openModal('edit-entry-modal');
}

// Shared review step for anything the app worked out for you - a scanned
// product or a photo estimate - so nothing is logged without a look first.
function openConfirmFood(food, note) {
  state.confirmFood = food;
  document.getElementById('confirm-food-title').textContent = food.name;
  document.getElementById('confirm-food-note').textContent = note || '';
  const form = document.getElementById('confirm-food-form');
  fillNutritionFields(form, food);
  form.servingDesc.value = food.servingDesc;
  document.getElementById('confirm-food-qty').value = 1;
  primeAmountEditor('confirm-food', form.servingDesc.value);
  document.getElementById('confirm-food-meal').value = state.pendingMeal || 'breakfast';
  refreshAmountTotals('confirm-food');
  openModal('confirm-food-modal');
}

// ---- Eating-out suggestions ----
// Picks restaurant meals that fit the calories still left today. The order is
// seeded by the date, so a day's shortlist is stable while you look at it but
// is different tomorrow.
function seededShuffle(items, seed) {
  const out = [...items];
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function dateSeed(dateStr) {
  return [...dateStr].reduce((a, c) => a + c.charCodeAt(0) * 31, 7);
}

function remainingToday() {
  const goals = computeGoals(state.settings);
  const eaten = sumDay(state.diaryDay);
  const exercise = state.exerciseDay.reduce((s, e) => s + e.calories, 0);
  return {
    remaining: goals.goalCalories - eaten.calories + exercise,
    proteinLeft: Math.max(goals.macros.proteinG - eaten.protein, 0)
  };
}

// Every restaurant meal is listed - nothing is hidden for being too big. What
// fits comes first, ordered by protein per calorie so the pick that leaves the
// day in the best shape leads; the rest follow, smallest overshoot first, and
// are marked as over budget rather than removed.
function orderedMeals(remaining, brand, query) {
  const q = query.trim().toLowerCase();
  const pool = FOOD_DB.filter(f => f.restaurant
    && (brand === 'all' || f.brand === brand)
    && (!q || f.name.toLowerCase().includes(q) || String(f.brand).toLowerCase().includes(q)));

  const seed = dateSeed(state.currentDate);
  const withOrder = seededShuffle(pool, seed).map((f, i) => ({ f, i }));
  const fits = withOrder
    .filter(x => x.f.calories <= remaining)
    .sort((a, b) => (b.f.protein / Math.max(b.f.calories, 1)) - (a.f.protein / Math.max(a.f.calories, 1)) || a.i - b.i);
  const over = withOrder
    .filter(x => x.f.calories > remaining)
    .sort((a, b) => a.f.calories - b.f.calories);
  return { fits: fits.map(x => x.f), over: over.map(x => x.f) };
}

// Restaurant meals read "Brand — Dish", except where the name already carries
// the brand ("KFC Zinger Burger", "Big Mac (McDonald's)") - prefixing those
// again would just stutter.
function mealLabel(food) {
  const name = String(food.name);
  const brand = String(food.brand || '');
  if (!brand) return name;
  const lowerName = name.toLowerCase();
  const lowerBrand = brand.toLowerCase();
  if (lowerName.startsWith(lowerBrand) || lowerName.includes(`(${lowerBrand})`)) return name;
  return `${brand} — ${name}`;
}

function renderSuggestBrands() {
  const brands = [...new Set(FOOD_DB.filter(f => f.restaurant).map(f => f.brand))].sort();
  const row = document.getElementById('suggest-brands');
  row.innerHTML = [['all', 'All']].concat(brands.map(b => [b, b]))
    .map(([value, label]) => `
      <button type="button" class="chip ${state.suggestBrand === value ? 'active' : ''}"
        data-brand="${escapeAttr(value)}">${escapeHtml(label)}</button>`).join('');
}

function renderSuggestions() {
  const { remaining, proteinLeft } = remainingToday();
  const headline = document.getElementById('suggest-headline');
  const list = document.getElementById('suggest-list');

  headline.textContent = remaining > 0
    ? `${remaining.toLocaleString()} cal left${proteinLeft ? ` · ${proteinLeft}g protein to go` : ''}`
    : `${Math.abs(remaining).toLocaleString()} cal over budget today`;
  headline.classList.toggle('negative', remaining <= 0);

  const { fits, over } = orderedMeals(remaining, state.suggestBrand, state.suggestSearch);
  state.suggestRows = [...fits, ...over];

  if (!state.suggestRows.length) {
    list.innerHTML = `<div class="empty-hint">Nothing matches that filter.</div>`;
    return;
  }

  const row = (f, i, isOver) => `
    <div class="food-row pick-row ${isOver ? 'over-budget' : ''}">
      <button type="button" class="entry-info entry-open suggest-open" data-idx="${i}">
        <div class="entry-name">${foodEmoji(f.name)} ${escapeHtml(mealLabel(f))} <span class="chev">›</span></div>
        <div class="entry-sub">${escapeHtml(f.servingDesc)} · ${f.calories} cal · P${f.protein} C${f.carbs} F${f.fat}</div>
      </button>
      <div class="qty-picker"><span class="left-after ${isOver ? 'over' : ''}">${isOver
        ? `+${(f.calories - remaining).toLocaleString()} over`
        : `${(remaining - f.calories).toLocaleString()} left`}</span></div>
    </div>`;

  const parts = [];
  if (fits.length) {
    parts.push(`<div class="list-hint">${fits.length} fit${fits.length === 1 ? 's' : ''} what's left</div>`);
    parts.push(fits.map((f, i) => row(f, i, false)).join(''));
  }
  if (over.length) {
    parts.push(`<div class="list-hint over">${over.length} over budget — still loggable</div>`);
    parts.push(over.map((f, i) => row(f, fits.length + i, true)).join(''));
  }
  list.innerHTML = parts.join('');
}

// ---- Recipes ----
function recipeTotals(recipe) {
  const totals = recipe.ingredients.reduce((acc, i) => ({
    calories: acc.calories + i.calories * i.qty,
    protein: acc.protein + i.protein * i.qty,
    carbs: acc.carbs + i.carbs * i.qty,
    fat: acc.fat + i.fat * i.qty,
    fiber: acc.fiber + (i.fiber || 0) * i.qty,
    sugar: acc.sugar + (i.sugar || 0) * i.qty,
    sodium: acc.sodium + (i.sodium || 0) * i.qty
  }), { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 });
  const servings = Math.max(recipe.servings || 1, 0.25);
  return {
    total: totals,
    perServing: {
      calories: Math.round(totals.calories / servings),
      protein: Math.round((totals.protein / servings) * 10) / 10,
      carbs: Math.round((totals.carbs / servings) * 10) / 10,
      fat: Math.round((totals.fat / servings) * 10) / 10,
      fiber: Math.round((totals.fiber / servings) * 10) / 10,
      sugar: Math.round((totals.sugar / servings) * 10) / 10,
      sodium: Math.round(totals.sodium / servings)
    }
  };
}

function renderRecipes() {
  const container = document.getElementById('recipes-list');
  container.innerHTML = state.recipes.length
    ? state.recipes.map(r => {
      const { perServing } = recipeTotals(r);
      return `
        <div class="food-row" data-recipe-id="${r.id}">
          <div class="entry-info">
            <div class="entry-name">🍲 ${escapeHtml(r.name)}</div>
            <div class="entry-sub">${r.ingredients.length} ingredient${r.ingredients.length === 1 ? '' : 's'} ·
              makes ${r.servings} · ${perServing.calories} cal/serving ·
              P${perServing.protein} C${perServing.carbs} F${perServing.fat}</div>
          </div>
          <div class="food-actions">
            <button class="secondary-btn small log-recipe-btn" data-recipe-id="${r.id}">Log</button>
            <button class="icon-btn small edit-recipe-btn" data-recipe-id="${r.id}" title="Edit">✎</button>
            <button class="icon-btn small delete-recipe-btn" data-recipe-id="${r.id}" title="Delete">✕</button>
          </div>
        </div>`;
    }).join('')
    : `<div class="empty-hint">No recipes yet. Build one from your foods and it logs by the serving.</div>`;
}

function openRecipeEditor(recipe) {
  state.recipeDraft = recipe
    ? { id: recipe.id, name: recipe.name, servings: recipe.servings, ingredients: [...recipe.ingredients] }
    : { name: '', servings: 1, ingredients: [] };
  document.getElementById('recipe-editor-title').textContent = recipe ? 'Edit Recipe' : 'New Recipe';
  const form = document.getElementById('recipe-form');
  form.name.value = state.recipeDraft.name;
  form.servings.value = state.recipeDraft.servings;
  document.getElementById('recipe-ingredient-search').value = '';
  renderRecipeDraft();
  renderRecipeIngredientPicker('');
  openModal('recipe-editor-modal');
}

function renderRecipeDraft() {
  const draft = state.recipeDraft;
  const list = document.getElementById('recipe-ingredients');
  list.innerHTML = draft.ingredients.length
    ? draft.ingredients.map((i, idx) => `
      <div class="entry-row">
        <div class="entry-info">
          <div class="entry-name">${foodEmoji(i.name)} ${escapeHtml(i.name)}</div>
          <div class="entry-sub">${i.qty !== 1 ? `${i.qty}× · ` : ''}${Math.round(i.calories * i.qty)} cal</div>
        </div>
        <button type="button" class="icon-btn small remove-ingredient-btn" data-idx="${idx}" title="Remove">✕</button>
      </div>`).join('')
    : `<div class="empty-hint">No ingredients yet — search below to add them.</div>`;

  const servings = Math.max(Number(document.getElementById('recipe-form').servings.value) || 1, 0.25);
  const { perServing } = recipeTotals({ ingredients: draft.ingredients, servings });
  document.getElementById('recipe-per-serving').textContent =
    `${perServing.calories} cal · P${perServing.protein} C${perServing.carbs} F${perServing.fat} per serving`;
}

function renderRecipeIngredientPicker(query) {
  const results = localMatches(query).slice(0, 40);
  const container = document.getElementById('recipe-ingredient-list');
  state.recipePickerRows = results;
  container.innerHTML = results.length
    ? results.map((f, i) => `
      <div class="food-row pick-row">
        <div class="entry-info">
          <div class="entry-name">${foodEmoji(f.name)} ${escapeHtml(mealLabel(f))}</div>
          <div class="entry-sub">${escapeHtml(f.servingDesc)} · ${f.calories} cal</div>
        </div>
        <div class="qty-picker">
          <input type="number" class="qty-input" min="0" step="any" value="1" data-ing-qty="${i}" />
          <button type="button" class="primary-btn small add-ingredient-btn" data-idx="${i}">Add</button>
        </div>
      </div>`).join('')
    : `<div class="empty-hint">No matches.</div>`;
}

function openFoodEditor(food) {
  state.foodEditing = food ? { ...food } : null;
  const form = document.getElementById('food-form');
  form.reset();
  document.getElementById('food-editor-title').textContent = food ? 'Edit Food' : 'New Food';
  if (food) {
    form.name.value = food.name;
    form.servingDesc.value = food.servingDesc;
    fillNutritionFields(form, food);
  }
  openModal('food-editor-modal');
}

function openLogFoodModal(food, startQty = 1) {
  // Held as an object rather than an id, since built-in foods aren't stored.
  state.logFoodTarget = food;
  const form = document.getElementById('log-food-form');
  form.servingDesc.value = food.servingDesc || '1 serving';
  fillNutritionFields(form, food);
  primeAmountEditor('log-food', form.servingDesc.value);
  document.getElementById('log-food-title').textContent = `Log ${food.name}`;
  const qtyInput = document.getElementById('log-food-qty');
  qtyInput.value = startQty;
  // Keeps the grams box in step with a non-default starting quantity (a
  // shared meal's serving count, say), the same way typing a new qty would.
  qtyInput.dispatchEvent(new Event('input'));
  refreshAmountTotals('log-food');
  // Defaults to the meal whose + was tapped, when it was opened that way.
  document.getElementById('log-food-meal').value = state.pendingMeal || 'breakfast';
  openModal('log-food-modal');
}

// ---- Event wiring ----

// ---- Friends: shared board ----

let daySyncTimer = null;

// Debounced because it is called from renderToday, which runs on every
// keystroke-driven re-render. Also deduplicated: browsing back through old days
// re-renders each one, and there is no reason to rewrite a row that has not
// changed.
function queueDaySync(summary) {
  const fingerprint = JSON.stringify(summary);
  if (friends.lastPushed.get(summary.date) === fingerprint) return;

  clearTimeout(daySyncTimer);
  daySyncTimer = setTimeout(async () => {
    if (!(await groups.isJoined())) return;
    friends.lastPushed.set(summary.date, fingerprint);
    const result = await groups.pushDay(summary).catch(() => ({ sent: false }));
    friends.pending = result.pending || 0;
    // A failed send must not stick in lastPushed, or the retry never happens.
    if (!result.sent) friends.lastPushed.delete(summary.date);
    renderFriendsSyncState();
    if (result.sent && state.activeTab === 'friends') refreshBoard();
  }, 1500);
}

function timeAgo(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Posts either one item or everything logged in one meal (breakfast/lunch/
// dinner/snacks) to the group feed as a bundle - name(s), serving and full
// macros, plus the total. A single item is just a bundle of one; the feed and
// "Add to my diary" don't need to know the difference. This is a bigger
// privacy step than the day total is: specific foods you ate are now visible
// to the group, not just a count. It only ever happens from an explicit tap
// here, never automatically (unlike a member's profile, which shows all of it
// regardless - see README).
async function shareMealToGroup(mealKey, entryId) {
  if (!(await groups.isJoined())) return;
  const mealItems = state.diaryDay[mealKey];
  if (!mealItems || !mealItems.length) return;
  const items = entryId ? mealItems.filter(i => i.id === entryId) : mealItems;
  if (!items.length) return;
  try {
    await groups.postEvent({
      kind: 'meal',
      mealKey,
      items: items.map(i => ({
        name: i.name,
        servingDesc: i.servingDesc || '1 serving',
        qty: i.qty,
        calories: i.calories,
        protein: i.protein,
        carbs: i.carbs,
        fat: i.fat,
        fiber: i.fiber,
        sugar: i.sugar,
        sodium: i.sodium
      }))
    });
    if (state.activeTab === 'friends') refreshBoard();
  } catch (err) {
    alert(err.message || 'Could not share that to the group.');
  }
}

async function refreshBoard(showSpinner = false) {
  if (!(await groups.isJoined())) return;
  if (showSpinner) {
    friends.loading = true;
    renderFriends();
  }
  try {
    friends.board = await groups.board(state.currentDate);
    friends.error = '';
  } catch (err) {
    friends.error = err.message || 'Could not reach the group server';
  } finally {
    friends.loading = false;
    friends.pending = (await db.getOutbox()).length;
    renderFriends();
  }
}

// Polls only while the tab is actually on screen and the page is visible, so a
// backgrounded phone isn't making requests all day.
function updateFriendsPolling() {
  clearInterval(friends.pollTimer);
  friends.pollTimer = null;
  if (state.activeTab !== 'friends' || document.hidden) return;
  friends.pollTimer = setInterval(() => {
    if (document.hidden) return;
    groups.flush().then(r => { friends.pending = r.pending || 0; }).catch(() => {});
    refreshBoard();
  }, 30000);
}

function renderFriendsSyncState() {
  const el = document.getElementById('friends-sync-state');
  if (!el) return;
  if (friends.pending > 0) {
    el.textContent = `${friends.pending} update${friends.pending === 1 ? '' : 's'} waiting to send`;
    el.className = 'friends-sync-state warn';
  } else if (friends.error) {
    el.textContent = friends.error;
    el.className = 'friends-sync-state warn';
  } else if (friends.board) {
    el.textContent = `Up to date · ${formatDate(state.currentDate)}`;
    el.className = 'friends-sync-state';
  } else {
    el.textContent = '';
    el.className = 'friends-sync-state';
  }
}

function renderFriends() {
  const setup = document.getElementById('friends-setup');
  const board = document.getElementById('friends-board');
  if (!setup || !board) return;

  const joined = Boolean(friends.group && friends.group.serverUrl && friends.group.token && friends.group.groupId);
  setup.classList.toggle('hidden', joined);
  board.classList.toggle('hidden', !joined);
  if (!joined) return;

  document.getElementById('friends-group-name').textContent = friends.group.groupName || 'Your group';
  document.getElementById('friends-share-weighins').checked = Boolean(friends.group.shareWeighIns);
  renderFriendsSyncState();

  const membersEl = document.getElementById('friends-members');
  const data = friends.board;

  if (!data) {
    membersEl.innerHTML = friends.loading
      ? '<div class="empty-hint">Loading…</div>'
      : `<div class="empty-hint">${escapeHtml(friends.error || 'Pull to refresh when you have a connection.')}</div>`;
    document.getElementById('friends-feed').innerHTML = '';
    return;
  }

  document.getElementById('friends-photo-btn').classList.toggle('hidden', !data.photosEnabled);

  // The person who is furthest through their budget sorts last, so the top of
  // the list is whoever has room left. Anyone who hasn't logged goes to the
  // bottom rather than reading as though they ate nothing.
  const ranked = [...data.members].sort((a, b) => {
    if (a.logged !== b.logged) return a.logged ? -1 : 1;
    const pa = a.budget ? a.eaten / a.budget : 0;
    const pb = b.budget ? b.eaten / b.budget : 0;
    return pa - pb;
  });

  membersEl.innerHTML = ranked.map(m => {
    const allowance = m.budget + m.exercise;
    const remaining = allowance - m.eaten;
    const pct = allowance > 0 ? Math.min(100, Math.round((m.eaten / allowance) * 100)) : 0;
    const isMe = m.id === data.me.id;
    const over = remaining < 0;

    if (!m.logged) {
      return `
        <div class="friend-row quiet" data-member-id="${escapeAttr(m.id)}">
          <div class="friend-top">
            <span class="friend-who">${avatarHtml(m)}<span class="friend-name">${escapeHtml(m.name)}${isMe ? ' <span class="friend-you">you</span>' : ''}</span></span>
            <span class="friend-status">Nothing logged</span>
          </div>
          <div class="friend-track"><div class="friend-fill" style="width:0%"></div></div>
        </div>`;
    }
    return `
      <div class="friend-row" data-member-id="${escapeAttr(m.id)}">
        <div class="friend-top">
          <span class="friend-who">${avatarHtml(m)}<span class="friend-name">${escapeHtml(m.name)}${isMe ? ' <span class="friend-you">you</span>' : ''}</span></span>
          <span class="friend-status ${over ? 'over' : ''}">${over
            ? `${Math.abs(remaining).toLocaleString()} over`
            : `${remaining.toLocaleString()} left`}</span>
        </div>
        <div class="friend-track"><div class="friend-fill ${over ? 'over' : ''}" style="width:${pct}%"></div></div>
        <div class="friend-sub">${m.eaten.toLocaleString()} of ${allowance.toLocaleString()} cal · ${m.entries} item${m.entries === 1 ? '' : 's'}${m.exercise ? ` · ${m.exercise} from exercise` : ''} · ${timeAgo(m.updatedAt)}</div>
      </div>`;
  }).join('') || '<div class="empty-hint">Nobody here yet.</div>';

  // "Add to my diary" needs the exact shared macros back, not a re-parse of
  // the feed HTML, so keep them addressable by event id.
  friends.mealShares = {};

  const feedEl = document.getElementById('friends-feed');
  feedEl.innerHTML = data.events.length
    ? data.events.map(e => {
      const who = escapeHtml(e.memberName);
      const when = timeAgo(e.createdAt);
      if (e.kind === 'photo') {
        return `
          <div class="feed-item">
            <div class="feed-head"><strong>${who}</strong><span>${when}</span></div>
            ${e.text ? `<div class="feed-text">${escapeHtml(e.text)}</div>` : ''}
            ${e.photoKey ? `<img class="feed-photo" data-photo-key="${escapeHtml(e.photoKey)}" alt="Meal photo shared by ${who}" />` : ''}
            ${e.calories ? `<div class="feed-meta">${e.calories.toLocaleString()} cal</div>` : ''}
          </div>`;
      }
      if (e.kind === 'meal' && e.sharedMeal && e.sharedMeal.items.length) {
        const sm = e.sharedMeal;
        friends.mealShares[e.id] = sm;
        const mealLabelText = MEALS.find(m => m.key === sm.mealKey)?.label || sm.mealKey;
        // A single-item share and a whole-meal share use the same event shape
        // (a meal share is just a bundle of one or more items) - the only
        // difference shown here is the title and whether the one item is
        // repeated below it.
        const single = sm.items.length === 1;
        const title = single
          ? `${foodEmoji(sm.items[0].name)} ${escapeHtml(sm.items[0].name)}`
          : mealLabelText;
        const itemLines = single ? '' : sm.items.map(i =>
          `<div class="shared-meal-item">${foodEmoji(i.name)} ${escapeHtml(i.name)}${i.qty !== 1 ? ` · ${i.qty}×` : ''}</div>`
        ).join('');
        return `
          <div class="feed-item">
            <div class="feed-head"><strong>${who}</strong><span>${when}</span></div>
            <div class="entry-name">${title}</div>
            ${itemLines ? `<div class="shared-meal-items">${itemLines}</div>` : ''}
            <div class="feed-meta">${Math.round(sm.calories).toLocaleString()} cal · P${Math.round(sm.protein)} C${Math.round(sm.carbs)} F${Math.round(sm.fat)} · Fiber ${Math.round(sm.fiber)} · Sugar ${Math.round(sm.sugar)} · Na ${Math.round(sm.sodium)}mg</div>
            <button type="button" class="secondary-btn small add-shared-meal-btn" data-event-id="${e.id}">+ Add to my diary</button>
          </div>`;
      }
      const line = e.kind === 'joined'
        ? 'joined the group'
        : e.kind === 'weigh_in'
          ? `weighed in${e.text ? ` — ${escapeHtml(e.text)}` : ''}`
          : e.kind === 'day_done'
            ? `finished the day${e.text ? ` — ${escapeHtml(e.text)}` : ''}`
            : escapeHtml(e.text || '');
      return `
        <div class="feed-item slim">
          <div class="feed-line"><strong>${who}</strong> ${line}</div>
          <div class="feed-meta">${when}</div>
        </div>`;
    }).join('')
    : '<div class="empty-hint">Nothing shared yet.</div>';

  // Photos need an authenticated fetch, so they are filled in after the markup.
  feedEl.querySelectorAll('img[data-photo-key]').forEach(async img => {
    try {
      img.src = await groups.photoUrl(img.dataset.photoKey);
    } catch {
      img.remove();
    }
  });
}

// Which member's profile the sheet is currently showing, so the Save button
// knows who it's editing (always the signed-in member - the form is only
// ever shown on your own profile) without threading an id through it.
let profileMemberId = null;

// Opens the profile sheet for one member: their picture, their info line
// (editable only when it's your own), and every meal they've logged for the
// board's date, item by item. Unlike the meal-share feed, none of this needed
// a tap from them - it rides along on the same automatic sync as their day
// totals. See README.
function renderMemberProfile(memberId) {
  const data = friends.board;
  if (!data) return;
  const member = data.members.find(m => m.id === memberId);
  if (!member) return;
  profileMemberId = memberId;
  const isMe = member.id === data.me.id;

  document.getElementById('profile-name').textContent = member.name + (isMe ? ' (you)' : '');
  document.getElementById('profile-avatar').innerHTML = avatarHtml(member, 'large');

  const infoEl = document.getElementById('profile-info');
  infoEl.textContent = member.info || (isMe ? '' : 'No info yet.');
  infoEl.classList.toggle('placeholder', !member.info);

  document.getElementById('profile-edit').classList.toggle('hidden', !isMe);
  if (isMe) {
    document.getElementById('profile-avatar-input').value = member.avatar || '';
    document.getElementById('profile-info-input').value = member.info || '';
    document.getElementById('profile-save-status').textContent = '';
  }

  document.getElementById('profile-meals-title').textContent = `${formatDate(data.date)}'s meals`;
  const mealsEl = document.getElementById('profile-meals');
  const sections = MEALS.map(m => {
    const items = (member.items && member.items[m.key]) || [];
    if (!items.length) return '';
    const total = Math.round(items.reduce((s, i) => s + i.calories * i.qty, 0));
    // Seeing it here is automatic; copying it into your own diary is not - each
    // item and the meal as a whole get their own explicit "+ " action, same
    // shape as the feed's "Add to my diary" on a deliberately shared meal.
    const lines = items.map((i, idx) => `
      <div class="shared-meal-item">
        <span>${foodEmoji(i.name)} ${escapeHtml(i.name)}${i.qty !== 1 ? ` · ${i.qty}×` : ''}</span>
        ${isMe ? '' : `<button type="button" class="icon-btn small profile-add-item-btn" data-meal="${m.key}" data-item-index="${idx}" title="Add to my diary">+</button>`}
      </div>`
    ).join('');
    return `
      <div class="profile-meal">
        <div class="profile-meal-head"><strong>${m.label}</strong><span>${total.toLocaleString()} cal</span></div>
        <div class="shared-meal-items">${lines}</div>
        ${isMe ? '' : `<button type="button" class="secondary-btn small profile-add-meal-btn" data-meal="${m.key}">+ Add whole ${m.label.toLowerCase()} to my diary</button>`}
      </div>`;
  }).filter(Boolean).join('');
  mealsEl.innerHTML = sections || `<div class="empty-hint">${isMe ? "Nothing logged yet today." : "Nothing logged yet."}</div>`;

  openModal('member-profile-modal');
}

function fileToJpegBlob(file, maxEdge = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('Could not prepare that image'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That image could not be read. Try a different photo, or screenshot it first.'));
    };
    img.src = url;
  });
}

function wireFriends() {
  const status = document.getElementById('friends-setup-status');
  const setStatus = (text, bad) => {
    status.textContent = text;
    status.classList.toggle('negative', Boolean(bad));
  };

  async function setUp(action) {
    const serverUrl = document.getElementById('friends-server').value.trim();
    const memberName = document.getElementById('friends-name').value.trim();
    if (!serverUrl) return setStatus('Enter the server address first.', true);
    if (!memberName) return setStatus('Enter the name your friends will see.', true);

    setStatus('Contacting the server…');
    try {
      await groups.probe(serverUrl);
      if (action === 'create') {
        await groups.createGroup({ serverUrl, groupName: `${memberName}'s group`, memberName });
      } else {
        const joinCode = document.getElementById('friends-code').value.trim();
        if (!joinCode) return setStatus('Enter the join code your friend sent you.', true);
        await groups.joinGroup({ serverUrl, joinCode, memberName });
      }
      friends.group = await db.getGroup();
      friends.lastPushed.clear();
      setStatus('');
      renderFriends();
      // Push today's numbers straight away so the board isn't empty on arrival.
      renderToday();
      await refreshBoard(true);
      if (action === 'create') openModal('invite-modal');
    } catch (err) {
      setStatus(err.message || 'Could not reach that server.', true);
    }
  }

  document.getElementById('friends-create-btn').addEventListener('click', () => setUp('create'));
  document.getElementById('friends-join-btn').addEventListener('click', () => setUp('join'));
  document.getElementById('friends-refresh-btn').addEventListener('click', async () => {
    await groups.flush().catch(() => {});
    refreshBoard(true);
  });

  document.getElementById('friends-members').addEventListener('click', e => {
    const row = e.target.closest('.friend-row');
    if (!row) return;
    renderMemberProfile(row.dataset.memberId);
  });

  document.getElementById('profile-save-btn').addEventListener('click', async () => {
    if (!profileMemberId) return;
    const avatar = document.getElementById('profile-avatar-input').value.trim();
    const info = document.getElementById('profile-info-input').value.trim();
    const btn = document.getElementById('profile-save-btn');
    const statusEl = document.getElementById('profile-save-status');
    btn.disabled = true;
    statusEl.textContent = '';
    try {
      await groups.saveProfile({ avatar, info });
      // Updates the board in place so the sheet and the member list both
      // reflect the change immediately, without waiting on a re-fetch.
      const member = friends.board?.members.find(m => m.id === profileMemberId);
      if (member) { member.avatar = avatar; member.info = info; }
      renderMemberProfile(profileMemberId);
      document.getElementById('profile-save-status').textContent = 'Saved';
      renderFriends();
    } catch (err) {
      statusEl.textContent = err.message || 'Could not save that.';
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('profile-meals').addEventListener('click', async e => {
    const member = friends.board?.members.find(m => m.id === profileMemberId);
    if (!member) return;

    const itemBtn = e.target.closest('.profile-add-item-btn');
    if (itemBtn) {
      const meal = itemBtn.dataset.meal;
      const item = (member.items?.[meal] || [])[Number(itemBtn.dataset.itemIndex)];
      if (!item) return;
      if (!confirm(`Add "${item.name}" to your diary today?`)) return;
      await db.addDiaryEntry(state.currentDate, meal, item);
      await loadDayData();
      closeModal('member-profile-modal');
      state.activeTab = 'today';
      render();
      return;
    }

    const mealBtn = e.target.closest('.profile-add-meal-btn');
    if (mealBtn) {
      const meal = mealBtn.dataset.meal;
      const items = member.items?.[meal] || [];
      if (!items.length) return;
      const label = MEALS.find(m => m.key === meal)?.label || meal;
      if (!confirm(`Add all ${items.length} item${items.length === 1 ? '' : 's'} from ${member.name}'s ${label.toLowerCase()} to your own diary today?`)) return;
      for (const item of items) {
        await db.addDiaryEntry(state.currentDate, meal, item);
      }
      await loadDayData();
      closeModal('member-profile-modal');
      state.activeTab = 'today';
      render();
    }
  });

  document.getElementById('friends-feed').addEventListener('click', async e => {
    const btn = e.target.closest('.add-shared-meal-btn');
    if (!btn) return;
    const sm = friends.mealShares[btn.dataset.eventId];
    if (!sm || !sm.items.length) return;
    const mealLabelText = MEALS.find(m => m.key === sm.mealKey)?.label || sm.mealKey;
    const confirmText = sm.items.length === 1
      ? `Add "${sm.items[0].name}" to your ${mealLabelText.toLowerCase()} today?`
      : `Add all ${sm.items.length} items from this ${mealLabelText} to your own diary today?`;
    if (!confirm(confirmText)) return;
    for (const item of sm.items) {
      await db.addDiaryEntry(state.currentDate, sm.mealKey, item);
    }
    await loadDayData();
    state.activeTab = 'today';
    render();
  });

  document.getElementById('friends-invite-btn').addEventListener('click', () => {
    document.getElementById('invite-server').textContent = friends.group.serverUrl;
    document.getElementById('invite-code').textContent = friends.group.joinCode;
    openModal('invite-modal');
  });

  document.getElementById('invite-copy-btn').addEventListener('click', async () => {
    const text = `Join my calorie group\nServer: ${friends.group.serverUrl}\nCode: ${friends.group.joinCode}`;
    const btn = document.getElementById('invite-copy-btn');
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      // Clipboard is blocked in some in-app browsers; the values are on screen.
      btn.textContent = 'Copy failed — read them off the screen';
    }
    setTimeout(() => { btn.textContent = 'Copy both'; }, 2500);
  });

  document.getElementById('friends-share-weighins').addEventListener('change', async e => {
    friends.group = await db.saveGroup({ shareWeighIns: e.target.checked, shareWeighInsSet: true });
  });

  document.getElementById('friends-leave-btn').addEventListener('click', async () => {
    if (!confirm('Leave this group? Your shared numbers and posts are deleted from the server. Your diary on this phone is untouched.')) return;
    await groups.leave();
    friends.group = await db.getGroup();
    friends.board = null;
    friends.lastPushed.clear();
    renderFriends();
  });

  const photoInput = document.getElementById('friends-photo-input');
  document.getElementById('friends-photo-btn').addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const btn = document.getElementById('friends-photo-btn');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sharing…';
    try {
      const blob = await fileToJpegBlob(file);
      const { key } = await groups.uploadPhoto(blob);
      const caption = prompt('Say something about it (optional)') || '';
      await groups.postEvent({ kind: 'photo', photoKey: key, text: caption.trim() || null });
      await refreshBoard();
    } catch (err) {
      alert(err.message || 'Could not share that photo.');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
      e.target.value = '';
    }
  });

  document.addEventListener('visibilitychange', () => {
    updateFriendsPolling();
    if (!document.hidden) {
      groups.flush().then(r => { friends.pending = r.pending || 0; renderFriendsSyncState(); }).catch(() => {});
    }
  });
  window.addEventListener('online', () => {
    groups.flush().then(r => {
      friends.pending = r.pending || 0;
      renderFriendsSyncState();
      if (state.activeTab === 'friends') refreshBoard();
    }).catch(() => {});
  });
}

function wireEvents() {
  document.querySelectorAll('.tabbar button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.settings.onboarded && btn.dataset.tab !== 'settings') return;
      state.activeTab = btn.dataset.tab;
      if (state.activeTab === 'friends') {
        groups.flush().catch(() => {});
        refreshBoard(!friends.board);
      }
      updateFriendsPolling();
      render();
    });
  });

  document.getElementById('diary-prev-btn').addEventListener('click', async () => {
    state.currentDate = shiftDate(state.currentDate, -1);
    await loadDayData();
    render();
  });
  document.getElementById('diary-next-btn').addEventListener('click', async () => {
    if (state.currentDate === todayStr()) return;
    state.currentDate = shiftDate(state.currentDate, 1);
    await loadDayData();
    render();
  });

  document.querySelectorAll('.add-meal-btn').forEach(btn => {
    btn.addEventListener('click', () => openAddEntryModal(btn.dataset.meal));
  });

  document.getElementById('today-panel').addEventListener('click', async e => {
    const openBtn = e.target.closest('.entry-open');
    if (openBtn) {
      const meal = openBtn.dataset.meal;
      const entry = state.diaryDay[meal].find(i => i.id === openBtn.dataset.entryId);
      if (entry) openEntryEditor(meal, entry);
      return;
    }
    const summaryBtn = e.target.closest('.meal-summary-toggle');
    if (summaryBtn) {
      const key = summaryBtn.dataset.meal;
      state.mealSummaryOpen[key] = !state.mealSummaryOpen[key];
      renderToday();
      return;
    }
    const mealShareBtn = e.target.closest('.meal-share-btn');
    if (mealShareBtn) {
      const key = mealShareBtn.dataset.meal;
      const count = state.diaryDay[key].length;
      const label = MEALS.find(m => m.key === key)?.label || key;
      if (confirm(`Share your ${label} (${count} item${count === 1 ? '' : 's'}) with the group?`)) {
        await shareMealToGroup(key);
      }
      return;
    }
    const itemShareBtn = e.target.closest('.share-entry-btn');
    if (itemShareBtn) {
      const meal = itemShareBtn.dataset.meal;
      const entry = state.diaryDay[meal].find(i => i.id === itemShareBtn.dataset.entryId);
      if (entry && confirm(`Share "${entry.name}" with the group?`)) {
        await shareMealToGroup(meal, entry.id);
      }
      return;
    }
    const removeBtn = e.target.closest('.remove-entry-btn');
    if (removeBtn) {
      await db.deleteDiaryEntry(state.currentDate, removeBtn.dataset.meal, removeBtn.dataset.entryId);
      await loadDayData();
      render();
      return;
    }
    const removeEx = e.target.closest('.remove-exercise-btn');
    if (removeEx) {
      await db.deleteExerciseEntry(state.currentDate, removeEx.dataset.entryId);
      await loadDayData();
      render();
    }
  });

  document.getElementById('add-exercise-btn').addEventListener('click', () => {
    document.getElementById('exercise-form').reset();
    openModal('add-exercise-modal');
  });
  document.getElementById('exercise-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    await db.addExerciseEntry(state.currentDate, { name: form.name.value.trim() || 'Exercise', calories: form.calories.value });
    closeModal('add-exercise-modal');
    await loadDayData();
    render();
  });

  // Add-entry modal: tabs
  document.getElementById('add-entry-tab-search').addEventListener('click', () => {
    document.getElementById('add-entry-tab-search').classList.add('active');
    document.getElementById('add-entry-tab-quick').classList.remove('active');
    document.getElementById('add-entry-pane-search').classList.remove('hidden');
    document.getElementById('add-entry-pane-quick').classList.add('hidden');
  });
  document.getElementById('add-entry-tab-quick').addEventListener('click', () => {
    document.getElementById('add-entry-tab-quick').classList.add('active');
    document.getElementById('add-entry-tab-search').classList.remove('active');
    document.getElementById('add-entry-pane-quick').classList.remove('hidden');
    document.getElementById('add-entry-pane-search').classList.add('hidden');
  });
  document.getElementById('add-entry-search').addEventListener('input', e => {
    // Online hits belong to the query that fetched them.
    state.searchResults = [];
    document.getElementById('add-entry-modal').classList.toggle('has-query', !!e.target.value.trim());
    renderAddEntryFoodList(e.target.value);
  });

  // While a search box has focus the sheet goes full height and sheds the
  // buttons above the list, so the query and its results stay on screen.
  [['add-entry-search', 'add-entry-modal'], ['recipe-ingredient-search', 'recipe-editor-modal']]
    .forEach(([inputId, modalId]) => {
      const input = document.getElementById(inputId);
      const modal = document.getElementById(modalId);
      input.addEventListener('focus', () => modal.classList.add('searching'));
    });
  document.getElementById('search-online-btn').addEventListener('click', async () => {
    const query = document.getElementById('add-entry-search').value.trim();
    const status = document.getElementById('add-entry-status');
    if (!query) {
      status.textContent = 'Type something to search for first.';
      status.classList.remove('hidden');
      return;
    }
    status.textContent = 'Searching branded foods…';
    status.classList.remove('hidden');
    try {
      state.searchResults = await searchOnlineFoods(query);
      status.textContent = state.searchResults.length
        ? `Found ${state.searchResults.length} branded ${state.searchResults.length === 1 ? 'result' : 'results'}.`
        : 'No branded results for that search.';
    } catch {
      state.searchResults = [];
      status.textContent = 'Could not search online — check your connection.';
    }
    renderAddEntryFoodList(query);
  });
  document.getElementById('add-entry-food-list').addEventListener('click', async e => {
    const openBtn = e.target.closest('.pick-open');
    if (openBtn) {
      const food = state.visibleResults[Number(openBtn.dataset.idx)];
      if (food) openLogFoodModal(food);
      return;
    }
    const addBtn = e.target.closest('.add-picked-food-btn');
    if (!addBtn) return;
    const food = state.visibleResults[Number(addBtn.dataset.idx)];
    if (!food) return;
    const qtyInput = document.querySelector(`.qty-input[data-idx="${addBtn.dataset.idx}"]`);
    const qty = Number(qtyInput.value) || 1;
    const meal = document.getElementById('add-entry-modal').dataset.meal;
    await db.addDiaryEntry(state.currentDate, meal, { ...food, qty });
    // Anything picked from the built-in list or online is worth keeping, so it
    // is one tap away next time without another search. Matching on name keeps
    // repeat logging of the same food from stacking up duplicates.
    const alreadySaved = state.foods.some(f => f.name.toLowerCase() === food.name.toLowerCase());
    if (food.source !== 'mine' && !alreadySaved) {
      await db.addFood(food);
      state.foods = await db.getFoods();
    }
    closeModal('add-entry-modal');
    await loadDayData();
    render();
  });
  document.getElementById('quick-add-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const meal = document.getElementById('add-entry-modal').dataset.meal;
    await db.addDiaryEntry(state.currentDate, meal, {
      name: form.name.value.trim() || 'Food',
      qty: 1,
      calories: form.calories.value,
      protein: form.protein.value || 0,
      carbs: form.carbs.value || 0,
      fat: form.fat.value || 0
    });
    closeModal('add-entry-modal');
    await loadDayData();
    render();
  });

  // Foods / Recipes toggle
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const showRecipes = btn.dataset.section === 'recipes';
      document.getElementById('seg-foods').classList.toggle('active', !showRecipes);
      document.getElementById('seg-recipes').classList.toggle('active', showRecipes);
      document.getElementById('foods-section').classList.toggle('hidden', showRecipes);
      document.getElementById('recipes-section').classList.toggle('hidden', !showRecipes);
    });
  });

  // Eating-out suggestions
  document.getElementById('suggest-btn').addEventListener('click', () => {
    state.suggestBrand = 'all';
    state.suggestSearch = '';
    document.getElementById('suggest-search').value = '';
    renderSuggestBrands();
    renderSuggestions();
    openModal('suggest-modal');
  });
  document.getElementById('suggest-brands').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.suggestBrand = chip.dataset.brand;
    renderSuggestBrands();
    renderSuggestions();
  });
  document.getElementById('suggest-search').addEventListener('input', e => {
    state.suggestSearch = e.target.value;
    renderSuggestions();
  });
  document.getElementById('suggest-list').addEventListener('click', e => {
    const btn = e.target.closest('.suggest-open');
    if (!btn) return;
    const food = state.suggestRows[Number(btn.dataset.idx)];
    if (!food) return;
    state.pendingMeal = null; // suggestions are not tied to a particular meal
    openLogFoodModal(food);
  });

  // Barcode scanning
  document.getElementById('scan-btn').addEventListener('click', async () => {
    document.getElementById('manual-barcode').value = '';
    openModal('scan-modal');
    await startScanner();
  });
  document.getElementById('manual-barcode-form').addEventListener('submit', async e => {
    e.preventDefault();
    const code = document.getElementById('manual-barcode').value.trim();
    if (code) await handleBarcode(code);
  });
  document.querySelectorAll('[data-close-modal="scan-modal"]').forEach(el => {
    el.addEventListener('click', () => stopScanner());
  });

  // Photo estimate
  document.getElementById('photo-btn').addEventListener('click', () => {
    const hasKey = !!(state.settings.apiKey || '').trim();
    document.getElementById('photo-status').textContent = hasKey ? '' : 'Not set up yet — see below.';
    document.getElementById('photo-setup').classList.toggle('hidden', hasKey);
    document.getElementById('photo-input').value = '';
    openModal('photo-modal');
  });

  document.getElementById('test-key-btn').addEventListener('click', async () => {
    const status = document.getElementById('test-key-status');
    const key = document.getElementById('settings-form').apiKey.value.trim();
    if (!key) {
      status.textContent = 'Paste a key above first.';
      return;
    }
    status.textContent = 'Checking…';
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with the word ok.' }]
        })
      });
      if (res.ok) {
        status.textContent = 'Key works. Save your settings and photo estimates are ready.';
      } else {
        const detail = await res.json().catch(() => null);
        const msg = detail?.error?.message || `HTTP ${res.status}`;
        status.textContent = res.status === 401
          ? 'That key was rejected — check you copied all of it.'
          : `Anthropic said: ${msg}`;
      }
    } catch {
      status.textContent = 'Could not reach Anthropic — check your connection.';
    }
  });
  document.getElementById('photo-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (file) await runPhotoEstimate(file);
  });

  // Confirm sheet shared by scanning and photo estimates
  document.getElementById('confirm-food-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const qty = Number(document.getElementById('confirm-food-qty').value) || 1;
    const meal = document.getElementById('confirm-food-meal').value;
    const food = {
      name: state.confirmFood.name,
      servingDesc: form.servingDesc.value.trim() || '1 serving',
      ...readNutritionFields(form)
    };
    await db.addDiaryEntry(state.currentDate, meal, { ...food, qty });
    const alreadySaved = state.foods.some(f => f.name.toLowerCase() === food.name.toLowerCase());
    if (!alreadySaved) {
      await db.addFood(food);
      state.foods = await db.getFoods();
    }
    closeAllModals();
    await loadDayData();
    render();
  });

  // Recipes
  document.getElementById('new-recipe-btn').addEventListener('click', () => openRecipeEditor(null));
  document.getElementById('recipes-list').addEventListener('click', async e => {
    const id = e.target.closest('[data-recipe-id]')?.dataset.recipeId;
    if (!id) return;
    const recipe = state.recipes.find(r => r.id === id);
    if (!recipe) return;
    if (e.target.closest('.log-recipe-btn')) {
      const { perServing } = recipeTotals(recipe);
      openLogFoodModal({
        name: recipe.name,
        servingDesc: '1 serving',
        ...perServing,
        source: 'recipe'
      });
    } else if (e.target.closest('.edit-recipe-btn')) {
      openRecipeEditor(recipe);
    } else if (e.target.closest('.delete-recipe-btn')) {
      if (!confirm(`Delete "${recipe.name}"?`)) return;
      await db.deleteRecipe(id);
      state.recipes = await db.getRecipes();
      renderRecipes();
    }
  });
  document.getElementById('recipe-ingredient-search').addEventListener('input', e =>
    renderRecipeIngredientPicker(e.target.value));
  document.getElementById('recipe-ingredient-list').addEventListener('click', e => {
    const btn = e.target.closest('.add-ingredient-btn');
    if (!btn) return;
    const food = state.recipePickerRows[Number(btn.dataset.idx)];
    if (!food) return;
    const qtyInput = document.querySelector(`[data-ing-qty="${btn.dataset.idx}"]`);
    state.recipeDraft.ingredients.push({
      name: food.name,
      qty: Number(qtyInput.value) || 1,
      calories: food.calories,
      protein: food.protein,
      carbs: food.carbs,
      fat: food.fat,
      fiber: food.fiber || 0,
      sugar: food.sugar || 0,
      sodium: food.sodium || 0
    });
    renderRecipeDraft();
  });
  document.getElementById('recipe-ingredients').addEventListener('click', e => {
    const btn = e.target.closest('.remove-ingredient-btn');
    if (!btn) return;
    state.recipeDraft.ingredients.splice(Number(btn.dataset.idx), 1);
    renderRecipeDraft();
  });
  document.getElementById('recipe-form').addEventListener('input', e => {
    if (e.target.name === 'servings') renderRecipeDraft();
  });
  document.getElementById('recipe-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    if (!state.recipeDraft.ingredients.length) {
      alert('Add at least one ingredient first.');
      return;
    }
    const payload = {
      name: form.name.value.trim() || 'Recipe',
      servings: Math.max(Number(form.servings.value) || 1, 0.25),
      ingredients: state.recipeDraft.ingredients
    };
    if (state.recipeDraft.id) await db.updateRecipe(state.recipeDraft.id, payload);
    else await db.addRecipe(payload);
    state.recipeDraft = null;
    closeModal('recipe-editor-modal');
    state.recipes = await db.getRecipes();
    renderRecipes();
  });

  // Foods tab
  document.getElementById('food-search').addEventListener('input', e => {
    state.foodSearch = e.target.value;
    renderFoods();
  });
  document.getElementById('new-food-btn').addEventListener('click', () => openFoodEditor(null));
  document.getElementById('foods-list').addEventListener('click', async e => {
    const idx = e.target.closest('[data-idx]')?.dataset.idx;
    if (idx == null) return;
    const food = state.visibleFoodRows[Number(idx)];
    if (!food) return;
    if (e.target.closest('.log-food-btn')) openLogFoodModal(food);
    else if (e.target.closest('.edit-food-btn')) openFoodEditor(food);
    else if (e.target.closest('.delete-food-btn')) {
      if (!confirm(`Delete "${food.name}"?`)) return;
      await db.deleteFood(food.id);
      state.foods = await db.getFoods();
      renderFoods();
    }
  });
  document.getElementById('food-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      name: form.name.value.trim() || 'Food',
      servingDesc: form.servingDesc.value.trim() || '1 serving',
      calories: form.calories.value,
      protein: form.protein.value || 0,
      carbs: form.carbs.value || 0,
      fat: form.fat.value || 0,
      fiber: form.fiber.value || 0,
      sugar: form.sugar.value || 0,
      sodium: form.sodium.value || 0
    };
    if (state.foodEditing) await db.updateFood(state.foodEditing.id, payload);
    else await db.addFood(payload);
    state.foodEditing = null;
    closeModal('food-editor-modal');
    state.foods = await db.getFoods();
    renderFoods();
  });
  document.getElementById('log-food-form').addEventListener('submit', async e => {
    e.preventDefault();
    const target = state.logFoodTarget;
    if (!target) return;
    const form = e.target;
    const qty = Number(document.getElementById('log-food-qty').value) || 1;
    const meal = document.getElementById('log-food-meal').value;
    // Log whatever is in the form, so per-serving edits made here are kept.
    const food = {
      name: target.name,
      servingDesc: form.servingDesc.value.trim() || '1 serving',
      ...readNutritionFields(form)
    };
    await db.addDiaryEntry(state.currentDate, meal, { ...food, qty });
    const alreadySaved = state.foods.some(f => f.name.toLowerCase() === food.name.toLowerCase());
    if (target.source !== 'mine' && !alreadySaved) {
      await db.addFood(food);
      state.foods = await db.getFoods();
    }
    closeAllModals();
    await loadDayData();
    render();
  });

  // Live scaling: changing servings or grams repaints the totals in each editor.
  ['edit-entry', 'log-food', 'confirm-food'].forEach(prefix => wireGramsAndServings(prefix));

  document.getElementById('edit-entry-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const { meal, id } = state.editingEntry;
    const newMeal = document.getElementById('edit-entry-meal').value;
    const patch = {
      name: form.name.value.trim() || 'Food',
      servingDesc: form.servingDesc.value.trim() || '1 serving',
      qty: Number(document.getElementById('edit-entry-qty').value) || 0,
      ...readNutritionFields(form)
    };
    if (newMeal === meal) {
      await db.updateDiaryEntry(state.currentDate, meal, id, patch);
    } else {
      // Moving meals is a delete plus an add, since entries live under a meal.
      await db.deleteDiaryEntry(state.currentDate, meal, id);
      await db.addDiaryEntry(state.currentDate, newMeal, patch);
    }
    state.editingEntry = null;
    closeModal('edit-entry-modal');
    await loadDayData();
    render();
  });

  document.getElementById('edit-entry-delete').addEventListener('click', async () => {
    const { meal, id } = state.editingEntry || {};
    if (!id) return;
    await db.deleteDiaryEntry(state.currentDate, meal, id);
    state.editingEntry = null;
    closeModal('edit-entry-modal');
    await loadDayData();
    render();
  });

  // Weight tab
  document.getElementById('weight-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const units = state.settings.units;
    const val = Number(form.value.value);
    if (!val) return;
    const weightKg = units === 'metric' ? val : lbToKg(val);
    const date = form.date.value || todayStr();
    await db.addWeightEntry(date, weightKg);
    state.settings = await db.getSettings();
    state.weightLog = await db.getWeightLog();
    if (friends.group && friends.group.shareWeighIns) {
      groups.postEvent({
        kind: 'weigh_in',
        text: `${displayWeight(weightKg, units)} ${weightUnitLabel(units)}`
      }).catch(() => {});
    }
    form.reset();
    // The date field is required, but reset() clears it to blank rather than
    // back to today (it was only ever set as a JS property, not an HTML
    // default), so a second weigh-in logged in the same session would fail
    // native validation silently - the submit handler simply never runs
    // again until the field is manually refilled.
    form.date.valueAsDate = new Date();
    render();
  });
  document.getElementById('weight-date').valueAsDate = new Date();
  document.getElementById('weight-list').addEventListener('click', async e => {
    const btn = e.target.closest('.delete-weight-btn');
    if (!btn) return;
    await db.deleteWeightEntry(btn.dataset.entryId);
    state.weightLog = await db.getWeightLog();
    renderWeight();
  });

  // Settings / TDEE calculator
  const settingsForm = document.getElementById('settings-form');
  settingsForm.addEventListener('input', () => updateSettingsPreview());
  settingsForm.theme.addEventListener('change', e => applyTheme(e.target.value));
  settingsForm.units.addEventListener('change', e => convertAndSwitchUnits(e.target.value));
  settingsForm.addEventListener('submit', async e => {
    e.preventDefault();
    const patch = readSettingsFromForm();
    state.settings = await db.saveSettings(patch);
    state.weightLog = await db.getWeightLog();
    if (state.activeTab === 'settings') {
      state.activeTab = 'today';
    }
    await loadDayData();
    render();
  });

  // Generic modal close buttons / backdrop taps
  document.querySelectorAll('[data-close-modal]').forEach(el => {
    el.addEventListener('click', () => closeModal(el.dataset.closeModal));
  });

  // Backup / restore
  document.getElementById('data-btn').addEventListener('click', () => {
    const stamped = BUILD_ID !== '__BUILD' + '_ID__';
    document.getElementById('build-stamp').textContent = stamped
      ? `Version ${BUILD_ID.slice(0, 7)}`
      : 'Version: running locally';
    openModal('data-modal');
  });
  document.getElementById('export-btn').addEventListener('click', async () => {
    const data = await db.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `calorie-counter-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  document.getElementById('import-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = await db.importData(JSON.parse(text));
      alert(`Restored ${result.foods} foods, ${result.days} logged days, ${result.weightEntries} weigh-ins.`);
      closeModal('data-modal');
      await refreshAll();
    } catch (err) {
      alert(err.message || 'Could not read that backup file.');
    } finally {
      e.target.value = '';
    }
  });
}

(async function init() {
  // Set the theme before the first render so a light-mode user doesn't get a
  // flash of the dark default while the rest of the state loads.
  applyTheme((await db.getSettings()).theme || 'dark');
  // Keep the browser-chrome tint right if the phone flips light/dark while the
  // app is open and the user is on "Match my phone".
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme(state.settings.theme || 'dark');
  });
  wireEvents();
  wireFriends();
  await refreshAll();
  // Deliver anything that was queued while the app was closed.
  groups.flush().then(r => {
    friends.pending = r.pending || 0;
    renderFriendsSyncState();
  }).catch(() => {});
})();
