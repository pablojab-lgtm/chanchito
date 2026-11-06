// Lector de comprobantes que corre 100% en el celular (Tesseract.js, gratis, sin servidor).
// La primera vez descarga el motor y el idioma español (~5 MB); después queda en caché.
// Devuelve lo mismo que esperaba el formulario: monto_total, fecha, comercio, categoria_id, medio_pago, cuotas, confianza.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let workerPromise = null;
let progressCb = () => {};

function loadScript(src) {
  return new Promise((ok, ko) => {
    if (window.Tesseract) return ok();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = ok; s.onerror = () => ko(new Error('No se pudo descargar el lector. ¿Tenés internet?'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT_URL);
      return window.Tesseract.createWorker('spa', 1, {
        logger: m => { if (m.status === 'recognizing text') progressCb(Math.round(m.progress * 100)); },
      });
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// Prepara la imagen: escala de grises, más contraste y tamaño cómodo para leer.
function prepare(img, target = 1800) {
  const s = Math.min(2.5, target / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height); const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    let g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    g = Math.max(0, Math.min(255, (g - 128) * 1.5 + 140)); // contraste, aclarando el papel térmico
    p[i] = p[i + 1] = p[i + 2] = g;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

/* ---------- Interpretación del texto ---------- */
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

// Comercios conocidos → nombre lindo + categoría sugerida.
const COMERCIOS = [
  [/carrefour/i, 'Carrefour', 'super'], [/\bc?coto\b/i, 'Coto', 'super'], [/\bd[i1]a\s?%|supermercados? d[i1]a/i, 'Día', 'super'],
  [/jumbo/i, 'Jumbo', 'super'], [/\bdisco\b/i, 'Disco', 'super'], [/\bvea\b/i, 'Vea', 'super'], [/chango\s*m[aá]s/i, 'Changomás', 'super'],
  [/la an[oó]nima/i, 'La Anónima', 'super'], [/walmart/i, 'Walmart', 'super'], [/makro/i, 'Makro', 'super'], [/vital\b/i, 'Vital', 'super'],
  [/\bypf\b/i, 'YPF', 'transporte'], [/\bshell\b/i, 'Shell', 'transporte'], [/axion/i, 'Axion', 'transporte'], [/puma energy/i, 'Puma', 'transporte'],
  [/farmacity/i, 'Farmacity', 'salud'], [/farmacia/i, 'Farmacia', 'salud'], [/simplicity/i, 'Simplicity', 'salud'],
  [/edelap/i, 'Edelap', 'servicios'], [/edenor/i, 'Edenor', 'servicios'], [/edesur/i, 'Edesur', 'servicios'], [/metrogas/i, 'Metrogas', 'servicios'],
  [/camuzzi/i, 'Camuzzi', 'servicios'], [/naturgy/i, 'Naturgy', 'servicios'], [/\babsa\b|aguas bonaerenses/i, 'ABSA', 'servicios'], [/aysa/i, 'AySA', 'servicios'],
  [/telecentro/i, 'Telecentro', 'servicios'], [/fibertel/i, 'Fibertel', 'servicios'], [/movistar/i, 'Movistar', 'servicios'], [/\bclaro\b/i, 'Claro', 'servicios'],
  [/personal\b/i, 'Personal', 'servicios'], [/directv/i, 'DirecTV', 'servicios'], [/flow\b/i, 'Flow', 'servicios'],
  [/mc ?donald|burger king|mostaza|starbucks|havanna|cafe martinez|caf[eé] mart[ií]nez/i, null, 'comida'],
  [/arba|afip|arca\b|municipalidad|rentas/i, null, 'impuestos'],
];
const PALABRAS_CATEGORIA = [
  [/farmacia|medicamento|laboratorio|cl[ií]nica|odontolog/i, 'salud'],
  [/nafta|combustible|gasoil|estacionamiento|peaje|sube\b/i, 'transporte'],
  [/supermercado|almac[eé]n|autoservicio|verduler[ií]a|carnicer[ií]a|panader[ií]a/i, 'super'],
  [/restaurant|resto\b|parrilla|pizzer[ií]a|cervecer[ií]a|bar\b|caf[eé]|delivery|pedidosya|rappi/i, 'comida'],
  [/ferreter[ií]a|pinturer[ií]a|corral[oó]n|bazar|easy\b|sodimac/i, 'hogar'],
  [/librer[ií]a|colegio|escuela|universidad|cuota escolar/i, 'educacion'],
  [/veterinaria|pet ?shop|alimento balanceado/i, 'mascotas'],
  [/indumentaria|zapater[ií]a|calzado|tienda de ropa/i, 'ropa'],
];

// Convierte "12.345,67" / "12345,67" / "12345.67" / "12 345,67" en número.
function toNumber(s) {
  s = s.replace(/[\s$]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}($|\.)/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
const NUM_RE = /\$?\s?\d{1,3}(?:[.\s]\d{3})*(?:[.,]\d{1,2})?|\$?\s?\d+(?:[.,]\d{1,2})?/g;
const numbersIn = line => (line.match(NUM_RE) || []).map(toNumber).filter(n => n > 0 && n < 1e9);

function findTotal(lines) {
  // 1) Líneas con TOTAL (no SUBTOTAL), "A PAGAR", "IMPORTE": el último número de la línea (o de la siguiente).
  const claves = [/total\s*a\s*pagar/i, /(?<!sub)\btotal\b/i, /\ba\s*pagar\b/i, /importe(\s*total)?/i, /monto/i];
  for (const re of claves) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!re.test(lines[i]) || /subtotal|sub total|total items|cant/i.test(lines[i])) continue;
      const nums = numbersIn(lines[i].replace(/.*?(total a pagar|total|a pagar|importe total|importe|monto)/i, ''));
      if (nums.length) return { value: nums[nums.length - 1], sure: true };
      const next = lines[i + 1] && numbersIn(lines[i + 1]);
      if (next && next.length) return { value: next[next.length - 1], sure: true };
    }
  }
  // 2) Montos escritos con signo $ (transferencias, Mercado Pago): el más grande.
  const withSign = lines.flatMap(l => [...l.matchAll(/(?:\$|ARS)\s?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/gi)].map(m => toNumber(m[1])))
    .filter(n => n > 0 && n < 1e9);
  if (withSign.length) return { value: Math.max(...withSign), sure: false };
  // 3) Si no, el monto con decimales más grande (dudoso).
  const withCents = lines.flatMap(l => (l.match(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}/g) || []).map(toNumber));
  if (withCents.length) return { value: Math.max(...withCents), sure: false };
  return { value: null, sure: false };
}

function findDate(text, hoy) {
  const year = Number(hoy.slice(0, 4));
  const ok = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= year + 1;
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  for (const mt of text.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g)) {
    let [d, m, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
    if (y < 100) y += 2000;
    if (ok(y, m, d)) return iso(y, m, d);
  }
  const mt = text.match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|sep?tiembre|octubre|noviembre|diciembre)(?:\s+de)?\s+(\d{4})/i);
  if (mt) { const [d, m, y] = [Number(mt[1]), MESES[mt[2].toLowerCase()], Number(mt[3])]; if (ok(y, m, d)) return iso(y, m, d); }
  return null;
}

