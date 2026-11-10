import { firebaseConfig } from './firebase-config.js';
import { createLocalStore, uid } from './store-local.js';
import { readTicketOnDevice, warmUpReader } from './lector-ticket.js';

/* ================= Utilidades ================= */
const $ = (s, el = document) => el.querySelector(s);
const appEl = $('#app');
const sheetRoot = $('#sheet-root');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const thisMonth = () => todayISO().slice(0, 7);
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const monthsBetween = (a, b) => { const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); };
const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return cap(new Date(y, m - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })); };
const dayLabel = iso => { const [y, m, d] = iso.split('-').map(Number); return cap(new Date(y, m - 1, d).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'short' })); };
const money0 = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = n => { const v = Math.round((n || 0) * 100) / 100; return (Number.isInteger(v) ? money0 : money2).format(v); };
const fmtShort = n => { const a = Math.abs(n); if (a >= 1e6) return '$' + (n / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M'; if (a >= 1e4) return '$' + Math.round(n / 1e3).toLocaleString('es-AR') + ' mil'; return fmt(n); };

// Acepta "1.234,56", "1234.56", "1.500", "1500"
export function parseAmount(raw) {
  let s = String(raw || '').replace(/[\s$]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
const amountToInput = n => n ? String(n).replace('.', ',') : '';

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ================= Datos por defecto ================= */
const PALETTE = ['#2FA37F', '#FF8E72', '#F5B82E', '#5B8DEF', '#4CC9F0', '#9B7BF0', '#7BD389', '#E5534B', '#B9C94F', '#F2A65A', '#8D99AE', '#C9A27E', '#5EC2B7'];
const METHODS = ['Débito', 'Crédito', 'Efectivo', 'Transferencia', 'Mercado Pago'];

function makeHousehold(name, me) {
  const g = [
    ['super', '🛒', 'Súper'], ['comida', '🍕', 'Comida afuera'], ['hogar', '🏠', 'Hogar'], ['servicios', '💡', 'Servicios'],
    ['transporte', '🚗', 'Transporte'], ['salud', '💊', 'Salud'], ['educacion', '📚', 'Educación'], ['ropa', '👕', 'Ropa'],
    ['ocio', '🎉', 'Salidas y ocio'], ['mascotas', '🐾', 'Mascotas'], ['regalos', '🎁', 'Regalos'], ['impuestos', '🧾', 'Impuestos'], ['otros', '📦', 'Otros'],
  ];
  const i = [['sueldo', '💼', 'Sueldo'], ['extra', '💵', 'Extras'], ['otros-ing', '🪙', 'Otros ingresos']];
  return {
    name,
    members: [me.uid],
    memberNames: { [me.uid]: me.name },
    categories: [
      ...g.map(([id, icon, n], k) => ({ id, icon, name: n, kind: 'gasto', color: PALETTE[k % PALETTE.length], budget: 0 })),
      ...i.map(([id, icon, n], k) => ({ id, icon, name: n, kind: 'ingreso', color: ['#1FB394', '#7BD389', '#5EC2B7'][k], budget: 0 })),
    ],
    createdAt: Date.now(),
  };
}

/* ================= Estado ================= */
let store = null;
let unsub = null;
let S = { household: null, movements: [], recurring: [] };
const ui = { view: 'inicio', month: thisMonth(), type: 'todos', cat: '', who: '', q: '' };

const cats = () => S.household?.categories || [];
const catById = id => cats().find(c => c.id === id) || { id, icon: '❔', name: 'Sin categoría', color: '#8D99AE', kind: 'gasto' };
const members = () => Object.entries(S.household?.memberNames || {}).map(([id, name]) => ({ id, name }));
const memberName = id => S.household?.memberNames?.[id] || '';
const inMonth = (ym) => S.movements.filter(m => m.date?.startsWith(ym));
const sum = (arr) => arr.reduce((a, m) => a + (Number(m.amount) || 0), 0);
const bubble = c => `<span class="bubble" style="background:${c.color}26">${esc(c.icon)}</span>`;

/* ================= Arranque ================= */
async function boot() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!firebaseConfig) { attach(createLocalStore(makeHousehold)); return; }

  const { createCloud } = await import('./store-cloud.js');
  let cloud;
  try { cloud = await createCloud(firebaseConfig); }
  catch (e) { console.error(e); appEl.innerHTML = welcome(`<p>No pude conectar con la nube. Revisá tu conexión y volvé a abrir la app.</p>`); return; }

  cloud.onAuth(async user => {
    if (unsub) { unsub(); unsub = null; }
    if (store?.close) store.close();
    store = null;
    if (!user) return showLogin(cloud);
    const params = new URLSearchParams(location.search);
    const joinCode = params.get('unirse');
    let hid = await cloud.getHouseholdId();
    if (joinCode && joinCode !== hid) {
      if (!hid || confirm('¿Querés sumarte al chanchito familiar del link? Vas a dejar de ver el grupo actual.')) {
        try { await cloud.join(joinCode); hid = joinCode; toast('¡Listo! Ya estás en el grupo 🐷'); }
        catch (e) { console.error(e); toast('Ese código no funcionó. Pedí el link de nuevo.'); }
      }
      history.replaceState(null, '', location.pathname);
    }
    if (!hid) return showSetup(cloud);
    attach(cloud.open(hid));
  });
}

function attach(s) {
  store = s;
  unsub = store.subscribe(st => { S = st; materialize(); render(); });
}

/* ================= Gastos fijos y cuotas: generación automática ================= */
const inflight = new Set();
function ruleMovement(r, m) {
  const diff = monthsBetween(r.startMonth, m);
  const day = Math.min(Number(r.day) || 1, daysInMonth(m));
  return {
    type: r.type, amount: r.amount, categoryId: r.categoryId, date: `${m}-${pad(day)}`,
    note: r.note || '', method: r.method || '', by: r.by || '',
    recurringId: r.id, receiptId: r.receiptId || null, installment: r.installments ? { n: diff + 1, total: r.installments } : null,
  };
}
function materialize() {
  const now = thisMonth();
  for (const r of S.recurring) {
    if (r.active === false || !r.startMonth) continue;
    const done = new Set(r.doneMonths || []);
    let m = r.skipBefore && monthsBetween(r.startMonth, r.skipBefore) > 0 ? r.skipBefore : r.startMonth;
    for (let guard = 0; guard < 240 && monthsBetween(m, now) >= 0; guard++, m = addMonths(m, 1)) {
      if (r.installments && monthsBetween(r.startMonth, m) >= r.installments) break;
      const key = `${r.id}_${m}`;
      if (done.has(m) || inflight.has(key)) continue;
      inflight.add(key);
      store.materialize(r, m, ruleMovement(r, m)).catch(e => { console.error(e); inflight.delete(key); });
    }
  }
}

/* ================= Render principal ================= */
function render() {
  if (!S.household) return;
  const views = { inicio: viewHome, movimientos: viewMovs, fijos: viewFijos, ajustes: viewAjustes };
  const scroll = window.scrollY;
  appEl.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <img class="logo" src="icons/icon.svg" alt="">
        <div><h1>Chanchito</h1><div class="sub">${esc(S.household.name)}</div></div>
        <div class="spacer"></div>
        <span class="badge ${store.mode === 'cloud' ? 'cloud' : ''}">${store.mode === 'cloud' ? '☁️ En familia' : '📱 En este equipo'}</span>
      </header>
      ${views[ui.view]()}
    </div>
    <nav class="nav">
      ${navBtn('inicio', '🏡', 'Inicio')}${navBtn('movimientos', '📒', 'Movimientos')}
      <button class="fab" data-act="new" aria-label="Cargar movimiento">+</button>
      ${navBtn('fijos', '🔁', 'Fijos')}${navBtn('ajustes', '⚙️', 'Ajustes')}
    </nav>`;
  window.scrollTo(0, scroll);
}
const navBtn = (v, ic, label) => `<button data-view="${v}" class="${ui.view === v ? 'on' : ''}"><span class="ic">${ic}</span>${label}</button>`;
const monthSwitch = () => `
  <div class="month-switch">
    <button class="icon-btn" data-act="prev" aria-label="Mes anterior">‹</button>
    <strong>${monthLabel(ui.month)}</strong>
    <button class="icon-btn" data-act="next" aria-label="Mes siguiente">›</button>
  </div>`;
const emptyState = (title, text) => `<div class="empty"><img src="icons/icon.svg" alt=""><b>${title}</b>${text}</div>`;

/* ---------- Inicio ---------- */
function viewHome() {
  const ms = inMonth(ui.month);
  const gastos = ms.filter(m => m.type === 'gasto');
  const ingresos = sum(ms.filter(m => m.type === 'ingreso'));
  const totalG = sum(gastos);
  const saldo = ingresos - totalG;
  const prevG = sum(inMonth(addMonths(ui.month, -1)).filter(m => m.type === 'gasto'));

  let mood;
  if (!ms.length) mood = 'Todavía no cargaste nada este mes. ¡Arrancá con el +!';
  else if (!ingresos) mood = 'Cargá los ingresos del mes para ver cuánto te queda.';
  else if (saldo >= ingresos * .2) mood = '¡Vamos bárbaro! El chanchito está engordando 🐷';
  else if (saldo >= 0) mood = 'Vas justo, pero vas. Ojo con los gastos chicos 👀';
  else mood = 'Este mes se gastó más de lo que entró. ¡A ajustar! 💪';

  const vsPrev = prevG > 0 ? Math.round((totalG - prevG) / prevG * 100) : null;

  // por categoría
  const byCat = {};
  gastos.forEach(m => { byCat[m.categoryId] = (byCat[m.categoryId] || 0) + Number(m.amount); });
  const rows = Object.entries(byCat).map(([id, v]) => ({ c: catById(id), v })).sort((a, b) => b.v - a.v);

  // presupuestos
  const budgeted = cats().filter(c => c.kind === 'gasto' && !c.hidden && c.budget > 0);
  const totalBudget = budgeted.reduce((a, c) => a + Number(c.budget), 0);

  const recent = [...ms].sort((a, b) => (b.date + (b.createdAt || 0)).localeCompare(a.date + (a.createdAt || 0))).slice(0, 5);

  return `
    ${monthSwitch()}
    <section class="card hero">
      <div class="label">Te queda este mes</div>
      <div class="big num">${fmt(saldo)}</div>
      <div class="mood">${mood}</div>
      <div class="split">
        <div class="pill"><small>⬆️ Entró</small><b class="num">${fmt(ingresos)}</b></div>
        <div class="pill"><small>⬇️ Salió</small><b class="num">${fmt(totalG)}</b></div>
      </div>
      ${ms.length ? `<button class="wa-btn" data-act="wa"><span>💬</span> Mandar resumen por WhatsApp</button>` : ''}
    </section>

    <section class="card">
      <h2>🍩 ¿En qué se fue la plata? ${vsPrev !== null ? `<span class="right">${vsPrev > 0 ? '▲' : '▼'} ${Math.abs(vsPrev)}% vs mes anterior</span>` : ''}</h2>
      ${rows.length ? `<div class="donut-wrap">${donut(rows, totalG)}
        <ul class="legend">${rows.slice(0, 6).map(r => `<li><span class="dot" style="background:${r.c.color}"></span><span class="name">${esc(r.c.icon)} ${esc(r.c.name)}</span><span class="num">${fmtShort(r.v)}</span><span class="pct">${Math.round(r.v / totalG * 100)}%</span></li>`).join('')}
        ${rows.length > 6 ? `<li class="muted">+ ${rows.length - 6} categorías más</li>` : ''}</ul></div>`
        : emptyState('Nada por acá', 'Cuando cargues gastos vas a ver el reparto por categoría.')}
    </section>

    <section class="card">
      <h2>🎯 Presupuestos ${totalBudget ? `<span class="right num">${fmtShort(sum(gastos.filter(m => budgeted.some(c => c.id === m.categoryId))))} de ${fmtShort(totalBudget)}</span>` : ''}</h2>
      ${budgeted.length ? budgeted.map(c => budgetRow(c, byCat[c.id] || 0)).join('')
        : `<div class="empty" style="padding:8px">Poné un tope mensual a tus categorías y te aviso cuando te estés pasando.<br><br><button class="btn" data-view="ajustes">Definir presupuestos</button></div>`}
    </section>

    <section class="card">
      <h2>🕒 Últimos movimientos ${ms.length > 5 ? `<button class="linkbtn" style="margin-left:auto" data-view="movimientos">Ver todos</button>` : ''}</h2>
      ${recent.length ? `<div class="list" style="box-shadow:none;margin:0 -6px">${recent.map(itemRow).join('')}</div>` : emptyState('Sin movimientos', 'Tocá el + para cargar el primero.')}
    </section>`;
}

function budgetRow(c, spent) {
  const pct = spent / c.budget * 100;
  const cls = pct > 100 ? 'over' : pct >= 80 ? 'warn' : '';
  const left = c.budget - spent;
  return `<div class="budget">
    <div class="top">${esc(c.icon)} ${esc(c.name)}<span class="amt num">${fmtShort(spent)} / ${fmtShort(c.budget)}</span></div>
    <div class="bar ${cls}"><i style="width:${Math.min(pct, 100)}%"></i></div>
    <div class="note ${cls === 'over' ? 'over' : ''}">${cls === 'over' ? `Te pasaste ${fmt(-left)} 😬` : `Quedan ${fmt(left)}${cls === 'warn' ? ' — ¡cuidado!' : ''}`}</div>
  </div>`;
}

function donut(rows, total) {
  const r = 52, C = 2 * Math.PI * r;
  let off = 0;
  const segs = rows.map(({ c, v }) => {
    const len = v / total * C;
    const s = `<circle r="${r}" cx="70" cy="70" fill="none" stroke="${c.color}" stroke-width="22" stroke-dasharray="${Math.max(len - 2, 0.01)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`;
    off += len; return s;
  }).join('');
  return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="Gastos por categoría">${segs}
    <text x="70" y="66" text-anchor="middle" font-size="11" font-weight="800" opacity=".6">Total</text>
    <text x="70" y="84" text-anchor="middle" font-size="15" font-weight="900">${esc(fmtShort(total))}</text></svg>`;
}

function itemRow(m) {
  const c = catById(m.categoryId);
  const who = memberName(m.by);
  const meta = [c.name, m.method, members().length > 1 ? who : ''].filter(Boolean).join(' · ');
  const tag = (m.installment ? `<span class="tag">Cuota ${m.installment.n}/${m.installment.total}</span>` : m.recurringId ? `<span class="tag">Fijo</span>` : '')
    + (m.receiptId ? `<span class="tag clip" title="Tiene comprobante">📎</span>` : '');
  return `<button class="item" data-edit="${esc(m.id)}">
    ${bubble(c)}
    <span class="info"><span class="title">${esc(m.note || c.name)}${tag}</span><span class="meta">${esc(meta)}</span></span>
    <span class="amount num ${m.type === 'ingreso' ? 'pos' : ''}">${m.type === 'ingreso' ? '+' : '−'}${fmt(m.amount)}</span>
  </button>`;
}

/* ---------- Movimientos ---------- */
function viewMovs() {
  let ms = inMonth(ui.month);
  if (ui.type !== 'todos') ms = ms.filter(m => m.type === ui.type);
  if (ui.cat) ms = ms.filter(m => m.categoryId === ui.cat);
  if (ui.who) ms = ms.filter(m => (m.by || '_none') === ui.who);
  if (ui.q) { const q = ui.q.toLowerCase(); ms = ms.filter(m => (m.note || '').toLowerCase().includes(q) || catById(m.categoryId).name.toLowerCase().includes(q)); }
  ms.sort((a, b) => (b.date + (b.createdAt || 0)).localeCompare(a.date + (a.createdAt || 0)));

  const groups = {};
  ms.forEach(m => (groups[m.date] ||= []).push(m));
  const usedCats = [...new Set(inMonth(ui.month).map(m => m.categoryId))].map(catById);
  const net = sum(ms.filter(m => m.type === 'ingreso')) - sum(ms.filter(m => m.type === 'gasto'));
  // Personas: los integrantes del grupo, más cualquiera que figure en movimientos del mes (por si alguien ya no está).
  const whoIds = [...new Set([...members().map(p => p.id), ...inMonth(ui.month).map(m => m.by || '_none')])];
  const people = whoIds.map(id => ({ id, name: id === '_none' ? 'Sin asignar' : (memberName(id) || 'Ex integrante') }));
  const whoSpent = ui.who ? sum(ms.filter(m => m.type === 'gasto')) : 0;

  return `
    ${monthSwitch()}
    <input class="search" type="search" placeholder="🔎 Buscar por detalle o categoría" value="${esc(ui.q)}" data-input="q">
    <div class="filters">
      ${[['todos', 'Todos'], ['gasto', '⬇️ Gastos'], ['ingreso', '⬆️ Ingresos']].map(([v, l]) => `<button class="chip ${ui.type === v ? 'on' : ''}" data-type-filter="${v}">${l}</button>`).join('')}
      ${usedCats.map(c => `<button class="chip ${ui.cat === c.id ? 'on' : ''}" data-cat-filter="${esc(c.id)}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}
    </div>
    ${people.length > 1 ? `<div class="filters">
      <button class="chip ${!ui.who ? 'on' : ''}" data-who-filter="">👥 Todos</button>
      ${people.map(p => `<button class="chip ${ui.who === p.id ? 'on' : ''}" data-who-filter="${esc(p.id)}">🙂 ${esc(p.name)}</button>`).join('')}
    </div>` : ''}
    ${ui.who && ms.length && Math.abs(net + whoSpent) > 0.001 ? `<div class="day-head"><span>Gastó ${esc(people.find(p => p.id === ui.who)?.name || '')}</span><span class="num neg">−${fmt(whoSpent)}</span></div>` : ''}
    ${ms.length ? `<div class="day-head"><span>${ms.length} movimiento${ms.length === 1 ? '' : 's'}</span><span class="num ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</span></div>` : ''}
    ${Object.entries(groups).map(([d, list]) => {
      const dayG = sum(list.filter(m => m.type === 'gasto'));
      return `<div class="day-head"><span>${dayLabel(d)}</span>${dayG ? `<span class="num">−${fmt(dayG)}</span>` : ''}</div>
        <div class="list">${list.map(itemRow).join('')}</div>`;
    }).join('') || `<div class="card">${emptyState('No hay movimientos', ui.q || ui.cat || ui.type !== 'todos' ? 'Probá sacando los filtros.' : 'Tocá el + para cargar el primero.')}</div>`}`;
}

/* ---------- Fijos y cuotas ---------- */
function viewFijos() {
  const now = thisMonth();
  const status = r => {
    if (r.active === false) return { txt: 'En pausa', live: false };
    const diff = monthsBetween(r.startMonth, now);
    if (r.installments) {
      if (diff >= r.installments) return { txt: `Terminada (${r.installments} cuotas)`, live: false };
      if (diff < 0) return { txt: `Arranca en ${monthLabel(r.startMonth)}`, live: true };
      return { txt: `Cuota ${diff + 1} de ${r.installments} · termina ${monthLabel(addMonths(r.startMonth, r.installments - 1))}`, live: true };
    }
    return { txt: diff < 0 ? `Arranca en ${monthLabel(r.startMonth)}` : `Todos los meses, día ${r.day}`, live: true };
  };
  const list = S.recurring.map(r => ({ r, s: status(r) })).sort((a, b) => (b.s.live - a.s.live) || (a.r.day - b.r.day));
  const live = list.filter(x => x.s.live && monthsBetween(x.r.startMonth, now) >= 0);
  const monthlyG = sum(live.filter(x => x.r.type === 'gasto').map(x => x.r));
  const cuotas = sum(live.filter(x => x.r.type === 'gasto' && x.r.installments).map(x => x.r));

  const row = ({ r, s }) => {
    const c = catById(r.categoryId);
    return `<button class="item" data-edit-rule="${esc(r.id)}" style="${s.live ? '' : 'opacity:.55'}">
      ${bubble(c)}
      <span class="info"><span class="title">${esc(r.note || c.name)}</span><span class="meta">${esc(s.txt)}</span></span>
      <span class="amount num ${r.type === 'ingreso' ? 'pos' : ''}">${fmt(r.amount)}</span>
    </button>`;
  };

  return `
    <section class="card hero" style="margin-top:6px">
      <div class="label">Compromisos de cada mes</div>
      <div class="big num">${fmt(monthlyG)}</div>
      <div class="mood">${cuotas ? `De eso, ${fmt(cuotas)} son cuotas de tarjeta 💳` : 'Gastos fijos que se cargan solos cada mes.'}</div>
    </section>
    <div class="day-head"><span>Fijos y cuotas</span></div>
    ${list.length ? `<div class="list">${list.map(row).join('')}</div>`
      : `<div class="card">${emptyState('Sin gastos fijos', 'Alquiler, expensas, luz, internet, colegio, cuotas… Cargalos una vez y se agregan solos todos los meses.')}</div>`}
    <div style="margin-top:14px"><button class="btn primary block" data-act="new-rule">+ Agregar fijo o cuota</button></div>`;
}

/* ---------- Ajustes ---------- */
function viewAjustes() {
  const h = S.household;
  const gastoCats = cats().filter(c => c.kind === 'gasto');
  const ingCats = cats().filter(c => c.kind === 'ingreso');
  const catRow = c => `<div class="set-row" style="${c.hidden ? 'opacity:.5' : ''}">
      ${bubble(c)}<span class="grow">${esc(c.name)}<small>${c.hidden ? 'Oculta' : c.kind === 'gasto' ? (c.budget > 0 ? `Tope: ${fmt(c.budget)}/mes` : 'Sin tope') : 'Ingreso'}</small></span>
      <button class="linkbtn" data-edit-cat="${esc(c.id)}">Editar</button></div>`;
  const invite = store.mode === 'cloud' ? `${location.origin}${location.pathname}?unirse=${store.householdId}` : '';

  return `
    <section class="card" style="margin-top:6px">
      <h2>👨‍👩‍👧 Familia</h2>
      <div class="field">Nombre del grupo<input data-hh-name value="${esc(h.name)}" maxlength="40"></div>
      ${members().map(m => `<div class="set-row"><span class="bubble" style="background:var(--brand-soft)">🙂</span><span class="grow">${esc(m.name)}${store.me?.uid === m.id ? '<small>Vos</small>' : ''}</span>
        ${store.mode === 'local' && m.id !== 'yo' ? `<button class="linkbtn" data-del-member="${esc(m.id)}">Quitar</button>` : ''}</div>`).join('')}
      ${store.mode === 'cloud' ? `
        <p class="muted" style="font-weight:700">Para que alguien se sume, mandale este link. Entra con su cuenta de Google y listo:</p>
        <div class="code">${esc(invite)}</div>
        <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-share="${esc(invite)}">📤 Compartir link</button></div>`
      : `<div class="btn-row" style="margin-top:10px"><button class="btn" data-act="add-member">+ Agregar integrante</button></div>
         <p class="muted" style="font-weight:700;font-size:.85rem">Estás en modo <b>este equipo</b>: los datos quedan solo acá. Para cargar entre todos desde cada celular, activá la nube (ver LEEME.md).</p>`}
    </section>

    <section class="card">
      <h2>🏷️ Categorías de gastos y presupuestos</h2>
      ${gastoCats.map(catRow).join('')}
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-act="new-cat" data-kind="gasto">+ Nueva categoría</button></div>
    </section>

    <section class="card">
      <h2>💰 Categorías de ingresos</h2>
      ${ingCats.map(catRow).join('')}
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-act="new-cat" data-kind="ingreso">+ Nueva categoría</button></div>
    </section>

    <section class="card">
      <h2>📦 Tus datos</h2>
      <div class="btn-row">
        <button class="btn" data-act="csv-month">📄 Excel del mes</button>
        <button class="btn" data-act="csv-all">📚 Excel de todo</button>
        ${store.mode === 'local' ? `<button class="btn" data-act="backup">💾 Copia de seguridad</button><button class="btn" data-act="restore">♻️ Restaurar copia</button>` : ''}
      </div>
      ${store.mode === 'cloud' ? `<div style="margin-top:14px"><button class="btn ghost" data-act="logout">Cerrar sesión (${esc(store.me?.name || '')})</button></div>` : ''}
    </section>
    <p class="muted" style="text-align:center;font-size:.8rem;font-weight:700">Chanchito 🐷 · hecho para la casa</p>`;
}

/* ================= Hojas (formularios) ================= */
function openSheet(html, onMount) {
  sheetRoot.innerHTML = `<div class="backdrop" data-close></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  document.body.style.overflow = 'hidden';
  onMount?.($('.sheet', sheetRoot));
}
function closeSheet() { sheetRoot.innerHTML = ''; document.body.style.overflow = ''; }

function catChips(kind, selected) {
  return cats().filter(c => c.kind === kind && (!c.hidden || c.id === selected))
    .map(c => `<button type="button" class="cat ${c.id === selected ? 'on' : ''}" data-cat="${esc(c.id)}"><span class="e">${esc(c.icon)}</span>${esc(c.name)}</button>`).join('');
}
const memberOptions = sel => members().map(m => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
const methodOptions = sel => `<option value="">—</option>` + METHODS.map(x => `<option ${x === sel ? 'selected' : ''}>${x}</option>`).join('');

function movementForm(m) {
  const isNew = !m;
  const f = m || { type: 'gasto', amount: '', categoryId: '', date: ui.month === thisMonth() ? todayISO() : `${ui.month}-01`, note: '', method: '', by: store.me?.uid };
  let type = f.type, cat = f.categoryId;

  openSheet(`
    <h3>${isNew ? '¿Qué movimiento cargamos?' : 'Editar movimiento'}</h3>
    ${isNew ? `<div class="scan-box">
        <div class="scan-title"><b>🧾 Leer un comprobante</b><small>Completo los datos solo a partir de la foto</small></div>
        <div class="scan-actions">
          <button type="button" class="scan-btn" data-pick="camera"><span class="ic">📷</span>Sacar foto</button>
          <button type="button" class="scan-btn alt" data-pick="gallery"><span class="ic">🖼️</span>Galería</button>
        </div>
      </div>` : ''}
    ${m?.receiptId ? `<button type="button" class="btn block" id="view-receipt" style="margin-bottom:12px">🧾 Ver comprobante</button>` : ''}
    ${!isNew && !m.receiptId && store.saveReceipt ? `<div class="scan-actions" style="margin-bottom:12px">
        <button type="button" class="scan-btn" data-pick="camera" data-attach><span class="ic">📷</span>Sacar foto</button>
        <button type="button" class="scan-btn alt" data-pick="gallery" data-attach><span class="ic">🖼️</span>Adjuntar de galería</button>
      </div>` : ''}
    <input type="file" id="scan-camera" accept="image/*" capture="environment" hidden>
    <input type="file" id="scan-file" accept="image/*" hidden>
    <div id="scan-state" class="scan-state" hidden></div>
    <form id="mf" autocomplete="off">
      <div class="seg"><button type="button" data-type="gasto">⬇️ Gasto</button><button type="button" data-type="ingreso">⬆️ Ingreso</button></div>
      <label class="amount-input"><span>$</span><input name="amount" inputmode="decimal" placeholder="0" value="${esc(amountToInput(f.amount))}" required aria-label="Monto"></label>
      <div class="cats" id="cats"></div>
      <div class="field">Detalle<input name="note" maxlength="60" placeholder="Ej: Coto, nafta, cumple de Juli" value="${esc(f.note)}"></div>
      <div class="row2">
        <div class="field">Fecha<input type="date" name="date" value="${esc(f.date)}" required></div>
        <div class="field">Medio de pago<select name="method">${methodOptions(f.method)}</select></div>
      </div>
      ${members().length > 1 ? `<div class="field">¿Quién?<select name="by">${memberOptions(f.by)}</select></div>` : ''}
      ${isNew ? `
        <div class="field" id="cuotas-wrap" hidden>¿En cuántas cuotas?<input type="number" name="cuotas" min="1" max="60" value="1"></div>
        <div class="hint" id="cuota-hint" hidden></div>
        <label class="check" id="repeat-wrap"><input type="checkbox" name="repeat"> Se repite todos los meses (gasto fijo)</label>` : ''}
      ${m?.recurringId ? `<div class="hint">${m.installment ? `Cuota ${m.installment.n} de ${m.installment.total}` : 'Gasto fijo'}: los cambios acá afectan solo este mes. Para cambiar todos, andá a Fijos.</div>` : ''}
      <div class="actions">
        ${isNew ? `<button type="button" class="btn" data-close>Cancelar</button>` : `<button type="button" class="btn danger" id="del">🗑️</button>`}
        <button class="btn primary" type="submit">${isNew ? 'Guardar' : 'Guardar cambios'}</button>
      </div>
    </form>`, sheet => {
    const form = $('#mf', sheet);
    const paint = () => {
      sheet.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.type === type));
      $('#cats', sheet).innerHTML = catChips(type, cat);
      if (isNew) {
        const credit = type === 'gasto' && form.method.value === 'Crédito';
        $('#cuotas-wrap', sheet).hidden = !credit;
        const n = Number(form.cuotas.value) || 1;
        const amt = parseAmount(form.amount.value);
        const hint = $('#cuota-hint', sheet);
        hint.hidden = !(credit && n > 1);
        if (credit && n > 1) hint.textContent = Number.isFinite(amt) ? `💳 ${n} cuotas de ${fmt(amt / n)} — se cargan solas cada mes` : `💳 Poné el monto total de la compra`;
        $('#repeat-wrap', sheet).hidden = credit && n > 1;
      }
    };
    paint();
    sheet.querySelectorAll('.seg button').forEach(b => b.onclick = () => { type = b.dataset.type; if (catById(cat).kind !== type) cat = ''; paint(); });
    $('#cats', sheet).onclick = e => { const b = e.target.closest('[data-cat]'); if (b) { cat = b.dataset.cat; paint(); } };
    form.addEventListener('input', e => { if (['method', 'cuotas', 'amount'].includes(e.target.name) && isNew) paint(); });
    if (isNew) warmUpReader();   // va descargando el lector mientras elegís la foto

    // ---- Comprobante: foto + lectura en el celular ----
    const canAttach = !!store.saveReceipt;
    const kept = canAttach ? ' La foto queda adjunta.' : '';
    let receipt = null;          // foto achicada para guardar
    let scanMode = 'read';       // 'read' = leer con IA, 'attach' = solo adjuntar
    const cameraInput = $('#scan-camera', sheet);
    const galleryInput = $('#scan-file', sheet);
    const scanState = $('#scan-state', sheet);
    const showState = (html, cls = '') => { scanState.hidden = false; scanState.className = 'scan-state ' + cls; scanState.innerHTML = html; };
    sheet.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
      scanMode = 'attach' in b.dataset ? 'attach' : 'read';
      (b.dataset.pick === 'camera' ? cameraInput : galleryInput).click();
    }));
    $('#view-receipt', sheet)?.addEventListener('click', () => viewReceipt(m.receiptId));
    const onPicked = async (input) => {
      const file = input.files[0]; input.value = '';
      if (!file) return;
      let img;
      try { img = await loadImage(file); } catch { showState('No pude abrir esa imagen. Probá con otra.', 'err'); return; }
      const small = shrink(img, 1100, 0.6, 700_000);
      receipt = canAttach ? small : null;
      const thumb = `<img src="${small}" alt="Comprobante">`;
      if (scanMode === 'attach') { showState(`${thumb}<span>📎 Foto lista. Se guarda al tocar "Guardar cambios".</span>`, 'ok'); return; }
      showState(`${thumb}<span><span class="spinner"></span> <span id="scan-msg">Preparando el lector (la primera vez tarda un poco)…</span></span>`);
      sheet.querySelectorAll('button').forEach(b => b.disabled = true);
      try {
        const datos = await readTicketOnDevice(img, {
          hoy: todayISO(),
          onProgress: p => { const el = $('#scan-msg', sheet); if (el) el.textContent = `Leyendo el comprobante… ${p}%`; },
        });
        if (!datos.es_comprobante) { showState(`${thumb}<span>🤔 No pude encontrar los datos en esta foto. Probá con más luz y el ticket derecho, o cargalo a mano.${kept}</span>`, 'warn'); return; }
        type = 'gasto';
        if (datos.monto_total > 0) form.amount.value = amountToInput(Math.round(datos.monto_total * 100) / 100);
        if (/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha || '')) form.date.value = datos.fecha;
        if (datos.comercio && !form.note.value) form.note.value = datos.comercio.slice(0, 60);
        if (datos.categoria_id && cats().some(c => c.id === datos.categoria_id && c.kind === 'gasto')) cat = datos.categoria_id;
        if (METHODS.includes(datos.medio_pago)) form.method.value = datos.medio_pago;
        if (datos.cuotas > 1 && form.cuotas) { form.method.value = 'Crédito'; form.cuotas.value = Math.min(datos.cuotas, 60); }
        paint();
        const dudoso = datos.confianza !== 'alta' || !(datos.monto_total > 0);
        showState(`${thumb}<span>${!(datos.monto_total > 0) ? '⚠️ No encontré el total. Completá el monto a mano.' : dudoso ? '⚠️ Lo leí, pero no estoy del todo seguro. <b>Revisá el monto</b> antes de guardar.' : '✅ Listo. Revisá los datos y guardá.'}</span>`, dudoso ? 'warn' : 'ok');
      } catch (err) {
        console.error(err);
        showState(`${thumb}<span>😕 ${esc(err.message || 'No se pudo leer.')} Completalo a mano.${kept}</span>`, 'err');
      } finally {
        sheet.querySelectorAll('button').forEach(b => b.disabled = false);
      }
    };
    cameraInput.addEventListener('change', () => onPicked(cameraInput));
    galleryInput.addEventListener('change', () => onPicked(galleryInput));

    $('#del', sheet)?.addEventListener('click', async () => {
      if (!confirm('¿Borrar este movimiento?')) return;
      await store.deleteMovement(m.id);
      if (m.receiptId && !m.recurringId) store.deleteReceipt?.(m.receiptId).catch(() => {});
      closeSheet(); toast('Movimiento borrado');
    });

    form.onsubmit = async e => {
      e.preventDefault();
      const amount = parseAmount(form.amount.value);
      if (!(amount > 0)) { toast('Poné un monto válido'); form.amount.focus(); return; }
      if (!cat) { toast('Elegí una categoría'); return; }
      const data = { type, amount, categoryId: cat, date: form.date.value, note: form.note.value.trim(), method: form.method.value, by: form.by?.value || store.me?.uid || '' };
      const submitBtn = form.querySelector('[type="submit"]');
      submitBtn.disabled = true;
      try {
        if (receipt) { const rid = uid(); await store.saveReceipt(rid, receipt); data.receiptId = rid; }
        if (!isNew) { await store.updateMovement(m.id, data); toast('Cambios guardados ✔️'); }
        else {
          const n = Number(form.cuotas?.value) || 1;
          const credit = type === 'gasto' && data.method === 'Crédito';
          if (credit && n > 1) {
            await store.saveRecurring({ ...ruleFrom(data), amount: Math.round(amount / n * 100) / 100, installments: n });
            toast(`Listo: ${n} cuotas de ${fmt(amount / n)} 💳`);
          } else if (form.repeat?.checked) {
            await store.saveRecurring({ ...ruleFrom(data), installments: null });
            toast('Gasto fijo creado 🔁');
          } else {
            await store.addMovement(data);
            toast(type === 'gasto' ? '¡Anotado! 🐷' : '¡Qué bueno! Ingreso anotado 💰');
          }
        }
        closeSheet();
      } catch (err) { console.error(err); toast('No se pudo guardar. Probá de nuevo.'); submitBtn.disabled = false; }
    };
  });
}

