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
  visibleResults: [] // exactly what the picker last rendered, indexed by row
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
      ? items.map(i => `
        <div class="entry-row" data-entry-id="${i.id}" data-meal="${m.key}">
          <div class="entry-info">
            <div class="entry-name">${escapeHtml(i.name)}</div>
            <div class="entry-sub">${i.qty !== 1 ? `${i.qty}× · ` : ''}${Math.round(i.calories * i.qty)} cal</div>
          </div>
          <button class="icon-btn small remove-entry-btn" data-meal="${m.key}" data-entry-id="${i.id}" title="Remove">✕</button>
        </div>`).join('')
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

function renderFoods() {
  const q = state.foodSearch.trim().toLowerCase();
  const list = state.foods.filter(f => !q || f.name.toLowerCase().includes(q));
  const container = document.getElementById('foods-list');
  container.innerHTML = list.length
    ? list.map(f => `
      <div class="food-row" data-food-id="${f.id}">
        <div class="entry-info">
          <div class="entry-name">${escapeHtml(f.name)}</div>
          <div class="entry-sub">${escapeHtml(f.servingDesc)} · ${f.calories} cal · P${f.protein} C${f.carbs} F${f.fat}</div>
        </div>
        <div class="food-actions">
          <button class="secondary-btn small log-food-btn" data-food-id="${f.id}">Log</button>
          <button class="icon-btn small edit-food-btn" data-food-id="${f.id}" title="Edit">✎</button>
          <button class="icon-btn small delete-food-btn" data-food-id="${f.id}" title="Delete">✕</button>
        </div>
      </div>`).join('')
    : `<div class="empty-hint">${state.foods.length ? 'No foods match your search' : 'No foods yet — add one below'}</div>`;
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
    calorieOverride: form.calorieOverride.value ? Number(form.calorieOverride.value) : null
  };
}

// ---- Modals ----
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function openAddEntryModal(meal) {
  const modal = document.getElementById('add-entry-modal');
  modal.dataset.meal = meal;
  document.getElementById('add-entry-title').textContent = `Add to ${MEALS.find(m => m.key === meal).label}`;
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
  if (!q) return state.foods.map(f => ({ ...f, source: 'mine' }));
  const mine = state.foods
    .filter(f => f.name.toLowerCase().includes(q))
    .map(f => ({ ...f, source: 'mine' }));
  const builtIn = FOOD_DB
    .filter(f => f.name.toLowerCase().includes(q))
    .map(f => ({ ...f, source: 'db' }));
  return [...mine, ...builtIn];
}

const SOURCE_LABEL = { mine: 'My food', db: 'Built-in', online: 'Branded' };

function renderAddEntryFoodList(query) {
  const results = [...localMatches(query), ...state.searchResults];
  const container = document.getElementById('add-entry-food-list');
  if (!results.length) {
    container.innerHTML = query.trim()
      ? `<div class="empty-hint">No matches. Try “Search branded foods” below, or Quick Add.</div>`
      : `<div class="empty-hint">Start typing to search foods, or use Quick Add.</div>`;
    return;
  }
  container.innerHTML = results.map((f, i) => `
    <div class="food-row pick-row" data-idx="${i}">
      <div class="entry-info">
        <div class="entry-name">${escapeHtml(f.name)}</div>
        <div class="entry-sub">${escapeHtml(f.servingDesc)} · ${f.calories} cal · P${f.protein} C${f.carbs} F${f.fat}
          <span class="source-tag">${SOURCE_LABEL[f.source] || ''}</span></div>
      </div>
      <div class="qty-picker">
        <input type="number" class="qty-input" min="0.25" step="0.25" value="1" data-idx="${i}" />
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
  const modal = document.getElementById('log-food-modal');
  modal.dataset.foodId = food.id;
  document.getElementById('log-food-title').textContent = `Log ${food.name}`;
  document.getElementById('log-food-qty').value = 1;
  document.getElementById('log-food-meal').value = 'breakfast';
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

  // Foods tab
  document.getElementById('food-search').addEventListener('input', e => {
    state.foodSearch = e.target.value;
    renderFoods();
  });
  document.getElementById('new-food-btn').addEventListener('click', () => openFoodEditor(null));
  document.getElementById('foods-list').addEventListener('click', async e => {
    const foodId = e.target.closest('[data-food-id]')?.dataset.foodId;
    if (!foodId) return;
    const food = state.foods.find(f => f.id === foodId);
    if (e.target.closest('.log-food-btn')) openLogFoodModal(food);
    else if (e.target.closest('.edit-food-btn')) openFoodEditor(food);
    else if (e.target.closest('.delete-food-btn')) {
      if (!confirm(`Delete "${food.name}"?`)) return;
      await db.deleteFood(foodId);
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
    const modal = document.getElementById('log-food-modal');
    const food = state.foods.find(f => f.id === modal.dataset.foodId);
    const qty = Number(document.getElementById('log-food-qty').value) || 1;
    const meal = document.getElementById('log-food-meal').value;
    await db.addDiaryEntry(state.currentDate, meal, { ...food, qty });
    closeModal('log-food-modal');
    await loadDayData();
    if (state.activeTab === 'today') render(); else renderFoods();
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
  document.getElementById('data-btn').addEventListener('click', () => openModal('data-modal'));
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
