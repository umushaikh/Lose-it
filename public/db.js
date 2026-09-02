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
    calorieOverride: null // if set, overrides the computed budget
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
    weightLog: []
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

  async exportData() {
    const store = loadDb();
    return { app: 'calorie-counter', version: 1, exportedAt: new Date().toISOString(), ...store };
  },

  async importData(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('That file is not a Calorie Counter backup.');
    }
    const { settings, foods, diary, exercise, weightLog } = payload;
    if (!settings || !Array.isArray(foods) || !diary || typeof diary !== 'object' || !Array.isArray(weightLog)) {
      throw new Error('That file is missing calorie data, so it is not a Calorie Counter backup.');
    }
    saveDb({ settings, foods, diary, exercise: exercise || {}, weightLog });
    return { foods: foods.length, days: Object.keys(diary).length, weightEntries: weightLog.length };
  }
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