/* ================= Fotos de comprobantes ================= */
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}
// Achica la foto a "max" px del lado más largo, en JPEG, bajando calidad hasta entrar en "limit" caracteres.
function shrink(img, max, quality, limit) {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  let q = quality, out = c.toDataURL('image/jpeg', q);
  while (out.length > limit && q > 0.3) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
  return out;
}
async function viewReceipt(id) {
  toast('Abriendo comprobante…');
  try {
    const dataUrl = await store.getReceipt(id);
    if (!dataUrl) return toast('No encontré la foto de este comprobante');
    const ov = document.createElement('div');
    ov.className = 'receipt-view';
    ov.innerHTML = `<img src="${dataUrl}" alt="Comprobante"><button class="btn" aria-label="Cerrar">✕ Cerrar</button>`;
    ov.onclick = () => ov.remove();
    document.body.appendChild(ov);
  } catch (e) { console.error(e); toast('No se pudo abrir el comprobante'); }
}
const ruleFrom = d => ({ type: d.type, amount: d.amount, categoryId: d.categoryId, note: d.note, method: d.method, by: d.by, day: Number(d.date.slice(8, 10)), startMonth: d.date.slice(0, 7), active: true, receiptId: d.receiptId || null });

function ruleForm(r) {
  const isNew = !r;
  const f = r || { type: 'gasto', amount: '', categoryId: '', note: '', method: '', by: store.me?.uid, day: new Date().getDate(), startMonth: thisMonth(), installments: null, active: true };
  let type = f.type, cat = f.categoryId;
  openSheet(`
    <h3>${isNew ? 'Nuevo fijo o cuota' : 'Editar fijo o cuota'}</h3>
    <form id="rf" autocomplete="off">
      <div class="seg"><button type="button" data-type="gasto">⬇️ Gasto</button><button type="button" data-type="ingreso">⬆️ Ingreso</button></div>
      <label class="amount-input"><span>$</span><input name="amount" inputmode="decimal" placeholder="0" value="${esc(amountToInput(f.amount))}" required aria-label="Monto por mes o por cuota"></label>
      <div class="cats" id="cats"></div>
      <div class="field">Detalle<input name="note" maxlength="60" placeholder="Ej: Alquiler, Netflix, Heladera 12 cuotas" value="${esc(f.note)}"></div>
      <div class="row2">
        <div class="field">Día del mes<input type="number" name="day" min="1" max="31" value="${esc(f.day)}" required></div>
        <div class="field">Desde<input type="month" name="startMonth" value="${esc(f.startMonth)}" required></div>
      </div>
      <div class="row2">
        <div class="field">Cantidad de cuotas<input type="number" name="installments" min="1" max="120" placeholder="Sin fin" value="${esc(f.installments || '')}"></div>
        <div class="field">Medio de pago<select name="method">${methodOptions(f.method)}</select></div>
      </div>
      ${members().length > 1 ? `<div class="field">¿Quién paga?<select name="by">${memberOptions(f.by)}</select></div>` : ''}
      ${!isNew ? `<label class="check"><input type="checkbox" name="active" ${f.active !== false ? 'checked' : ''}> Activo (si lo pausás, no se carga más)</label>` : ''}
      <div class="hint">El monto es por mes (o por cuota). Se carga solo en Movimientos el día indicado. Los meses ya cargados no cambian.</div>
      <div class="actions">
        ${isNew ? `<button type="button" class="btn" data-close>Cancelar</button>` : `<button type="button" class="btn danger" id="del">🗑️</button>`}
        <button class="btn primary" type="submit">Guardar</button>
      </div>
    </form>`, sheet => {
    const form = $('#rf', sheet);
    const paint = () => {
      sheet.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.type === type));
      $('#cats', sheet).innerHTML = catChips(type, cat);
    };
    paint();
    sheet.querySelectorAll('.seg button').forEach(b => b.onclick = () => { type = b.dataset.type; if (catById(cat).kind !== type) cat = ''; paint(); });
    $('#cats', sheet).onclick = e => { const b = e.target.closest('[data-cat]'); if (b) { cat = b.dataset.cat; paint(); } };
    $('#del', sheet)?.addEventListener('click', async () => {
      if (!confirm('¿Borrar este fijo? Los meses que ya se cargaron quedan en Movimientos.')) return;
      await store.deleteRecurring(r.id); closeSheet(); toast('Fijo borrado');
    });
    form.onsubmit = async e => {
      e.preventDefault();
      const amount = parseAmount(form.amount.value);
      if (!(amount > 0)) { toast('Poné un monto válido'); return; }
      if (!cat) { toast('Elegí una categoría'); return; }
      const active = isNew ? true : form.active.checked;
      const data = {
        type, amount, categoryId: cat, note: form.note.value.trim(), method: form.method.value, by: form.by?.value || store.me?.uid || '',
        day: Math.min(Math.max(Number(form.day.value) || 1, 1), 31), startMonth: form.startMonth.value,
        installments: Number(form.installments.value) || null, active,
      };
      if (!isNew && r.active === false && active) data.skipBefore = thisMonth(); // al reactivar no rellena meses pausados
      try {
        await store.saveRecurring(isNew ? data : { ...data, id: r.id });
        closeSheet(); toast(isNew ? 'Fijo creado 🔁' : 'Cambios guardados ✔️');
      } catch (err) { console.error(err); toast('No se pudo guardar.'); }
    };
  });
}

