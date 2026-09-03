// Replaced with the commit sha at deploy time, the same way the service worker
// is stamped. Shown in the backup sheet so the running version can be checked
// against what was last deployed.
const BUILD_ID = '__BUILD_ID__';

const MEALS = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
  { key: 'snacks', label: 'Snacks' }
];

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
  state.foods = await db.getFoods();
  state.weightLog = await db.getWeightLog();
  state.recipes = await db.getRecipes();
  await loadDayData();
  render();
}

// ---- Rendering ----
function render() {
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
  renderFoods();
  renderRecipes();
  renderWeight();
  populateSettingsForm();
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

  const pct = goals.goalCalories > 0 ? Math.min(100, Math.round((eaten.calories / goals.goalCalories) * 100)) : 0;
  document.getElementById('budget-ring').style.setProperty('--pct', pct);

  renderMacroBar('protein', eaten.protein, goals.macros.proteinG);
  renderMacroBar('carbs', eaten.carbs, goals.macros.carbsG);
  renderMacroBar('fat', eaten.fat, goals.macros.fatG);

  MEALS.forEach(m => {
    const items = state.diaryDay[m.key];
    const total = Math.round(items.reduce((s, i) => s + i.calories * i.qty, 0));
    const list = document.getElementById(`meal-${m.key}-list`);
    document.getElementById(`meal-${m.key}-total`).textContent = `${total.toLocaleString()} cal`;
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
          <button class="icon-btn small remove-entry-btn" data-meal="${m.key}" data-entry-id="${i.id}" title="Remove">✕</button>
        </div>`;
      }).join('')
      : `<div class="empty-hint">No items logged</div>`;
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

  document.getElementById('weight-chart').innerHTML = buildWeightChart(log, units);

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
  modal.classList.remove('searching');
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
    fat: round(base.fat)
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
    fat: form.fat.value
  }, qty);
  document.getElementById(`${prefix}-totals`).textContent =
    `${totals.calories} cal · P${totals.protein} C${totals.carbs} F${totals.fat}`;
  return totals;
}

// Keeps the grams box and the servings box describing the same amount.
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
  ['calories', 'protein', 'carbs', 'fat'].forEach(name => {
    form[name].addEventListener('input', () => refreshAmountTotals(prefix));
  });
  form.servingDesc.addEventListener('input', () => {
    if (gramsRow) gramsRow.classList.toggle('hidden', !basis());
    syncFromQty();
  });

  return { syncFromQty, showGrams: () => {
    if (gramsRow) gramsRow.classList.toggle('hidden', !basis());
  } };
}

function openEntryEditor(meal, entry) {
  state.editingEntry = { meal, id: entry.id };
  const form = document.getElementById('edit-entry-form');
  form.name.value = entry.name;
  form.servingDesc.value = entry.servingDesc || '1 serving';
  form.calories.value = entry.calories;
  form.protein.value = entry.protein;
  form.carbs.value = entry.carbs;
  form.fat.value = entry.fat;
  document.getElementById('edit-entry-qty').value = entry.qty;
  document.getElementById('edit-entry-meal').value = meal;

  const grams = parseServingGrams(entry.servingDesc);
  document.getElementById('edit-entry-grams-row').classList.toggle('hidden', !grams);
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
  form.calories.value = food.calories;
  form.protein.value = food.protein;
  form.carbs.value = food.carbs;
  form.fat.value = food.fat;
  form.servingDesc.value = food.servingDesc;
  document.getElementById('confirm-food-qty').value = 1;
  const grams = parseServingGrams(food.servingDesc);
  document.getElementById('confirm-food-grams-row').classList.toggle('hidden', !grams);
  if (grams) document.getElementById('confirm-food-grams').value = grams;
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
    fat: acc.fat + i.fat * i.qty
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const servings = Math.max(recipe.servings || 1, 0.25);
  return {
    total: totals,
    perServing: {
      calories: Math.round(totals.calories / servings),
      protein: Math.round((totals.protein / servings) * 10) / 10,
      carbs: Math.round((totals.carbs / servings) * 10) / 10,
      fat: Math.round((totals.fat / servings) * 10) / 10
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
    form.calories.value = food.calories;
    form.protein.value = food.protein;
    form.carbs.value = food.carbs;
    form.fat.value = food.fat;
  }
  openModal('food-editor-modal');
}

function openLogFoodModal(food) {
  // Held as an object rather than an id, since built-in foods aren't stored.
  state.logFoodTarget = food;
  const form = document.getElementById('log-food-form');
  form.servingDesc.value = food.servingDesc || '1 serving';
  form.calories.value = food.calories;
  form.protein.value = food.protein;
  form.carbs.value = food.carbs;
  form.fat.value = food.fat;
  const grams = parseServingGrams(food.servingDesc);
  document.getElementById('log-food-grams-row').classList.toggle('hidden', !grams);
  if (grams) document.getElementById('log-food-grams').value = grams;
  document.getElementById('log-food-title').textContent = `Log ${food.name}`;
  document.getElementById('log-food-qty').value = 1;
  refreshAmountTotals('log-food');
  // Defaults to the meal whose + was tapped, when it was opened that way.
  document.getElementById('log-food-meal').value = state.pendingMeal || 'breakfast';
  openModal('log-food-modal');
}

// ---- Event wiring ----
function wireEvents() {
  document.querySelectorAll('.tabbar button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.settings.onboarded && btn.dataset.tab !== 'settings') return;
      state.activeTab = btn.dataset.tab;
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
      calories: Number(form.calories.value) || 0,
      protein: Number(form.protein.value) || 0,
      carbs: Number(form.carbs.value) || 0,
      fat: Number(form.fat.value) || 0
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
      fat: food.fat
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
      fat: form.fat.value || 0
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
      calories: Number(form.calories.value) || 0,
      protein: Number(form.protein.value) || 0,
      carbs: Number(form.carbs.value) || 0,
      fat: Number(form.fat.value) || 0
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
      calories: Number(form.calories.value) || 0,
      protein: Number(form.protein.value) || 0,
      carbs: Number(form.carbs.value) || 0,
      fat: Number(form.fat.value) || 0
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
    form.reset();
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
  wireEvents();
  await refreshAll();
})();
