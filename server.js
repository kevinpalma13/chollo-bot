// server.js
import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

// Modo debug opcional: añade en Render la env DEBUG=1 para ver más logs
const DEBUG = process.env.DEBUG === "1";

app.get("/", (_req, res) => {
  res.type("text").send("OK - Scraper Miravia activo");
});

app.get("/miravia/flashsale.json", async (req, res) => {
  const MAX_ITEMS = Number(req.query.max || 10);
  let browser;
  try {
    if (DEBUG) console.log("[MIRAVIA] Iniciando navegador…");

    browser = await chromium.launch({
      headless: true,
      // En algunos hosts conviene desactivar sandbox
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      geolocation: { latitude: 40.4168, longitude: -3.7038 }, // Madrid (no siempre necesario)
      permissions: ["geolocation"],
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(45000);

    // Algunas webs son sensibles a cabeceras
    await page.setExtraHTTPHeaders({
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      DNT: "1",
    });

    if (DEBUG) console.log("[MIRAVIA] Abriendo lista…");
    await page.goto("https://www.miravia.es/flashsale/home", {
      waitUntil: "domcontentloaded",
    });

    const current = page.url();
    if (DEBUG) console.log("[MIRAVIA] URL actual:", current);

    // Si el sitio devuelve paso anti-bot
    if (/punish|captcha/i.test(current)) {
      if (DEBUG) console.log("[MIRAVIA] Captcha/antibot detectado en lista");
      await browser.close();
      return res
        .status(503)
        .json({ ok: false, error: "captcha_or_antibot", items: [] });
    }

    // Espera a que aparezcan productos
    if (DEBUG) console.log("[MIRAVIA] Esperando selectores de producto…");
    await page.waitForSelector('a[data-spm="dproduct"]', { timeout: 20000 });

    // Extraer tarjetas en el cliente
    const cards = await page.$$eval('a[data-spm="dproduct"]', (nodes) => {
      const out = [];
      for (const a of nodes) {
        const href = a.getAttribute("href") || "";
        const titleEl = a.querySelector(".lte_product_card_title");
        const title = titleEl
          ? titleEl.textContent.trim().replace(/\s+/g, " ")
          : "";

        // Precio actual integer+decimal
        const pi = a.querySelector(".lte_product_card_price_main_integer");
        const pd = a.querySelector(".lte_product_card_price_main_decimal");
        let priceNow = null;
        if (pi) {
          const i = (pi.textContent || "").replace(/\D+/g, "");
          let d = "00";
          if (pd) {
            d = (pd.textContent || "").replace(/[^\d]/g, "");
            if (d.length === 1) d += "0";
            if (d.length > 2) d = d.slice(0, 2);
          }
          const num = Number(i + "." + d);
          priceNow = isNaN(num) ? null : num;
        }

        // Precio tachado
        const pwEl = a.querySelector(".lte_product_card_price_cross_out");
        let priceWas = null;
        if (pwEl) {
          const m = (pwEl.textContent || "")
            .replace(/\s+/g, " ")
            .match(/(\d{1,4})(?:[.,](\d{1,2}))?/);
          if (m) {
            const i = m[1];
            const d = m[2] || "00";
            const num = Number(i + "." + (d.length === 1 ? d + "0" : d));
            priceWas = isNaN(num) ? null : num;
          }
        }

        if (href && title) {
          const abs = new URL(href, "https://www.miravia.es").toString();
          out.push({ url: abs, title, priceNow, priceWas });
        }
      }
      return out;
    });

    if (DEBUG) console.log("[MIRAVIA] Tarjetas encontradas:", cards.length);

    const slice = cards.slice(0, MAX_ITEMS);

    const results = [];
    for (const it of slice) {
      try {
        if (DEBUG) console.log("[MIRAVIA] Detalle →", it.url);
        const p2 = await context.newPage();
        p2.setDefaultTimeout(40000);
        p2.setDefaultNavigationTimeout(40000);
        await p2.goto(it.url, { waitUntil: "domcontentloaded" });

        const u2 = p2.url();
        if (/punish|captcha/i.test(u2)) {
          if (DEBUG) console.log("[MIRAVIA] Captcha/antibot en detalle, salto:", u2);
          await p2.close();
          continue;
        }

        // Descripción
        let desc = "";
        try {
          await p2.waitForSelector("#module_product-details", { timeout: 15000 });
          desc = await p2.$eval("#module_product-details", (n) =>
            n.innerText.replace(/\s+/g, " ").trim()
          );
        } catch (e) {
          if (DEBUG) console.log("[MIRAVIA] Sin módulo de detalles:", e.message);
        }

        // Imagen
        let image = "";
        try {
          const imgEl = await p2.$("img.main-photo");
          if (imgEl) {
            image =
              (await imgEl.getAttribute("src")) ||
              (await imgEl.getAttribute("data-src")) ||
              "";
          }
        } catch (e) {
          if (DEBUG) console.log("[MIRAVIA] Sin imagen principal:", e.message);
        }

        results.push({
          ...it,
          summary: summarize150(desc),
          image,
        });

        await p2.close();
      } catch (e) {
        console.error("[MIRAVIA] Error en detalle:", e.message);
      }
    }

    await browser.close();
    if (DEBUG) console.log("[MIRAVIA] Done. Items:", results.length);

    return res.json({ ok: true, items: results });
  } catch (e) {
    if (browser) await browser.close();
    console.error("[MIRAVIA] ERROR GENERAL:", e.stack || e.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Helper resumen ~150 palabras
function summarize150(text) {
  if (!text) return "";
  const words = text.trim().split(/\s+/);
  if (words.length <= 150) return words.join(" ");
  return words.slice(0, 150).join(" ") + "…";
}

app.listen(PORT, () => {
  console.log("Servidor Miravia activo en puerto", PORT);
});
