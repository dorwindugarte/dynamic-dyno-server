# Servidor de Dynamic ($DYNO) — NOWPayments

Este servidor es la pieza que faltaba: crea las facturas de NOWPayments y guarda tu API key
de forma segura. Tu página web (el HTML) nunca ve esa clave, solo habla con este servidor.

## 1. Consigue tus claves en NOWPayments

1. Entra a tu cuenta en https://account.nowpayments.io
2. Ve a **Settings → API Keys** y genera una API Key. Cópiala, es secreta.
3. Ve a **Settings → IPN callback** (o "Instant Payment Notifications") y copia el **IPN Secret Key**.
   Esto sirve para que el servidor pueda verificar que un aviso de pago viene realmente de NOWPayments.
4. En **Settings → Store settings** (o "Payout settings"), define a qué dirección quieres que
   NOWPayments te liquide cada moneda (puede ser tu wallet propia o tu dirección de Binance).
5. En la sección de monedas / "Available currencies", activa las que quieras aceptar
   (BTC, USDT, USDC, SOL, etc.).

**Nunca me envíes estas claves por chat ni las pegues en el HTML.** Van solo en el paso 3 de abajo.

## 2. Sube este código a GitHub (o despliega directo la carpeta)

Crea un repositorio nuevo y sube el contenido de esta carpeta (`server.js`, `package.json`, este README).
No subas ningún archivo `.env` con tus claves reales.

## 3. Despliega en un hosting gratuito (ejemplo: Render)

1. Entra a https://render.com y crea una cuenta.
2. **New → Web Service**, conecta tu repositorio.
3. Configuración:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. En **Environment → Environment Variables**, agrega:
   - `NOWPAYMENTS_API_KEY` → tu API key (paso 1.2)
   - `NOWPAYMENTS_IPN_SECRET` → tu IPN secret (paso 1.3)
   - `DYNO_PRICE` → el mismo precio que pusiste en `CONFIG.price` del HTML (ej. `0.02`)
   - `FRONTEND_URL` → la URL pública de tu página ya publicada
   - `PUBLIC_URL` → se completa después del primer despliegue (ver paso 5)
5. Despliega. Render te dará una URL como `https://dynamic-dyno.onrender.com`.
6. Vuelve a Environment Variables y pon esa misma URL en `PUBLIC_URL`. Guarda, se reiniciará.

(Railway y Fly.io funcionan de forma similar si prefieres otro hosting.)

## 4. Conecta tu página web con el servidor

En el HTML de tu página, dentro de `CONFIG`, pon:

```js
apiBaseUrl: 'https://dynamic-dyno.onrender.com',  // la URL de Render del paso 3.5
```

Publica de nuevo tu página con ese cambio.

## 5. Configura el IPN en NOWPayments

En **Settings → IPN callback**, pega la URL:

```
https://dynamic-dyno.onrender.com/api/ipn
```

Así, cada vez que un pago se confirme, NOWPayments avisa a tu servidor y este suma el monto
al total recaudado y a la wallet correspondiente.

## 6. Prueba con un monto pequeño

Antes de anunciar la preventa, haz tú mismo una compra de 10 USD de principio a fin:
conecta una wallet, paga con NOWPayments, y confirma que:
- la factura se genera y te lleva a la página de pago,
- después de pagar, `/api/raised` sube,
- `/api/balance?wallet=TU_WALLET` muestra los $DYNO reservados.

## Sobre el almacenamiento

Este servidor guarda los datos en un archivo `data.json` simple, para que puedas arrancar
sin montar una base de datos. **Si tu hosting reinicia el disco (por ejemplo, el plan gratuito
de Render duerme e "olvida" el disco en algunos casos), esos datos se pueden perder.**
Antes de manejar dinero real a mayor escala, cambia esto por una base de datos de verdad
(Postgres, por ejemplo — Render y Railway ofrecen planes gratuitos). Puedo ayudarte con eso
cuando lo necesites.
