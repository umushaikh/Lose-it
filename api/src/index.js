// Shared board for a group of friends. Runs on Cloudflare Workers with D1 for
// the rows and, optionally, R2 for photos.
//
// Deliberately small on auth: a member's credential is a random token handed
// out at join time, and the group's join code is the only thing gating who can
// get one. That is proportionate to a group of friends sharing what they ate,
// and it means nobody has to make an account or remember a password. It is not
// proportionate to anything you would mind a friend-of-a-friend reading, and
// the README says so.

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

// No 0/O/1/I, because these get read aloud and typed by hand.
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789';

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const FEED_LIMIT = 100;
const EVENT_RETENTION_DAYS = 90;

// R2's free tier is 10 GB-month; Workers and D1 stay on the free plan and
// simply reject over-quota requests rather than bill anything, so R2 is the
// only one of the three that a card on file can actually be charged for.
// This cap sits far under the free amount on purpose - it is a sanity/abuse
// ceiling, not a "right up to the line" budget - and is enforced here rather
// than trusted to Cloudflare, since Cloudflare has no automatic spend cap of
// its own. Override with the PHOTO_STORAGE_CEILING_MB var if you deliberately
// want more headroom.
const DEFAULT_PHOTO_STORAGE_CEILING_MB = 2048; // 2 GiB - tens of thousands of photos

function photoStorageCeilingBytes(env) {
  const mb = Number(env.PHOTO_STORAGE_CEILING_MB);
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_PHOTO_STORAGE_CEILING_MB;
  return safeMb * 1024 * 1024;
}

function cors(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400'
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...cors(origin) }
  });
}

function fail(message, status, origin) {
  return json({ error: message }, status, origin);
}

function randomCode(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Comparison that does not leak where two tokens first differ. Overkill for a
// group chat about lunch, but it costs one line.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cleanName(value, fallback = 'Someone') {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return name || fallback;
}

// Safe JSON.parse for the items list stored in shared_meals - a malformed
// or missing value should just mean "no items", never a broken board.
function parseItemsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const DAY_MEAL_KEYS = ['breakfast', 'lunch', 'dinner', 'snacks'];

// Same shape of clean-up used for a shared meal's items, pulled out so a
// whole day's worth of logged foods (day_items) can be sanitized the same
// way without trusting anything the client sends.
function sanitizeFoodItem(i) {
  return {
    name: String(i?.name || '').trim().slice(0, 120),
    servingDesc: String(i?.servingDesc || '1 serving').slice(0, 60),
    qty: Math.max(0, Math.min(1000, Number(i?.qty) || 1)),
    calories: num(i?.calories),
    protein: numDecimal(i?.protein, 2000),
    carbs: numDecimal(i?.carbs, 2000),
    fat: numDecimal(i?.fat, 2000),
    fiber: numDecimal(i?.fiber, 500),
    sugar: numDecimal(i?.sugar, 2000),
    sodium: num(i?.sodium, 20000)
  };
}

// Safe JSON.parse for day_items' items_json - malformed or missing just
// means "nothing logged", never a broken profile.
function parseDayItemsJson(raw) {
  const out = { breakfast: [], lunch: [], dinner: [], snacks: [] };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const key of DAY_MEAL_KEYS) {
        if (Array.isArray(parsed[key])) out[key] = parsed[key];
      }
    }
  } catch {
    // fall through with the empty default
  }
  return out;
}

function num(value, max = 100000) {
  const n = Math.round(Number(value) || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-max, Math.min(max, n));
}

// Same clamping as num(), but keeps one decimal place instead of rounding to
// a whole number - for gram-scale macros (protein/carbs/fat/fiber/sugar),
// where num() would silently flatten 46.5g down to 47.
function numDecimal(value, max = 100000) {
  const n = Math.round((Number(value) || 0) * 10) / 10;
  if (!Number.isFinite(n)) return 0;
  return Math.max(-max, Math.min(max, n));
}

