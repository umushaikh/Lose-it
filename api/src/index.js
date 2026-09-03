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

function num(value, max = 100000) {
  const n = Math.round(Number(value) || 0);
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
async function putDay(request, env, member, origin) {
  const body = await request.json().catch(() => ({}));
  if (!isDateStr(body.date)) return fail('A date of the form YYYY-MM-DD is required', 400, origin);
  const now = Date.now();

  await env.DB.prepare(`
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
  ).run();

  await env.DB.prepare('UPDATE members SET last_seen = ? WHERE id = ?').bind(now, member.id).run();
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
           d.eaten, d.budget, d.exercise, d.protein, d.carbs, d.fat, d.entries, d.updated_at
    FROM members m
    LEFT JOIN days d ON d.member_id = m.id AND d.group_id = m.group_id AND d.date = ?
    WHERE m.group_id = ?
    ORDER BY m.created_at
  `).bind(date, member.group_id).all();

  const events = await env.DB.prepare(`
    SELECT e.id, e.member_id, e.kind, e.text, e.photo_key, e.calories, e.created_at, m.name AS member_name
    FROM events e
    JOIN members m ON m.id = e.member_id
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
      updatedAt: r.updated_at || null
    })),
    events: (events.results || []).map(r => ({
      id: r.id,
      memberId: r.member_id,
      memberName: r.member_name,
      kind: r.kind,
      text: r.text,
      photoKey: r.photo_key,
      calories: r.calories,
      createdAt: r.created_at
    }))
  }, 200, origin);
}

async function postEvent(request, env, member, origin) {
  const body = await request.json().catch(() => ({}));
  const kind = String(body.kind || '').trim();
  if (!['photo', 'weigh_in', 'note', 'day_done'].includes(kind)) {
    return fail('Unknown event kind', 400, origin);
  }
  const now = Date.now();
  const text = body.text == null ? null : String(body.text).trim().slice(0, 280);
  const photoKey = body.photoKey == null ? null : String(body.photoKey).slice(0, 200);
  const calories = body.calories == null ? null : num(body.calories);

  await env.DB.batch([
    env.DB.prepare('INSERT INTO events (id, group_id, member_id, kind, text, photo_key, calories, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), member.group_id, member.id, kind, text, photoKey, calories, now),
    // Keeps the table bounded without anyone having to remember to prune it.
    env.DB.prepare('DELETE FROM events WHERE group_id = ? AND created_at < ?')
      .bind(member.group_id, now - EVENT_RETENTION_DAYS * 86400000)
  ]);

  return json({ ok: true }, 201, origin);
}

async function uploadPhoto(request, env, member, origin) {
  if (!env.PHOTOS) return fail('Photo sharing is not enabled on this server', 501, origin);
  const type = request.headers.get('content-type') || 'image/jpeg';
  if (!type.startsWith('image/')) return fail('Only images can be uploaded', 415, origin);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return fail('Empty upload', 400, origin);
  if (bytes.byteLength > MAX_PHOTO_BYTES) return fail('That image is too large', 413, origin);

  const key = `${member.group_id}/${crypto.randomUUID()}.jpg`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
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