const EMOJIS = ['🛒', '🍕', '🏠', '💡', '🚗', '⛽', '🚌', '💊', '🩺', '📚', '🎒', '👕', '👟', '🎉', '🍿', '✈️', '🏖️', '🐾', '🎁', '🧾', '📱', '💻', '📺', '🎮', '⚽', '🎾', '💇', '🧴', '🧹', '🔧', '👶', '🍼', '☕', '🍷', '🏋️', '💳', '🏦', '💼', '💵', '🪙', '📦', '❤️'];
function catForm(c, kind) {
  const isNew = !c;
  const f = c || { id: '', icon: kind === 'ingreso' ? '💵' : '📦', name: '', kind, color: PALETTE[cats().length % PALETTE.length], budget: 0, hidden: false };
  let icon = f.icon, color = f.color;
  openSheet(`
    <h3>${isNew ? 'Nueva categoría' : 'Editar categoría'}</h3>
    <form id="cf" autocomplete="off">
      <div class="field">Nombre<input name="name" maxlength="24" required value="${esc(f.name)}" placeholder="Ej: Colegio"></div>
      <div class="field">Ícono</div>
      <div class="cats" id="emo" style="grid-template-columns:repeat(7,1fr)"></div>
      <div class="field">Color</div>
      <div class="btn-row" id="col" style="margin-bottom:14px"></div>
      ${f.kind === 'gasto' ? `<div class="field">Tope mensual (presupuesto)<input name="budget" inputmode="decimal" placeholder="Sin tope" value="${esc(amountToInput(f.budget))}"></div>` : ''}
      ${!isNew ? `<label class="check"><input type="checkbox" name="hidden" ${f.hidden ? 'checked' : ''}> Ocultar (no aparece al cargar; el historial queda)</label>` : ''}
      <div class="actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Guardar</button></div>
    </form>`, sheet => {
    const paint = () => {
      $('#emo', sheet).innerHTML = EMOJIS.map(e => `<button type="button" class="cat ${e === icon ? 'on' : ''}" data-emo="${e}"><span class="e">${e}</span></button>`).join('');
      $('#col', sheet).innerHTML = PALETTE.map(p => `<button type="button" data-col="${p}" aria-label="Color ${p}" style="width:34px;height:34px;border-radius:50%;border:3px solid ${p === color ? 'var(--ink)' : 'transparent'};background:${p}"></button>`).join('');
    };
    paint();
    sheet.addEventListener('click', e => {
      const em = e.target.closest('[data-emo]'); if (em) { icon = em.dataset.emo; paint(); }
      const co = e.target.closest('[data-col]'); if (co) { color = co.dataset.col; paint(); }
    });
    $('#cf', sheet).onsubmit = async e => {
      e.preventDefault();
      const form = e.target;
      const budget = form.budget ? (parseAmount(form.budget.value) || 0) : 0;
      const updated = { ...f, id: f.id || uid(), name: form.name.value.trim(), icon, color, budget, hidden: form.hidden ? form.hidden.checked : false };
      const list = isNew ? [...cats(), updated] : cats().map(x => x.id === f.id ? updated : x);
      await store.updateHousehold({ categories: list });
      closeSheet(); toast('Categoría guardada ✔️');
    };
  });
}

