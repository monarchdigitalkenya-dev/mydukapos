// zip 306: a shop in its OWN DATABASE (the real ShopStore on node:sqlite) with the REAL live-sync room (SyncRoom from wildcard-router/worker.js),
// and devices whose WebSocket is wired straight to that room. Lets a test watch exactly what the apps send over HTTP and over the connection.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeServer, openDevice } from './e2e-harness.mjs';
import { makeBinding, fakeDoState } from './do-fake.mjs';

const { SyncRoom } = await import(pathToFileURL(path.join(ROOT, 'wildcard-router/worker.js')).href);

export function makeRoomBinding() {
  const rooms = new Map();
  const stats = { wsIn: 0, pings: 0, notes: 0, broadcasts: 0 };
  const flags = { mute: false, dead: false };               // mute: broadcasts never reach devices (a lost poke); dead: room answers nothing (old router)
  const roomFor = (id) => {
    if (!rooms.has(id)) {
      const sockets = new Set();
      const ctx = { storage: fakeDoState().storage, acceptWebSocket: (ws) => sockets.add(ws), getWebSockets: () => [...sockets], setWebSocketAutoResponse() {} };
      rooms.set(id, { room: new SyncRoom(ctx), sockets });
    }
    return rooms.get(id);
  };
  const binding = {
    idFromName: (n) => n,
    get: (id) => ({
      fetch: async (url, opts) => {
        const p = new URL(String(url)).pathname;
        if (p === '/ver') stats.notes++;
        if (p === '/broadcast') stats.broadcasts++;
        return roomFor(id).room.fetch(new Request(url, opts));
      },
    }),
  };
  // A WebSocket class for one device, connected to shop `shopId`'s room.
  const socketClass = (shopId) => class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() {
      this.readyState = 0; this._l = { message: [], open: [], close: [] };
      const self = this;
      this._server = {
        send(d) {
          if (self.readyState !== 1) return;
          const isVer = typeof d === 'string' && d.indexOf('"t":"v"') > 0;
          if (flags.mute && !isVer) return;
          setTimeout(() => self._emit('message', { data: d }), 0);
        },
        close() { self.close(); },
      };
      setTimeout(() => { const r = roomFor(shopId); r.sockets.add(this._server); this.readyState = 1; this._emit('open', {}); }, 0);
    }
    addEventListener(t, f) { (this._l[t] || (this._l[t] = [])).push(f); }
    removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter((x) => x !== f); }
    _emit(t, ev) { const h = this['on' + t]; try { if (h) h.call(this, ev); } catch (e) { /* page error */ } for (const f of this._l[t] || []) { try { f.call(this, ev); } catch (e) { /* page error */ } } }
    send(m) {
      if (this.readyState !== 1) return;
      if (m === 'ping') { stats.pings++; setTimeout(() => this._emit('message', { data: 'pong' }), 0); return; }   // the runtime's auto-response
      stats.wsIn++;
      if (flags.dead) return;
      Promise.resolve(roomFor(shopId).room.webSocketMessage(this._server, m)).catch(() => {});
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; roomFor(shopId).sockets.delete(this._server); setTimeout(() => this._emit('close', {}), 0); }
  };
  return { binding, stats, flags, socketClass, rooms };
}

// A shop already living in its own database, with the live room on both sides (Pages and the database).
export async function makeLiveServer() {
  const s = makeServer();
  const room = makeRoomBinding();
  s.env.SYNC_ROOM = room.binding;
  s.env.SHOP_STORE = await makeBinding({ env: { SYNC_ROOM: room.binding } });
  s.kv.data.set('pos-data:mode:C1', { value: 'do' });
  s.room = room;
  s.httpPulls = () => s.state.log.filter((l) => l.startsWith('GET')).length;
  s.dbState = async () => JSON.parse(await (await s.env.SHOP_STORE.get('C1').fetch('https://shop-store/export', { method: 'POST', body: '{}' })).text());
  return s;
}

export const openLiveDevice = (app, s, storage = {}, wait = 900) => openDevice(app, s, storage, wait, { beforeParse: (w) => { w.WebSocket = s.room.socketClass('C1'); } });