function findMethod(text) {
  if (/mercado\s*pago/i.test(text)) return 'Mercado Pago';
  if (/transferencia|cbu|cvu|alias/i.test(text)) return 'Transferencia';
  if (/d[eé]bito|maestro|visa electron|debit/i.test(text)) return 'Débito';
  if (/cr[eé]dito|cuotas?\b|amex|american express|naranja|cabal|mastercard|visa\b/i.test(text)) return 'Crédito';
  if (/efectivo|contado/i.test(text)) return 'Efectivo';
  return null;
}

function findMerchant(lines) {
  const text = lines.join('\n');
  for (const [re, name, cat] of COMERCIOS) if (re.test(text)) return { name: name || (text.match(re)[0].replace(/\b\w/g, c => c.toUpperCase())), cat };
  // Primera línea "con letras" que no sea un dato fiscal.
  const line = lines.slice(0, 8).find(l => /[a-záéíóúñ]{3,}/i.test(l)
    && !/cuit|iva|ticket|tique|factura|fecha|hora|tel|direc|ingresos brutos|resp|inscripto|consumidor|p\.?v\.?|nro|n°/i.test(l)
    && !/^(inc\.?\s+)?s\.?\s?a\.?$|\bs\.?r\.?l\.?\b|^inc\b/i.test(l));
  if (!line) return { name: null, cat: null };
  const clean = line.replace(/[^a-záéíóúñ0-9 &.\-]/gi, ' ').replace(/\s+/g, ' ').trim();
  return { name: clean ? clean.slice(0, 40).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : null, cat: null };
}

export function parseTicketText(raw, hoy) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const text = lines.join('\n');
  const total = findTotal(lines);
  const merchant = findMerchant(lines);
  let categoria = merchant.cat;
  if (!categoria) for (const [re, c] of PALABRAS_CATEGORIA) if (re.test(text)) { categoria = c; break; }
  const cuotasM = text.match(/\b(\d{1,2})\s*cuotas?\b/i);
  const cuotas = cuotasM && Number(cuotasM[1]) > 1 ? Number(cuotasM[1]) : null;
  const looksLikeReceipt = total.value != null || /total|ticket|factura|comprobante|transferencia|importe/i.test(text);
  return {
    es_comprobante: looksLikeReceipt,
    monto_total: total.value,
    fecha: findDate(text, hoy),
    comercio: merchant.name,
    categoria_id: categoria,
    medio_pago: cuotas ? 'Crédito' : findMethod(text),
    cuotas,
    confianza: total.sure ? 'alta' : total.value ? 'baja' : 'baja',
    texto: raw,
  };
}

// Lee la imagen (HTMLImageElement) y devuelve los datos interpretados.
export async function readTicketOnDevice(img, { hoy, onProgress } = {}) {
  progressCb = onProgress || (() => {});
  const worker = await getWorker();
  const { data } = await worker.recognize(prepare(img));
  let result = parseTicketText(data.text || '', hoy);
  // Las letras muy grandes (el monto de una captura de transferencia) a veces no se leen agrandadas:
  // si no apareció el total, se prueba de nuevo con la imagen más chica y se suman los textos.
  if (result.monto_total == null) {
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '11' }); // modo "texto suelto"
      const { data: d2 } = await worker.recognize(prepare(img, 1000));
      const merged = parseTicketText(`${data.text || ''}\n${d2.text || ''}`, hoy);
      if (merged.monto_total != null) result = merged;
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: '3' });  // vuelve al modo normal
    }
  }
  return result;
}

// Precarga el lector en segundo plano (para que la primera foto sea más rápida).
export function warmUpReader() { getWorker().catch(() => {}); }