function isDateStr(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// ---- auth ----

async function authenticate(request, env) {
  const header = request.headers.get('authorization') || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : '';
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const memberId = raw.slice(0, dot);
  const token = raw.slice(dot + 1);
  if (!memberId || !token) return null;

  const member = await env.DB
    .prepare('SELECT id, group_id, name, token_hash FROM members WHERE id = ?')
    .bind(memberId)
    .first();
  if (!member) return null;
  if (!safeEqual(member.token_hash, await sha256(token))) return null;
  return member;
}

// ---- handlers ----

async function createGroup(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const groupName = cleanName(body.groupName, 'My group');
  const memberName = cleanName(body.memberName, 'Me');
  const now = Date.now();

  // Retry on the astronomically unlikely code collision rather than handing
  // back a 500 for it.
  let joinCode = null;
  for (let attempt = 0; attempt < 5 && !joinCode; attempt++) {
    const candidate = randomCode();
    const taken = await env.DB.prepare('SELECT 1 FROM groups WHERE join_code = ?').bind(candidate).first();
    if (!taken) joinCode = candidate;
  }
  if (!joinCode) return fail('Could not allocate a join code, try again', 503, origin);

  const groupId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const token = randomToken();

  await env.DB.batch([
    env.DB.prepare('INSERT INTO groups (id, name, join_code, created_at) VALUES (?, ?, ?, ?)')
      .bind(groupId, groupName, joinCode, now),
    env.DB.prepare('INSERT INTO members (id, group_id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(memberId, groupId, memberName, await sha256(token), now, now),
    env.DB.prepare('INSERT INTO events (id, group_id, member_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), groupId, memberId, 'joined', now)
  ]);

  return json({
    group: { id: groupId, name: groupName, joinCode },
    member: { id: memberId, name: memberName },
    token: `${memberId}.${token}`
  }, 201, origin);
}

async function joinGroup(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const code = String(body.joinCode || '').trim().toUpperCase();
  const memberName = cleanName(body.memberName, 'Someone');
  if (!code) return fail('A join code is required', 400, origin);

  const group = await env.DB
    .prepare('SELECT id, name, join_code FROM groups WHERE join_code = ?')
    .bind(code)
    .first();
  if (!group) return fail('No group with that code', 404, origin);

  const count = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM members WHERE group_id = ?')
    .bind(group.id)
    .first();
  if ((count?.n || 0) >= 50) return fail('That group is full', 409, origin);

  const memberId = crypto.randomUUID();
  const token = randomToken();
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare('INSERT INTO members (id, group_id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(memberId, group.id, memberName, await sha256(token), now, now),
    env.DB.prepare('INSERT INTO events (id, group_id, member_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), group.id, memberId, 'joined', now)
  ]);

  return json({
    group: { id: group.id, name: group.name, joinCode: group.join_code },
    member: { id: memberId, name: memberName },
    token: `${memberId}.${token}`
  }, 201, origin);
}

// Upsert today's numbers. Called after every diary change, so it must be cheap
// and must never grow the table.
//
// Also upserts day_items alongside it, when the client sends items - the
// actual foods behind those numbers, broken out by meal, so a member's
// profile can show their whole day rather than just its totals. This runs on
// the same debounced sync as the day summary, so it costs nothing extra:
// logging all day still rewrites one row per table, not one per change.
async function putDay(request, env, member, origin) {
  const body = await request.json().catch(() => ({}));
  if (!isDateStr(body.date)) return fail('A date of the form YYYY-MM-DD is required', 400, origin);
  const now = Date.now();

  const writes = [
    env.DB.prepare(`
      INSERT INTO days (group_id, member_id, date, eaten, budget, exercise, protein, carbs, fat, entries, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (group_id, member_id, date) DO UPDATE SET
        eaten = excluded.eaten, budget = excluded.budget, exercise = excluded.exercise,
        protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat,
        entries = excluded.entries, updated_at = excluded.updated_at
    `).bind(
      member.group_id, member.id, body.date,
      num(body.eaten), num(body.budget), num(body.exercise),
      num(body.protein, 5000), num(body.carbs, 5000), num(body.fat, 5000),
      num(body.entries, 500), now
    ),
    env.DB.prepare('UPDATE members SET last_seen = ? WHERE id = ?').bind(now, member.id)
  ];

  if (body.items && typeof body.items === 'object') {
    const dayItems = {};
    let total = 0;
    for (const key of DAY_MEAL_KEYS) {
      const rawItems = Array.isArray(body.items[key]) ? body.items[key] : [];
      const items = rawItems.map(sanitizeFoodItem).filter(i => i.name).slice(0, 60);
      total += items.length;
      dayItems[key] = items;
    }
    // A generous ceiling well past any real day of logging - just a sanity
    // cap so a malformed payload can't grow this row without bound.
    if (total <= 120) {
      const itemsJson = JSON.stringify(dayItems);
      if (itemsJson.length <= 40000) {
        writes.push(env.DB.prepare(`
          INSERT INTO day_items (group_id, member_id, date, items_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (group_id, member_id, date) DO UPDATE SET
            items_json = excluded.items_json, updated_at = excluded.updated_at
        `).bind(member.group_id, member.id, body.date, itemsJson, now));
      }
    }
  }

  await env.DB.batch(writes);
  return json({ ok: true, updatedAt: now }, 200, origin);
}

async function getBoard(request, env, member, origin) {
  const url = new URL(request.url);
  const date = isDateStr(url.searchParams.get('date')) ? url.searchParams.get('date') : null;
  if (!date) return fail('A date of the form YYYY-MM-DD is required', 400, origin);

  const group = await env.DB
    .prepare('SELECT id, name, join_code FROM groups WHERE id = ?')
    .bind(member.group_id)
    .first();

  const members = await env.DB.prepare(`
    SELECT m.id, m.name, m.last_seen,
           d.eaten, d.budget, d.exercise, d.protein, d.carbs, d.fat, d.entries, d.updated_at,
           p.avatar, p.info, di.items_json AS day_items_json
    FROM members m
    LEFT JOIN days d ON d.member_id = m.id AND d.group_id = m.group_id AND d.date = ?
    LEFT JOIN member_profiles p ON p.member_id = m.id
    LEFT JOIN day_items di ON di.member_id = m.id AND di.group_id = m.group_id AND di.date = ?
    WHERE m.group_id = ?
    ORDER BY m.created_at
  `).bind(date, date, member.group_id).all();

  const events = await env.DB.prepare(`
    SELECT e.id, e.member_id, e.kind, e.text, e.photo_key, e.calories, e.created_at, m.name AS member_name,
           sm.meal_key AS shared_meal_key, sm.calories AS shared_calories, sm.protein AS shared_protein,
           sm.carbs AS shared_carbs, sm.fat AS shared_fat, sm.fiber AS shared_fiber,
           sm.sugar AS shared_sugar, sm.sodium AS shared_sodium, sm.items_json AS shared_items_json
    FROM events e
    JOIN members m ON m.id = e.member_id
    LEFT JOIN shared_meals sm ON sm.event_id = e.id
    WHERE e.group_id = ?
    ORDER BY e.created_at DESC
    LIMIT ?
  `).bind(member.group_id, FEED_LIMIT).all();

  await env.DB.prepare('UPDATE members SET last_seen = ? WHERE id = ?').bind(Date.now(), member.id).run();

  return json({
    group: { id: group.id, name: group.name, joinCode: group.join_code },
    me: { id: member.id, name: member.name },
    date,
    photosEnabled: Boolean(env.PHOTOS),
    members: (members.results || []).map(r => ({
      id: r.id,
      name: r.name,
      lastSeen: r.last_seen,
      logged: r.updated_at != null,
      eaten: r.eaten || 0,
      budget: r.budget || 0,
      exercise: r.exercise || 0,
      protein: r.protein || 0,
      carbs: r.carbs || 0,
      fat: r.fat || 0,
      entries: r.entries || 0,
      updatedAt: r.updated_at || null,
      avatar: r.avatar || '',
      info: r.info || '',
      items: parseDayItemsJson(r.day_items_json)
    })),
    events: (events.results || []).map(r => ({
      id: r.id,
      memberId: r.member_id,
      memberName: r.member_name,
      kind: r.kind,
      text: r.text,
      photoKey: r.photo_key,
      calories: r.calories,
      createdAt: r.created_at,
      sharedMeal: r.shared_meal_key == null ? null : {
        mealKey: r.shared_meal_key,
        calories: r.shared_calories,
        protein: r.shared_protein,
        carbs: r.shared_carbs,
        fat: r.shared_fat,
        fiber: r.shared_fiber,
        sugar: r.shared_sugar,
        sodium: r.shared_sodium,
        items: parseItemsJson(r.shared_items_json)
      }
    }))
  }, 200, origin);
}

// Cleans up the child rows of every event about to age out of the 90-day feed
// window - the R2 photo and its size-accounting row for a photo event, the
// shared_meals row for a shared-meal event. Without this, pruning the feed
// only ever shrank the events table: the photo stayed in R2 forever (storage
// growing without bound even though nothing looked wrong in the feed), and a
// shared_meals row would sit there orphaned once its event was gone. Both are
// best-effort - a delete failing here shouldn't block posting the new event,
// so each is caught rather than left to abort the batch.
async function reapExpiringEvents(env, groupId, now) {
  const cutoff = now - EVENT_RETENTION_DAYS * 86400000;
  const expiring = await env.DB.prepare(
    'SELECT id, photo_key FROM events WHERE group_id = ? AND created_at < ?'
  ).bind(groupId, cutoff).all();

  for (const row of expiring.results || []) {
    try {
      if (row.photo_key) {
        if (env.PHOTOS) await env.PHOTOS.delete(row.photo_key);
        await env.DB.prepare('DELETE FROM photo_sizes WHERE photo_key = ?').bind(row.photo_key).run();
      }
      await env.DB.prepare('DELETE FROM shared_meals WHERE event_id = ?').bind(row.id).run();
    } catch {
      // Leaves that one row's child data untracked rather than risk the
      // request; the next post through this group retries it.
    }
  }
}

async function postEvent(request, env, member, origin) {
  const body = await request.json().catch(() => ({}));
  const kind = String(body.kind || '').trim();
  if (!['photo', 'weigh_in', 'note', 'day_done', 'meal'].includes(kind)) {
    return fail('Unknown event kind', 400, origin);
  }
  const now = Date.now();
  const text = body.text == null ? null : String(body.text).trim().slice(0, 280);
  const photoKey = body.photoKey == null ? null : String(body.photoKey).slice(0, 200);
  const calories = body.calories == null ? null : num(body.calories);
  const eventId = crypto.randomUUID();

  let sharedMeal = null;
  if (kind === 'meal') {
    const mealKey = String(body.mealKey || '').trim();
    if (!['breakfast', 'lunch', 'dinner', 'snacks'].includes(mealKey)) {
      return fail('Unknown meal', 400, origin);
    }
    const rawItems = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
    const items = rawItems.map(sanitizeFoodItem).filter(i => i.name);
    if (!items.length) return fail('That meal has nothing logged in it to share', 400, origin);

    const itemsJson = JSON.stringify(items);
    if (itemsJson.length > 20000) return fail('That meal has too many items to share', 400, origin);

    // Summed here rather than trusted from the client, so the board's total
    // always matches the items list it is shown next to.
    const totals = items.reduce((acc, i) => ({
      calories: acc.calories + i.calories * i.qty,
      protein: acc.protein + i.protein * i.qty,
      carbs: acc.carbs + i.carbs * i.qty,
      fat: acc.fat + i.fat * i.qty,
      fiber: acc.fiber + i.fiber * i.qty,
      sugar: acc.sugar + i.sugar * i.qty,
      sodium: acc.sodium + i.sodium * i.qty
    }), { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 });

    sharedMeal = {
      mealKey,
      itemsJson,
      calories: Math.round(totals.calories),
      protein: numDecimal(totals.protein, 20000),
      carbs: numDecimal(totals.carbs, 20000),
      fat: numDecimal(totals.fat, 20000),
      fiber: numDecimal(totals.fiber, 20000),
      sugar: numDecimal(totals.sugar, 20000),
      sodium: Math.round(totals.sodium)
    };
  }

  await reapExpiringEvents(env, member.group_id, now);

  const writes = [
    env.DB.prepare('INSERT INTO events (id, group_id, member_id, kind, text, photo_key, calories, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(eventId, member.group_id, member.id, kind, text, photoKey, calories, now),
    // Keeps the table bounded without anyone having to remember to prune it.
    env.DB.prepare('DELETE FROM events WHERE group_id = ? AND created_at < ?')
      .bind(member.group_id, now - EVENT_RETENTION_DAYS * 86400000)
  ];
  if (sharedMeal) {
    writes.push(
      env.DB.prepare(`
        INSERT INTO shared_meals (event_id, meal_key, calories, protein, carbs, fat, fiber, sugar, sodium, items_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(eventId, sharedMeal.mealKey, sharedMeal.calories, sharedMeal.protein, sharedMeal.carbs,
              sharedMeal.fat, sharedMeal.fiber, sharedMeal.sugar, sharedMeal.sodium, sharedMeal.itemsJson)
    );
  }
  await env.DB.batch(writes);

  return json({ ok: true }, 201, origin);
}

// A member can only ever write their own profile - there is no member id in
// the body, it comes entirely from the authenticated caller.
async function putProfile(request, env, member, origin) {
  const body = await request.json().catch(() => ({}));
  const avatar = String(body.avatar || '').trim().slice(0, 32);
  const info = String(body.info || '').trim().slice(0, 140);
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO member_profiles (member_id, avatar, info, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (member_id) DO UPDATE SET
      avatar = excluded.avatar, info = excluded.info, updated_at = excluded.updated_at
  `).bind(member.id, avatar, info, now).run();

  return json({ ok: true, avatar, info, updatedAt: now }, 200, origin);
}

async function uploadPhoto(request, env, member, origin) {
  if (!env.PHOTOS) return fail('Photo sharing is not enabled on this server', 501, origin);
  // A manual, instant off-switch: flip this in the Worker's dashboard
  // Variables tab (no redeploy needed) if usage ever looks wrong and you want
  // uploads stopped before you have time to investigate.
  if (env.PHOTOS_PAUSED === 'true') return fail('Photo sharing is paused for this server right now', 503, origin);

  const type = request.headers.get('content-type') || 'image/jpeg';
  if (!type.startsWith('image/')) return fail('Only images can be uploaded', 415, origin);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return fail('Empty upload', 400, origin);
  if (bytes.byteLength > MAX_PHOTO_BYTES) return fail('That image is too large', 413, origin);

  // Enforced here rather than left to Cloudflare, which has no spend cap of
  // its own for R2 - only alerts you could act on after the fact.
  const ceiling = photoStorageCeilingBytes(env);
  const usage = await env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM photo_sizes').first();
  if ((usage?.total || 0) + bytes.byteLength > ceiling) {
    return fail('This server has reached its photo storage limit. Ask whoever set it up to raise PHOTO_STORAGE_CEILING_MB, or delete some old photos.', 507, origin);
  }

  const key = `${member.group_id}/${crypto.randomUUID()}.jpg`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare('INSERT INTO photo_sizes (photo_key, group_id, bytes, created_at) VALUES (?, ?, ?, ?)')
    .bind(key, member.group_id, bytes.byteLength, Date.now()).run();
  return json({ key }, 201, origin);
}

async function getPhoto(env, member, key, origin) {
  if (!env.PHOTOS) return fail('Photo sharing is not enabled on this server', 501, origin);
  // Scoping the key to the caller's group is the whole access check: a member
  // can only ever name objects inside their own group's prefix.
  if (!key.startsWith(`${member.group_id}/`)) return fail('Not found', 404, origin);

  const object = await env.PHOTOS.get(key);
  if (!object) return fail('Not found', 404, origin);
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'image/jpeg',
      'cache-control': 'private, max-age=31536000, immutable',
      ...cors(origin)
    }
  });
}

async function leaveGroup(env, member, origin) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM days WHERE member_id = ?').bind(member.id),
    env.DB.prepare('DELETE FROM day_items WHERE member_id = ?').bind(member.id),
    env.DB.prepare('DELETE FROM member_profiles WHERE member_id = ?').bind(member.id),
    env.DB.prepare('DELETE FROM events WHERE member_id = ?').bind(member.id),
    env.DB.prepare('DELETE FROM members WHERE id = ?').bind(member.id)
  ]);
  return json({ ok: true }, 200, origin);
}

