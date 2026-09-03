const DB_KEY = 'calorieCounterDb';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function defaultSettings() {
  return {
    onboarded: false,
    units: 'imperial', // 'imperial' | 'metric'
    sex: 'female', // 'female' | 'male'
    age: 30,
    heightCm: 165,
    weightKg: 70,
    goalWeightKg: null,
    activity: 'light', // sedentary | light | moderate | active | veryActive
    goal: 'lose', // 'lose' | 'maintain' | 'gain'
    rateLbPerWeek: 1,
    macroSplit: { proteinPct: 30, carbsPct: 40, fatPct: 30 },
    calorieOverride: null, // if set, overrides the computed budget
    theme: 'dark', // 'dark' | 'light' | 'system'
    apiKey: '' // optional Anthropic key for photo estimates; stays on this device
  };
}

// Membership of a shared board. Empty by default: with no serverUrl the app
// never contacts anything, which is how it has always worked and stays the
// behaviour for anyone who doesn't want a group.
function defaultGroup() {
  return {
    serverUrl: '',
    groupId: '',
    groupName: '',
    joinCode: '',
    memberId: '',
    memberName: '',
    token: '',
    shareWeighIns: true
  };
}

function loadDb() {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.settings) parsed.settings = defaultSettings();
      if (!parsed.foods) parsed.foods = [];
      if (!parsed.diary) parsed.diary = {};
      if (!parsed.exercise) parsed.exercise = {};
      if (!parsed.weightLog) parsed.weightLog = [];
      if (!parsed.recipes) parsed.recipes = [];
      if (!parsed.group) parsed.group = defaultGroup();
      if (!Array.isArray(parsed.outbox)) parsed.outbox = [];
      return parsed;
    } catch {
      // fall through and reseed a fresh db below
    }
  }
  const seeded = {
    settings: defaultSettings(),
    foods: [],
    diary: {},
    exercise: {},
    weightLog: [],
    recipes: []
  };
  saveDb(seeded);
  return seeded;
}

function saveDb(store) {
  localStorage.setItem(DB_KEY, JSON.stringify(store));
}

function dayDiary(store, date) {
  if (!store.diary[date]) store.diary[date] = { breakfast: [], lunch: [], dinner: [], snacks: [] };
  return store.diary[date];
}

