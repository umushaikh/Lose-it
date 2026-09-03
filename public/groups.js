// Client for the shared board. Everything here is best-effort: the app is
// offline-first and worked for months with no server at all, so a failure to
// reach one must never block logging food. Writes go to an outbox and are
// flushed when there is a connection; reads just return null and the Friends
// tab says it could not reach the server.

const GROUP_REQUEST_TIMEOUT = 12000;

const groups = {
  // Cached object URLs for feed photos, so scrolling the feed doesn't refetch
  // and so we can revoke them on leave.
  _photoUrls: new Map(),

  async config() {
    return db.getGroup();
  },

  // "Configured" means this device can talk to a group. The server URL alone
  // isn't enough - you can point at a server and not have joined anything.
  async isJoined() {
    const g = await db.getGroup();
    return Boolean(g.serverUrl && g.token && g.groupId);
  },

  base(serverUrl) {
    return String(serverUrl || '').trim().replace(/\/+$/, '');
  },

  async request(path, { method = 'GET', body, raw, headers = {}, serverUrl, token } = {}) {
    const g = await db.getGroup();
    const base = this.base(serverUrl || g.serverUrl);
    if (!base) throw new Error('No server address set');

    const auth = token !== undefined ? token : g.token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROUP_REQUEST_TIMEOUT);
    try {
      const res = await fetch(base + path, {
        method,
        signal: controller.signal,
        headers: {
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers
        },
        body: body !== undefined ? JSON.stringify(body) : raw
      });
      if (!res.ok) {
        let message = `Server said ${res.status}`;
        try {
          const parsed = await res.json();
          if (parsed && parsed.error) message = parsed.error;
        } catch {
          // A non-JSON error body (a proxy page, say) - the status is all we have.
        }
        const err = new Error(message);
        err.status = res.status;
        throw err;
      }
      return res;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('The server did not answer in time');
      // fetch rejects with a bare TypeError for DNS failures, a refused
      // connection and being offline alike, and "Failed to fetch" tells nobody
      // anything. The address and the connection are the two things to check.
      if (err instanceof TypeError) {
        throw new Error(navigator.onLine
          ? 'Could not reach that address — check it is right and the server is deployed'
          : 'You are offline');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  },

  async json(path, opts) {
    const res = await this.request(path, opts);
    return res.json();
  },

  // Checks an address before we save it, so a typo is reported at the point of
  // typing rather than as a silently dead board.
  async probe(serverUrl) {
    const res = await this.request('/', { serverUrl, token: null });
    const info = await res.json();
    if (!info || info.service !== 'calorie-counter-groups') {
      throw new Error('That address answered, but it is not a group server');
    }
    return info;
  },

  async createGroup({ serverUrl, groupName, memberName }) {
    const data = await this.json('/api/groups', {
      method: 'POST', serverUrl, token: null,
      body: { groupName, memberName }
    });
    await db.saveGroup({
      serverUrl: this.base(serverUrl),
      groupId: data.group.id,
      groupName: data.group.name,
      joinCode: data.group.joinCode,
      memberId: data.member.id,
      memberName: data.member.name,
      token: data.token
    });
    return data;
  },

  async joinGroup({ serverUrl, joinCode, memberName }) {
    const data = await this.json('/api/groups/join', {
      method: 'POST', serverUrl, token: null,
      body: { joinCode, memberName }
    });
    await db.saveGroup({
      serverUrl: this.base(serverUrl),
      groupId: data.group.id,
      groupName: data.group.name,
      joinCode: data.group.joinCode,
      memberId: data.member.id,
      memberName: data.member.name,
      token: data.token
    });
    return data;
  },

  async leave() {
    try {
      await this.request('/api/leave', { method: 'POST' });
    } catch {
      // Already unreachable or already gone; either way this device is done
      // with the group, so clear it locally regardless.
    }
    for (const url of this._photoUrls.values()) URL.revokeObjectURL(url);
    this._photoUrls.clear();
    return db.clearGroup();
  },

  // Queue first, then try to send. Queueing first is what makes this safe to
  // call from the diary write path: if the network is down the numbers are
  // still recorded and go out later.
  async pushDay(summary) {
    if (!(await this.isJoined())) return { queued: false, sent: false };
    await db.queueOutbox({ kind: 'day', body: summary });
    return this.flush();
  },

  async postEvent(event) {
    if (!(await this.isJoined())) return { queued: false, sent: false };
    await db.queueOutbox({ kind: 'event', body: event });
    return this.flush();
  },

  // Delivers whatever is queued, oldest first, and stops at the first failure
  // so ordering is preserved and a dead network doesn't burn the whole queue.
  async flush() {
    if (!(await this.isJoined())) return { queued: false, sent: false };
    const outbox = await db.getOutbox();
    if (!outbox.length) return { queued: false, sent: true };

    const delivered = [];
    let sent = true;
    for (const item of outbox) {
      try {
        if (item.kind === 'day') {
          await this.request('/api/day', { method: 'PUT', body: item.body });
        } else if (item.kind === 'event') {
          await this.request('/api/events', { method: 'POST', body: item.body });
        }
        delivered.push(item.id);
      } catch (err) {
        // A rejected item is a permanent failure, not a connectivity one -
        // drop it rather than retrying forever behind everything else.
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          delivered.push(item.id);
          continue;
        }
        sent = false;
        break;
      }
    }
    if (delivered.length) await db.dropOutbox(delivered);
    return { queued: true, sent, pending: (await db.getOutbox()).length };
  },

  async board(date) {
    if (!(await this.isJoined())) return null;
    return this.json(`/api/board?date=${encodeURIComponent(date)}`);
  },

  async saveProfile({ avatar, info }) {
    return this.json('/api/profile', { method: 'PUT', body: { avatar, info } });
  },

  async uploadPhoto(blob) {
    const res = await this.request('/api/photos', {
      method: 'POST',
      raw: blob,
      headers: { 'content-type': blob.type || 'image/jpeg' }
    });
    return res.json();
  },

  // Feed images can't be plain <img src> because the API wants an
  // Authorization header, so fetch the bytes and hand back an object URL.
  async photoUrl(key) {
    if (this._photoUrls.has(key)) return this._photoUrls.get(key);
    const res = await this.request(`/api/photos/${encodeURIComponent(key)}`);
    const url = URL.createObjectURL(await res.blob());
    this._photoUrls.set(key, url);
    return url;
  }
};
