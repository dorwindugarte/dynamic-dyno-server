/**
 * Servidor de Dynamic Rex ($DYREX) para cobrar con NOWPayments.
 *
 * Por qué existe este servidor:
 * La API key de NOWPayments es SECRETA. Vive aquí (variable de entorno),
 * nunca en el navegador del comprador.
 *
 * Endpoints:
 *  - POST /api/create-invoice   -> crea una factura en NOWPayments y devuelve su URL
 *  - POST /api/ipn              -> NOWPayments avisa aquí cuando un pago se confirma
 *  - GET  /api/raised           -> total recaudado (barra de progreso)
 *  - GET  /api/balance          -> $DYREX reservados por una wallet
 *  - GET  /api/admin/summary    -> resumen (solo con ADMIN_KEY)
 *  - GET  /api/admin/export     -> CSV wallet,tokens para la distribución (solo con ADMIN_KEY)
 *  - GET  /healthz              -> el hosting comprueba que el servidor está vivo
 *
 * Variables de entorno (Render -> Environment):
 *  NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET   (secretas)
 *  PUBLIC_URL      URL pública de ESTE servidor, sin "/" al final
 *  FRONTEND_URL    https://dynamicdyrex.netlify.app   (sin "/" al final)
 *  DYNO_PRICE      precio por token en USD, igual que CONFIG.price de la página (0.02)
 *  DATA_DIR        carpeta del disco persistente, por ejemplo /var/data
 *  ADMIN_KEY       (opcional) clave larga y aleatoria para las rutas /api/admin/*
 *  ALLOWED_ORIGIN  (opcional) varias páginas permitidas separadas por coma
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const {
  NOWPAYMENTS_API_KEY,
  NOWPAYMENTS_IPN_SECRET,
  PUBLIC_URL,
  FRONTEND_URL,
  ALLOWED_ORIGIN,
  DYNO_PRICE = '0.02',
  MIN_USD = '10',
  MAX_USD = '5000',
  DATA_DIR,
  ADMIN_KEY,
  PORT = 3000,
} = process.env;

const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
const SELF = clean(PUBLIC_URL);
const FRONT = clean(FRONTEND_URL);
const ORIGINS = String(ALLOWED_ORIGIN || FRONT).split(',').map(clean).filter(Boolean);
const PRICE = Number(DYNO_PRICE);

if (!NOWPAYMENTS_API_KEY) console.warn('⚠️  Falta NOWPAYMENTS_API_KEY.');
if (!NOWPAYMENTS_IPN_SECRET) console.warn('⚠️  Falta NOWPAYMENTS_IPN_SECRET: no se pueden verificar los avisos de pago.');
if (!SELF) console.warn('⚠️  Falta PUBLIC_URL: sin él NOWPayments no puede avisar los pagos, y no se crearán facturas.');
if (!ORIGINS.length) console.warn('⚠️  Falta FRONTEND_URL: se aceptan peticiones de cualquier página.');
if (!DATA_DIR) console.warn('⚠️  Falta DATA_DIR: los datos se guardan junto al código y se PIERDEN en cada reinicio o despliegue en Render. Conecta un disco persistente.');
if (!(PRICE > 0)) console.warn('⚠️  DYNO_PRICE no es un número válido.');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: ORIGINS.length ? ORIGINS : '*' }));
app.use('/api/ipn', express.raw({ type: '*/*' })); // el IPN necesita el cuerpo crudo para verificar la firma
app.use(express.json());

/* ---------- almacenamiento en archivos (necesita disco persistente) ---------- */
const DIR = DATA_DIR ? path.resolve(DATA_DIR) : __dirname;
try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { console.error('No se pudo crear DATA_DIR:', e.message); }
const DB_PATH = path.join(DIR, 'data.json');
const LEDGER_PATH = path.join(DIR, 'ledger.jsonl'); // registro permanente, solo se añade, nunca se reescribe

function readDB() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    d.orders = d.orders || {}; d.balances = d.balances || {}; d.raisedUsd = d.raisedUsd || 0;
    return d;
  } catch (e) {
    if (e.code === 'ENOENT') return { raisedUsd: 0, orders: {}, balances: {} };
    throw e; // archivo dañado: mejor fallar que borrar los saldos reescribiendo en vacío
  }
}
function writeDB(db) { // escritura atómica: nunca queda un archivo a medias
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}
function ledger(entry) {
  try { fs.appendFileSync(LEDGER_PATH, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n'); }
  catch (e) { console.error('No se pudo escribir el ledger:', e.message); }
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const SOL_WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // dirección de Solana (base58)
const r4 = (n) => Math.round(n * 1e4) / 1e4;

/* ---------- límite simple de intentos por IP ---------- */
const hits = new Map();
function limited(ip, max, ms) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < ms);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 600000)) hits.delete(k); }, 600000).unref();

