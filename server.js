import express from "express";
import crypto from "crypto";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SECRET = process.env.WEBHOOK_SECRET || "";
const PORT   = process.env.PORT || 3000;

// Credenciales de tu cuenta en Chollometro (se guardan como variables en Render)
const CHOLLO_EMAIL    = process.env.CHOLLO_EMAIL || "";
const CHOLLO_PASSWORD = process.env.CHOLLO_PASSWORD || "";

/** Utilidad: compara con tiempo constante */
function safeEq(a, b) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

/** Verifica firma HMAC de la query (qs canónica sin `sig`) */
function verifySignature(url) {
  const u = new URL(url, "http://localhost");
  const sig = u.searchParams.get("sig") || "";
  const entries = [];
  for (const [k, v] of u.searchParams.entries()) if (k !== "sig") entries.push([k, v]);
  entries.sort((a,b) => a[0].localeCompare(b[0]));
  const qs = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const mac = crypto.createHmac("sha256", SECRET).update(qs).digest("base64url");
  return safeEq(mac, sig);
}

app.get("/", (_req, res) => res.type("text").send("OK - Auto Chollometro"));

/**
 * Endpoint llamado por el botón de Telegram (GET)
 * Espera: t (title), u (url), img (image), p (price), r (rrp), ts, sig
 */
app.get("/publish", async (req, res) => {
  try {
    if (!SECRET) return res.status(500).json({ ok: false, error: "SECRET_missing" });
    // Verifica firma
    if (!verifySignature(req.url)) return res.status(401).json({ ok: false, error: "bad_signature" });

    const title = req.query.t || "";
    const url   = req.query.u || "";
    const image = req.query.img || "";
    const price = req.query.p ? Number(req.query.p) : null;
    const rrp   = req.query.r ? Number(req.query.r) : null;

    if (!title || !url) return res.status(400).json({ ok: false, error: "missing_title_or_url" });
    if (!CHOLLO_EMAIL || !CHOLLO_PASSWORD) return res.status(500).json({ ok: false, error: "chollometro_creds_missing" });

    const result = await publishFlow({ title, url, image, price, rrp });
    res.json({ ok: true, result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/** Flujo Playwright */
async function publishFlow({ title, url, image, price, rrp }) {
  // NOTA: headless:true en Render. Para debug puedes poner false localmente.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  // 1) Ir a submit; si redirige a login, iniciar sesión y volver
  await page.goto("https://www.chollometro.com/submit", { waitUntil: "domcontentloaded" });
  if (page.url().includes("/login")) {
    await loginChollometro(page);
    await page.goto("https://www.chollometro.com/submit", { waitUntil: "domcontentloaded" });
  }

  // 2) Paso enlace
  await fillByLabelOrPlaceholder(page, /enlace|link|url/i, url);

  // Botón continuar/siguiente
  await clickNext(page);

  // 3) Paso precios (si los tenemos; si no, saltamos y tendrás que completar manualmente)
  if (price != null) {
    await fillByLabelOrPlaceholder(page, /precio.*oferta|precio/i, String(price).replace('.', ','));
  }
  if (rrp != null) {
    await fillByLabelOrPlaceholder(page, /precio.*normal|pvp|precio.*antes/i, String(rrp).replace('.', ','));
  }
  await softClickNext(page); // si no hay precios obligatorios, quizá ya cambió de paso

  // 4) Paso título
  await fillByLabelOrPlaceholder(page, /t[ií]tulo/i, title);
  await clickNext(page);

  // 5) Paso descripción
  const desc = [
    title,
    '',
    `Enlace: ${url}`,
    image ? `Imagen: ${image}` : '',
    price != null ? `Precio: ${price}€` : '',
    rrp != null ? `PVP: ${rrp}€` : '',
    'Tienda: MediaMarkt'
  ].filter(Boolean).join('\n');
  await typeInTextbox(page, desc);
  await clickNext(page);

  // 6) Paso imágenes (si es requerido, aquí habría que subir archivo; muchos flujos lo dejan opcional).
  await softClickNext(page);

  // 7) Publicar
  // Ajusta el texto exacto si es diferente
  const publishBtn = page.getByRole('button', { name: /publicar|publish/i }).first();
  if (await publishBtn.count()) {
    await publishBtn.click({ timeout: 15000 });
  }

  // Esperar a que aparezca confirmación/URL de la publicación
  await page.waitForTimeout(3000);
  const finalUrl = page.url();

  await browser.close();
  return { finalUrl };
}

async function loginChollometro(page) {
  // Campos comunes
  const emailField = page.getByLabel(/email|correo/i).or(page.getByPlaceholder(/email|correo/i));
  const passField  = page.getByLabel(/contraseña|password/i).or(page.getByPlaceholder(/contraseña|password/i));
  await emailField.waitFor({ timeout: 20000 });
  await emailField.fill(CHOLLO_EMAIL);
  await passField.fill(CHOLLO_PASSWORD);

  const loginBtn = page.getByRole('button', { name: /iniciar sesi[oó]n|entrar|acceder|login/i }).first();
  if (await loginBtn.count()) {
    await loginBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  // Da tiempo a redirección
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
}

async function fillByLabelOrPlaceholder(page, re, value) {
  const input = page.getByLabel(re).or(page.getByPlaceholder(re)).first();
  await input.waitFor({ timeout: 20000 });
  await input.fill(''); await input.type(value);
}

async function typeInTextbox(page, value) {
  const box = page.getByRole('textbox').first();
  if (await box.count()) {
    await box.click();
    await page.keyboard.type(value, { delay: 1 });
  }
}

async function clickNext(page) {
  const btn = page.getByRole('button', { name: /siguiente|continuar|next|continuar/i }).first();
  await btn.waitFor({ timeout: 15000 });
  await btn.click();
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
}
async function softClickNext(page) {
  try { await clickNext(page); } catch (_) {}
}

app.listen(PORT, () => console.log("Servidor en puerto", PORT));