/* ================= Resumen para WhatsApp ================= */
function summaryText(ym) {
  const ms = inMonth(ym);
  const gastos = ms.filter(m => m.type === 'gasto');
  const ing = sum(ms.filter(m => m.type === 'ingreso'));
  const totalG = sum(gastos);
  const saldo = ing - totalG;
  const prevG = sum(inMonth(addMonths(ym, -1)).filter(m => m.type === 'gasto'));
  const byCat = {};
  gastos.forEach(m => { byCat[m.categoryId] = (byCat[m.categoryId] || 0) + Number(m.amount); });
  const rows = Object.entries(byCat).map(([id, v]) => ({ c: catById(id), v })).sort((a, b) => b.v - a.v);
  const fixed = sum(gastos.filter(m => m.recurringId && !m.installment));
  const cuotas = sum(gastos.filter(m => m.installment));

  const L = [`🐷 *Chanchito · ${monthLabel(ym)}*`, `_${S.household.name}_`, ''];
  L.push(`⬆️ Entró: *${fmt(ing)}*`);
  L.push(`⬇️ Salió: *${fmt(totalG)}*`);
  L.push(`${saldo >= 0 ? '💰 Queda' : '🔴 Faltante'}: *${fmt(Math.abs(saldo))}*${ing > 0 && saldo >= 0 ? ` (${Math.round(saldo / ing * 100)}% de lo que entró)` : ''}`);
  if (prevG > 0) { const p = Math.round((totalG - prevG) / prevG * 100); L.push(`${p > 0 ? '📈' : '📉'} Gastos ${p > 0 ? '+' : ''}${p}% vs ${monthLabel(addMonths(ym, -1)).split(' ')[0].toLowerCase()}`); }
  if (rows.length) {
    L.push('', '*¿En qué se fue?*');
    rows.slice(0, 8).forEach(r => L.push(`${r.c.icon} ${r.c.name}: ${fmt(r.v)} (${Math.round(r.v / totalG * 100)}%)`));
    if (rows.length > 8) L.push(`➕ Otras ${rows.length - 8}: ${fmt(rows.slice(8).reduce((a, r) => a + r.v, 0))}`);
  }
  const budgeted = cats().filter(c => c.kind === 'gasto' && !c.hidden && c.budget > 0);
  if (budgeted.length) {
    L.push('', '*Presupuestos*');
    budgeted.forEach(c => {
      const sp = byCat[c.id] || 0; const pct = sp / c.budget * 100;
      L.push(`${pct > 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢'} ${c.name}: ${fmt(sp)} de ${fmt(c.budget)}${pct > 100 ? ` · pasado ${fmt(sp - c.budget)}` : ''}`);
    });
  }
  if (fixed || cuotas) {
    L.push('', '*Compromisos*');
    if (fixed) L.push(`🔁 Fijos: ${fmt(fixed)}`);
    if (cuotas) L.push(`💳 Cuotas: ${fmt(cuotas)}`);
  }
  if (members().length > 1) {
    const byWho = {};
    gastos.forEach(m => { const n = memberName(m.by) || 'Sin asignar'; byWho[n] = (byWho[n] || 0) + Number(m.amount); });
    L.push('', '*¿Quién pagó?*');
    Object.entries(byWho).sort((a, b) => b[1] - a[1]).forEach(([n, v]) => L.push(`🙂 ${n}: ${fmt(v)}`));
  }
  return L.join('\n');
}