/* ---------- crear factura ---------- */
app.post('/api/create-invoice', async (req, res) => {
  try {
    if (!NOWPAYMENTS_API_KEY || !SELF || !(PRICE > 0)) return res.status(500).json({ error: 'Servidor mal configurado.' });
    if (limited(req.ip, 15, 10 * 60 * 1000)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });

    const { wallet, usdAmount } = req.body || {};
    const amount = Number(usdAmount);
    if (typeof wallet !== 'string' || !SOL_WALLET.test(wallet)) return res.status(400).json({ error: 'Wallet inválida.' });
    if (!Number.isFinite(amount) || amount < Number(MIN_USD) || amount > Number(MAX_USD)) return res.status(400).json({ error: 'Monto fuera de rango.' });

    const orderId = `dyrex_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const r = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: 'usd',
        order_id: orderId,
        order_description: `Dynamic Rex $DYREX - reserva para wallet ${wallet}`,
        ipn_callback_url: `${SELF}/api/ipn`,
        success_url: FRONT ? `${FRONT}/?pago=ok#mis-tokens` : undefined,
        cancel_url: FRONT ? `${FRONT}/#presale` : undefined,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.message || 'NOWPayments rechazó la solicitud.' });

    const db = readDB();
    db.orders[orderId] = { wallet, usdAmount: amount, status: 'waiting', invoiceId: data.id, createdAt: Date.now() };
    writeDB(db);
    ledger({ event: 'invoice_created', orderId, wallet, usdAmount: amount });

    res.json({ invoice_url: data.invoice_url, order_id: orderId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno al crear la factura.' });
  }
});

/* ---------- aviso de pago (IPN) de NOWPayments ---------- */
function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortKeys(obj[k]); return acc; }, {});
  }
  return obj;
}
app.post('/api/ipn', (req, res) => {
  try {
    const raw = req.body;
    const sig = req.header('x-nowpayments-sig');
    if (!NOWPAYMENTS_IPN_SECRET) return res.status(500).send('Falta el secreto IPN.');
    if (!Buffer.isBuffer(raw) || !sig) return res.status(400).send('Falta cuerpo o firma.');

    const payload = JSON.parse(raw.toString('utf8'));
    const expected = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET).update(JSON.stringify(sortKeys(payload))).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(String(sig));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send('Firma inválida.');

    const db = readDB();
    const orderId = String(payload.order_id || '');
    const status = String(payload.payment_status || '');
    const order = has(db.orders, orderId) ? db.orders[orderId] : null;

    if (!order) { ledger({ event: 'ipn_unknown_order', orderId, status }); return res.sendStatus(200); }

    if (order.status === 'finished') { // ya acreditado: nunca se acredita dos veces
      if (status === 'refunded' || status === 'failed') {
        order.flag = status; writeDB(db);
        ledger({ event: 'credited_order_flagged', orderId, status, note: 'REVISAR A MANO' });
      }
      return res.sendStatus(200);
    }

    if (['finished', 'confirmed'].includes(status)) {
      const priceOk = payload.price_amount == null || Math.abs(Number(payload.price_amount) - order.usdAmount) <= 0.01;
      if (!priceOk) {
        order.status = 'review'; writeDB(db);
        ledger({ event: 'amount_mismatch', orderId, expected: order.usdAmount, got: payload.price_amount, note: 'REVISAR A MANO' });
        return res.sendStatus(200);
      }
      const tokens = r4(order.usdAmount / PRICE);
      order.status = 'finished'; order.tokens = tokens; order.paidAt = Date.now();
      db.raisedUsd = r4((db.raisedUsd || 0) + order.usdAmount);
      db.balances[order.wallet] = r4((has(db.balances, order.wallet) ? db.balances[order.wallet] : 0) + tokens);
      writeDB(db);
      ledger({ event: 'credited', orderId, wallet: order.wallet, usdAmount: order.usdAmount, tokens, paymentId: payload.payment_id });
    } else {
      order.status = status;
      writeDB(db);
      if (status === 'partially_paid') {
        ledger({ event: 'partially_paid', orderId, wallet: order.wallet, expected: order.usdAmount, actually_paid: payload.actually_paid, pay_currency: payload.pay_currency, note: 'REVISAR A MANO' });
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error procesando el IPN.'); // NOWPayments reintentará
  }
});

/* ---------- lecturas para la web ---------- */
app.get('/api/raised', (req, res) => {
  try { const db = readDB(); res.set('Cache-Control', 'no-store'); res.json({ raisedUsd: db.raisedUsd || 0 }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Error leyendo datos.' }); }
});
app.get('/api/balance', (req, res) => {
  try {
    const w = String(req.query.wallet || '');
    if (!SOL_WALLET.test(w)) return res.status(400).json({ error: 'Wallet inválida.' });
    const db = readDB(); res.set('Cache-Control', 'no-store');
    res.json({ dynoTokens: has(db.balances, w) ? db.balances[w] : 0 });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error leyendo datos.' }); }
});

/* ---------- administración (para ti, protegida con ADMIN_KEY) ---------- */
function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const k = String(req.header('x-admin-key') || req.query.key || '');
  const a = Buffer.from(k), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.get('/api/admin/summary', (req, res) => {
  if (!isAdmin(req)) return res.sendStatus(404);
  const db = readDB();
  const byStatus = {}; Object.values(db.orders).forEach((o) => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
  res.json({ raisedUsd: db.raisedUsd, wallets: Object.keys(db.balances).length, totalTokens: r4(Object.values(db.balances).reduce((s, n) => s + n, 0)), ordersByStatus: byStatus });
});
app.get('/api/admin/export', (req, res) => {
  if (!isAdmin(req)) return res.sendStatus(404);
  const db = readDB();
  const csv = 'wallet,tokens\n' + Object.entries(db.balances).map(([w, t]) => `${w},${t}`).join('\n') + '\n';
  res.set('Content-Type', 'text/csv'); res.set('Content-Disposition', 'attachment; filename="dyrex-balances.csv"'); res.send(csv);
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`Servidor de Dynamic Rex $DYREX escuchando en el puerto ${PORT}`));
