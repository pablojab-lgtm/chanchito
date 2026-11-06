// Almacenamiento en este dispositivo (localStorage). Misma interfaz que store-cloud.js.
const KEY = 'chanchito-v1';

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 20);

export function createLocalStore(makeHousehold) {
  let state;
  try { state = JSON.parse(localStorage.getItem(KEY)); } catch { state = null; }
  if (!state || !state.household) {
    state = { household: makeHousehold('Mi casa', { uid: 'yo', name: 'Yo' }), movements: [], recurring: [] };
  }
  const subs = new Set();
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.error(e); }
    const snap = structuredClone(state);
    subs.forEach(cb => cb(snap));
  };

  return {
    mode: 'local',
    me: { uid: 'yo', name: 'Yo' },
    subscribe(cb) { subs.add(cb); cb(structuredClone(state)); return () => subs.delete(cb); },
    close() { subs.clear(); },
    async addMovement(m) { const id = uid(); state.movements.push({ ...m, id, createdAt: Date.now() }); save(); return id; },    async updateMovement(id, patch) {
      const m = state.movements.find(x => x.id === id); if (m) Object.assign(m, patch); save();
    },
    async deleteMovement(id) { state.movements = state.movements.filter(x => x.id !== id); save(); },
    async saveRecurring(r) {
      let id = r.id;
      if (id) { const i = state.recurring.findIndex(x => x.id === id); if (i >= 0) state.recurring[i] = { ...state.recurring[i], ...r }; }
      else { id = uid(); state.recurring.push({ ...r, id, doneMonths: [], createdAt: Date.now() }); }
      save();
      return id;
    },
    async deleteRecurring(id) { state.recurring = state.recurring.filter(x => x.id !== id); save(); },
    async updateHousehold(patch) { Object.assign(state.household, patch); save(); },
    async materialize(rule, month, movement) {
      const id = `${rule.id}_${month}`;
      if (!state.movements.some(x => x.id === id)) state.movements.push({ ...movement, id, createdAt: Date.now() });
      const r = state.recurring.find(x => x.id === rule.id);
      if (r) r.doneMonths = [...new Set([...(r.doneMonths || []), month])];
      save();
    },
    exportAll() { return structuredClone(state); },
    async importAll(data) {
      if (!data || !data.household || !Array.isArray(data.movements)) throw new Error('Archivo inválido');
      state = { household: data.household, movements: data.movements, recurring: data.recurring || [] };
      save();
    },
  };
}