function shareWhatsApp() {
  const text = summaryText(ui.month);
  openSheet(`
    <h3>💬 Resumen de ${monthLabel(ui.month)}</h3>
    <div class="wa-preview">${esc(text).replace(/\*(.+?)\*/g, '<b>$1</b>').replace(/_(.+?)_/g, '<i>$1</i>')}</div>
    <div class="actions">
      <button type="button" class="btn" id="copy">📋 Copiar</button>
      <button type="button" class="btn wa" id="send">Enviar por WhatsApp</button>
    </div>`, sheet => {
    $('#send', sheet).onclick = () => { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank'); closeSheet(); };
    $('#copy', sheet).onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast('Resumen copiado 📋'); } catch { toast('No se pudo copiar'); }
    };
  });
}

/* ================= Exportar ================= */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportCSV(onlyMonth) {
  const ms = (onlyMonth ? inMonth(ui.month) : S.movements).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (!ms.length) return toast('No hay movimientos para exportar');
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Fecha', 'Tipo', 'Categoría', 'Detalle', 'Monto', 'Medio de pago', 'Quién', 'Cuota'].join(';')];
  ms.forEach(m => lines.push([m.date, m.type === 'gasto' ? 'Gasto' : 'Ingreso', catById(m.categoryId).name, m.note, String(m.type === 'gasto' ? -m.amount : m.amount).replace('.', ','), m.method, memberName(m.by), m.installment ? `${m.installment.n}/${m.installment.total}` : ''].map(q).join(';')));
  download(`chanchito-${onlyMonth ? ui.month : 'todo'}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

/* ================= Eventos ================= */
document.addEventListener('click', async e => {
  const t = e.target.closest('button, [data-close]');
  if (!t) return;
  const d = t.dataset;
  if ('close' in d) return closeSheet();
  if (d.view) { ui.view = d.view; render(); window.scrollTo(0, 0); return; }
  if (d.edit) { const m = S.movements.find(x => x.id === d.edit); if (m) movementForm(m); return; }
  if (d.editRule) { const r = S.recurring.find(x => x.id === d.editRule); if (r) ruleForm(r); return; }
  if (d.editCat) { catForm(cats().find(c => c.id === d.editCat)); return; }
  if (d.typeFilter) { ui.type = d.typeFilter; render(); return; }
  if (d.catFilter) { ui.cat = ui.cat === d.catFilter ? '' : d.catFilter; render(); return; }
  if ('whoFilter' in d) { ui.who = ui.who === d.whoFilter ? '' : d.whoFilter; render(); return; }
  if (d.delMember) {
    const names = { ...S.household.memberNames }; delete names[d.delMember];
    await store.updateHousehold({ memberNames: names, members: Object.keys(names) }); return;
  }
  if (d.share) {
    if (navigator.share) navigator.share({ title: 'Chanchito', text: 'Sumate a nuestro Chanchito para anotar los gastos de casa 🐷', url: d.share }).catch(() => {});
    else { await navigator.clipboard?.writeText(d.share); toast('Link copiado 📋'); }
    return;
  }
  switch (d.act) {
    case 'new': return movementForm(null);
    case 'wa': return shareWhatsApp();
    case 'new-rule': return ruleForm(null);
    case 'new-cat': return catForm(null, d.kind);
    case 'prev': ui.month = addMonths(ui.month, -1); ui.cat = ''; return render();
    case 'next': ui.month = addMonths(ui.month, 1); ui.cat = ''; return render();
    case 'add-member': {
      const name = prompt('¿Cómo se llama?')?.trim();
      if (!name) return;
      await store.updateHousehold({ memberNames: { ...S.household.memberNames, [uid()]: name.slice(0, 24) } });
      return;
    }
    case 'csv-month': return exportCSV(true);
    case 'csv-all': return exportCSV(false);
    case 'backup': return download(`chanchito-copia-${todayISO()}.json`, JSON.stringify(store.exportAll(), null, 1), 'application/json');
    case 'restore': {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
      inp.onchange = async () => {
        try {
          const data = JSON.parse(await inp.files[0].text());
          if (!confirm('Esto reemplaza TODOS los datos actuales por los de la copia. ¿Seguimos?')) return;
          await store.importAll(data); toast('Copia restaurada ✔️');
        } catch { toast('Ese archivo no es una copia válida'); }
      };
      inp.click(); return;
    }
    case 'logout': if (confirm('¿Cerrar sesión?')) store.signOut(); return;
  }
});

let qTimer;
document.addEventListener('input', e => {
  if (e.target.dataset.input === 'q') {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { ui.q = e.target.value; render(); const s = $('.search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 250);
  }
});
document.addEventListener('change', async e => {
  if ('hhName' in e.target.dataset) {
    const name = e.target.value.trim(); if (name) { await store.updateHousehold({ name: name.slice(0, 40) }); toast('Nombre actualizado'); }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetRoot.innerHTML) closeSheet(); });

/* ================= Pantallas de login (modo nube) ================= */
function welcome(inner) {
  return `<div class="welcome"><img src="icons/icon.svg" alt="Chanchito"><h1>Chanchito</h1><p>Los gastos de tu casa, en familia y sin vueltas.</p>${inner}</div>`;
}
function showLogin(cloud) {
  appEl.innerHTML = welcome(`<button class="btn primary block" id="login">Entrar con Google</button>
    <p style="font-size:.85rem">Cada integrante entra con su propia cuenta y todos ven los mismos números.</p>`);
  $('#login').onclick = () => cloud.signIn().catch(err => { console.error(err); toast('No se pudo entrar. Probá de nuevo.'); });
}
function showSetup(cloud) {
  appEl.innerHTML = welcome(`
    <div class="card">
      <h2>🐷 Crear el chanchito de tu casa</h2>
      <div class="field">¿Cómo le ponemos?<input id="hname" placeholder="Ej: Casa de los García" maxlength="40"></div>
      <button class="btn primary block" id="create">Crear</button>
    </div>
    <div class="card">
      <h2>🔗 ¿Ya te invitaron?</h2>
      <p class="muted" style="font-weight:700;margin-top:0">Abrí el link que te mandaron, o pegá el código acá:</p>
      <div class="field"><input id="hcode" placeholder="Código o link"></div>
      <button class="btn block" id="join">Sumarme</button>
    </div>
    <button class="btn ghost" id="out">Usar otra cuenta</button>`);
  // Un solo toque: se bloquean los botones mientras se crea o se une, para no generar grupos repetidos.
  const busy = on => appEl.querySelectorAll('.welcome button').forEach(b => { b.disabled = on; b.style.opacity = on ? .6 : ''; });
  $('#create').onclick = async () => {
    const name = $('#hname').value.trim() || 'Mi casa';
    busy(true); $('#create').textContent = 'Creando…';
    try { const hid = await cloud.createHousehold(makeHousehold(name, cloud.me())); attach(cloud.open(hid)); }
    catch (e) { console.error(e); toast('No se pudo crear. Probá de nuevo.'); busy(false); $('#create').textContent = 'Crear'; }
  };
  $('#join').onclick = async () => {
    let code = $('#hcode').value.trim();
    const m = code.match(/unirse=([\w-]+)/); if (m) code = m[1];
    if (!code) return;
    busy(true);
    try { await cloud.join(code); attach(cloud.open(code)); toast('¡Listo! Ya estás en el grupo 🐷'); }
    catch (e) { console.error(e); toast('Ese código no funcionó.'); busy(false); }
  };
  $('#out').onclick = () => cloud.signOut();
}

boot();
