/**
 * Servidor de Dynamic ($DINO) para cobrar con NOWPayments.
 *
 * Por qué existe este servidor:
 * La API key de NOWPayments es SECRETA. Si la pones directo en el HTML de tu web,
 * cualquiera que abra "ver código fuente" puede copiarla y generar facturas o
 * gastar tu cuota en tu nombre. Por eso la API key vive aquí (variable de entorno),
 * nunca en el navegador del comprador.
 *
 * Qué hace:
 *  - POST /api/create-invoice   -> crea una factura en NOWPayments y devuelve su URL
 *  - POST /api/ipn              -> NOWPayments te avisa aquí cuando un pago se confirma
 *  - GET  /api/raised           -> total recaudado (para la barra de progreso)
 *  - GET  /api/balance          -> $DINO reservados por una wallet
 *  - GET  /healthz              -> para que el hosting sepa que el servidor está vivo
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
  PUBLIC_URL,            // ej: https://dynamic-dyno.onrender.com  (URL pública de ESTE servidor)
  FRONTEND_URL,          // ej: https://tu-dominio.com              (URL pública de tu página)
  ALLOWED_ORIGIN,        // opcional: si es distinto de FRONTEND_URL
  DYNO_PRICE = '0.02',   // debe coincidir con CONFIG.price del HTML
  MIN_USD = '10',
  MAX_USD = '5000',
  PORT = 3000,
} = process.env;

if (!NOWPAYMENTS_API_KEY) console.warn('⚠️  Falta NOWPAYMENTS_API_KEY en las variables de entorno.');
if (!NOWPAYMENTS_IPN_SECRET) console.warn('⚠️  Falta NOWPAYMENTS_IPN_SECRET: no se podrán verificar los avisos de pago.');

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN || FRONTEND_URL || '*' }));
app.use('/api/ipn', express.raw({ type: '*/*' })); // el IPN necesita el cuerpo crudo para verificar la firma
app.use(express.json());

/* ---------- almacenamiento simple en un archivo JSON ----------
   Suficiente para arrancar. Si tu hosting reinicia el disco (por ejemplo, el plan
   gratis de Render), esto se puede perder. Para producción real, cambia esto por
   una base de datos (Postgres, SQLite en un disco persistente, etc.). */
const DB_PATH = path.join(__dirname, 'data.json');
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (e) { return { raisedUsd: 0, orders: {}, balances: {} }; }
}
function writeDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

/* ---------- crear factura ---------- */
app.post('/api/create-invoice', async (req, res) => {
  try {
    const { wallet, usdAmount } = req.body || {};
    const amount = Number(usdAmount);
    if (!wallet || typeof wallet !== 'string' || wallet.length < 32) return res.status(400).json({ error: 'Wallet inválida.' });
    if (!Number.isFinite(amount) || amount < Number(MIN_USD) || amount > Number(MAX_USD)) return res.status(400).json({ error: 'Monto fuera de rango.' });

    const orderId = `dyno_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const r = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: 'usd',
        // pay_currency: si lo omites, el comprador elige la moneda (BTC, USDT, SOL, etc.)
        // en la propia página de NOWPayments, siempre que la tengas activada en tu cuenta.
        order_id: orderId,
        order_description: `Dynamic $DINO — reserva para wallet ${wallet}`,
        ipn_callback_url: PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, '')}/api/ipn` : undefined,
        success_url: FRONTEND_URL || undefined,
        cancel_url: FRONTEND_URL || undefined,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.message || 'NOWPayments rechazó la solicitud.' });

    const db = readDB();
    db.orders[orderId] = { wallet, usdAmount: amount, status: 'waiting', invoiceId: data.id, createdAt: Date.now() };
    writeDB(db);

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
    const raw = req.body; // Buffer, gracias a express.raw arriba
    const sig = req.header('x-nowpayments-sig');
    if (!NOWPAYMENTS_IPN_SECRET || !sig) return res.status(400).send('Falta firma o secreto IPN.');

    const payload = JSON.parse(raw.toString('utf8'));
    const sorted = JSON.stringify(sortKeys(payload));
    const expected = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET).update(sorted).digest('hex');
    if (expected !== sig) return res.status(401).send('Firma inválida.');

    const db = readDB();
    const orderId = payload.order_id;
    const order = db.orders[orderId];
    const status = payload.payment_status; // waiting, confirming, confirmed, sending, finished, failed, expired, refunded

    if (order && ['finished', 'confirmed'].includes(status) && order.status !== 'finished') {
      order.status = 'finished';
      db.raisedUsd = (db.raisedUsd || 0) + order.usdAmount;
      const dynoTokens = order.usdAmount / Number(DYNO_PRICE);
      db.balances[order.wallet] = (db.balances[order.wallet] || 0) + dynoTokens;
      writeDB(db);
    } else if (order) {
      order.status = status;
      writeDB(db);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error procesando el IPN.');
  }
});

/* ---------- lecturas para la web ---------- */
app.get('/api/raised', (req, res) => { const db = readDB(); res.json({ raisedUsd: db.raisedUsd || 0 }); });
app.get('/api/balance', (req, res) => { const db = readDB(); res.json({ dynoTokens: db.balances[req.query.wallet] || 0 }); });
app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`Servidor de Dynamic $DINO escuchando en el puerto ${PORT}`));