// ---- router ----

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '*';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    try {
      if (path === '/' || path === '/api') {
        return json({ ok: true, service: 'calorie-counter-groups', photosEnabled: Boolean(env.PHOTOS) }, 200, origin);
      }
      if (path === '/api/groups' && method === 'POST') return await createGroup(request, env, origin);
      if (path === '/api/groups/join' && method === 'POST') return await joinGroup(request, env, origin);

      const needsAuth = path.startsWith('/api/');
      if (!needsAuth) return fail('Not found', 404, origin);

      const member = await authenticate(request, env);
      if (!member) return fail('Not signed in to a group', 401, origin);

      if (path === '/api/day' && method === 'PUT') return await putDay(request, env, member, origin);
      if (path === '/api/board' && method === 'GET') return await getBoard(request, env, member, origin);
      if (path === '/api/events' && method === 'POST') return await postEvent(request, env, member, origin);
      if (path === '/api/profile' && method === 'PUT') return await putProfile(request, env, member, origin);
      if (path === '/api/photos' && method === 'POST') return await uploadPhoto(request, env, member, origin);
      if (path.startsWith('/api/photos/') && method === 'GET') {
        return await getPhoto(env, member, decodeURIComponent(path.slice('/api/photos/'.length)), origin);
      }
      if (path === '/api/leave' && method === 'POST') return await leaveGroup(env, member, origin);

      return fail('Not found', 404, origin);
    } catch (err) {
      return fail(err?.message || 'Server error', 500, origin);
    }
  }
};