const db = {
  async getSettings() {
    return loadDb().settings;
  },

  async saveSettings(patch) {
    const store = loadDb();
    store.settings = { ...store.settings, ...patch, onboarded: true };
    saveDb(store);
    if (patch.weightKg) {
      // Keep the weight log in sync when settings save a fresh current weight.
      const todayEntry = store.weightLog.find(w => w.date === todayStr());
      if (!todayEntry) {
        store.weightLog.push({ id: uid(), date: todayStr(), weightKg: patch.weightKg });
        store.weightLog.sort((a, b) => a.date.localeCompare(b.date));
        saveDb(store);
      }
    }
    return store.settings;
  },

  async getFoods() {
    return [...loadDb().foods].sort((a, b) => a.name.localeCompare(b.name));
  },

  async addFood({ name, servingDesc, calories, protein, carbs, fat }) {
    const store = loadDb();
    const food = {
      id: uid(),
      name,
      servingDesc: servingDesc || '1 serving',
      calories: Number(calories) || 0,
      protein: Number(protein) || 0,
      carbs: Number(carbs) || 0,
      fat: Number(fat) || 0
    };
    store.foods.push(food);
    saveDb(store);
    return food;
  },

  async updateFood(foodId, patch) {
    const store = loadDb();
    const food = store.foods.find(f => f.id === foodId);
    if (!food) return null;
    Object.assign(food, patch);
    saveDb(store);
    return food;
  },

  async deleteFood(foodId) {
    const store = loadDb();
    const before = store.foods.length;
    store.foods = store.foods.filter(f => f.id !== foodId);
    if (store.foods.length === before) return false;
    saveDb(store);
    return true;
  },

  async getDiaryDay(date) {
    return dayDiary(loadDb(), date);
  },

  async addDiaryEntry(date, meal, entry) {
    const store = loadDb();
    const day = dayDiary(store, date);
    const item = {
      id: uid(),
      name: entry.name,
      // Kept so the entry can be re-scaled later - it carries the gram basis.
      servingDesc: entry.servingDesc || '1 serving',
      qty: Number(entry.qty) || 1,
      calories: Number(entry.calories) || 0,
      protein: Number(entry.protein) || 0,
      carbs: Number(entry.carbs) || 0,
      fat: Number(entry.fat) || 0
    };
    day[meal].push(item);
    saveDb(store);
    return item;
  },

  async updateDiaryEntry(date, meal, entryId, patch) {
    const store = loadDb();
    const day = dayDiary(store, date);
    const entry = day[meal].find(i => i.id === entryId);
    if (!entry) return null;
    ['name', 'servingDesc'].forEach(k => {
      if (patch[k] != null) entry[k] = patch[k];
    });
    ['qty', 'calories', 'protein', 'carbs', 'fat'].forEach(k => {
      if (patch[k] != null) entry[k] = Number(patch[k]) || 0;
    });
    saveDb(store);
    return entry;
  },

  async deleteDiaryEntry(date, meal, entryId) {
    const store = loadDb();
    const day = dayDiary(store, date);
    const before = day[meal].length;
    day[meal] = day[meal].filter(i => i.id !== entryId);
    if (day[meal].length === before) return false;
    saveDb(store);
    return true;
  },

  async getExerciseDay(date) {
    const store = loadDb();
    return store.exercise[date] || [];
  },

  async addExerciseEntry(date, entry) {
    const store = loadDb();
    if (!store.exercise[date]) store.exercise[date] = [];
    const item = { id: uid(), name: entry.name, calories: Number(entry.calories) || 0 };
    store.exercise[date].push(item);
    saveDb(store);
    return item;
  },

  async deleteExerciseEntry(date, entryId) {
    const store = loadDb();
    const list = store.exercise[date] || [];
    const before = list.length;
    store.exercise[date] = list.filter(i => i.id !== entryId);
    if (store.exercise[date].length === before) return false;
    saveDb(store);
    return true;
  },

  async getWeightLog() {
    return [...loadDb().weightLog].sort((a, b) => a.date.localeCompare(b.date));
  },

  async addWeightEntry(date, weightKg) {
    const store = loadDb();
    const existing = store.weightLog.find(w => w.date === date);
    if (existing) {
      existing.weightKg = weightKg;
    } else {
      store.weightLog.push({ id: uid(), date, weightKg });
    }
    store.weightLog.sort((a, b) => a.date.localeCompare(b.date));
    // The most recent weight entry is also the "current weight" used by the calculator.
    const latest = store.weightLog[store.weightLog.length - 1];
    if (latest.date === date) store.settings.weightKg = weightKg;
    saveDb(store);
    return existing || store.weightLog[store.weightLog.length - 1];
  },

  async deleteWeightEntry(entryId) {
    const store = loadDb();
    const before = store.weightLog.length;
    store.weightLog = store.weightLog.filter(w => w.id !== entryId);
    if (store.weightLog.length === before) return false;
    saveDb(store);
    return true;
  },

  async getRecipes() {
    return [...loadDb().recipes].sort((a, b) => a.name.localeCompare(b.name));
  },

  // Ingredient totals are divided by the serving count, so a recipe logs like
  // any other food: one serving at a time.
  async addRecipe({ name, servings, ingredients }) {
    const store = loadDb();
    const recipe = {
      id: uid(),
      name: (name || '').trim() || 'Recipe',
      servings: Math.max(Number(servings) || 1, 0.25),
      ingredients: (ingredients || []).map(i => ({
        name: i.name,
        qty: Number(i.qty) || 1,
        calories: Number(i.calories) || 0,
        protein: Number(i.protein) || 0,
        carbs: Number(i.carbs) || 0,
        fat: Number(i.fat) || 0
      }))
    };
    store.recipes.push(recipe);
    saveDb(store);
    return recipe;
  },

  async updateRecipe(recipeId, patch) {
    const store = loadDb();
    const recipe = store.recipes.find(r => r.id === recipeId);
    if (!recipe) return null;
    Object.assign(recipe, patch);
    saveDb(store);
    return recipe;
  },

  async deleteRecipe(recipeId) {
    const store = loadDb();
    const before = store.recipes.length;
    store.recipes = store.recipes.filter(r => r.id !== recipeId);
    if (store.recipes.length === before) return false;
    saveDb(store);
    return true;
  },

  // ---- shared board ----

  async getGroup() {
    return { ...defaultGroup(), ...(loadDb().group || {}) };
  },

  async saveGroup(patch) {
    const store = loadDb();
    store.group = { ...defaultGroup(), ...(store.group || {}), ...patch };
    saveDb(store);
    return store.group;
  },

  async clearGroup() {
    const store = loadDb();
    // Keep the server URL: leaving one group and joining another shouldn't
    // mean typing the address back in.
    const serverUrl = (store.group || {}).serverUrl || '';
    store.group = { ...defaultGroup(), serverUrl };
    store.outbox = [];
    saveDb(store);
    return store.group;
  },

  // Writes that could not be delivered. The app is offline-first, so a day
  // logged on the metro has to survive until there is a connection again.
  async getOutbox() {
    return loadDb().outbox || [];
  },

  // Day updates supersede each other, so only the newest per date is kept and
  // a week offline still flushes as a handful of requests.
  async queueOutbox(item) {
    const store = loadDb();
    const outbox = (store.outbox || []).filter(
      q => !(q.kind === 'day' && item.kind === 'day' && q.body.date === item.body.date)
    );
    outbox.push({ ...item, id: uid(), queuedAt: Date.now() });
    store.outbox = outbox.slice(-100);
    saveDb(store);
    return store.outbox;
  },

  async dropOutbox(ids) {
    const store = loadDb();
    const drop = new Set(ids);
    store.outbox = (store.outbox || []).filter(q => !drop.has(q.id));
    saveDb(store);
    return store.outbox;
  },

  async exportData() {
    const store = loadDb();
    // The API key is a credential, not diary data - keep it out of a file the
    // user might send to themselves over email or store in the cloud. The group
    // token is the same kind of thing, and the outbox is transient.
    const { apiKey, ...settings } = store.settings;
    const { group, outbox, ...rest } = store;
    return {
      app: 'calorie-counter',
      version: 2,
      exportedAt: new Date().toISOString(),
      ...rest,
      settings
    };
  },

  async importData(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('That file is not a Calorie Counter backup.');
    }
    const { settings, foods, diary, exercise, weightLog, recipes } = payload;
    if (!settings || !Array.isArray(foods) || !diary || typeof diary !== 'object' || !Array.isArray(weightLog)) {
      throw new Error('That file is missing calorie data, so it is not a Calorie Counter backup.');
    }
    // A backup carries no API key, so keep the one already on this device.
    const current = loadDb();
    const existingKey = current.settings.apiKey;
    saveDb({
      settings: { ...settings, apiKey: settings.apiKey || existingKey || '' },
      foods,
      diary,
      exercise: exercise || {},
      weightLog,
      recipes: Array.isArray(recipes) ? recipes : [],
      // Restoring a backup shouldn't kick this device out of its group.
      group: current.group || defaultGroup(),
      outbox: current.outbox || []
    });
    return {
      foods: foods.length,
      days: Object.keys(diary).length,
      weightEntries: weightLog.length,
      recipes: Array.isArray(recipes) ? recipes.length : 0
    };
  }
};

// Local-time date key, matching app.js. toISOString() would use the UTC day,
// which is a different calendar day for most timezones.
function todayStr() {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}
