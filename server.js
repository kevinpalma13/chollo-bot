// server.js
import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

/* ======================
   RUTA DE PRUEBA
   ====================== */
app.get("/", (req, res) => {
  res.send("OK - Scraper Miravia activo");
});

/* ======================
   SCRAPER DE MIRAVIA
   ====================== */
app.get("/miravia/flashsale.json", async (req, res) => {
  const MAX_ITEMS = Number(req.query.max || 10); // por defecto 10
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    // 1) Ir a la lista de flash sale
    await page.goto("https://www.miravia.es/flashsale/home", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Si el sitio nos manda a captcha/antibot
    if (/punish|captcha/i.test(page.url())) {
      await browser.close();
      return res
        .status(503)
        .json({ ok: false, error: "captcha_or_antibot", items: [] });
    }

    // 2) Esperar a que aparezcan productos
    await page.waitForSelector('a[data-spm="dproduct"]', { timeout: 20000 });

    // 3) Extraer tarjetas
    const cards = await page.$$eval('a[data-spm="dproduct"]', (nodes) => {
      const out = [];
      for (const a of nodes) {
        const href = a.getAttribute("href") || "";
        const titleEl = a.querySelector(".lte_product_card_title");
        const title = titleEl
          ? titleEl.textContent.trim().replace(/\s+/g, " ")
          : "";

        // Precio actual
        const pi = a.querySelector(
          ".lte_product_card_price_main_integer"
        );
        const pd = a.querySelector(
          ".lte_product_card_price_main_decimal"
        );
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

    // 4) Limitar número de productos
    const slice = cards.slice(0, MAX_ITEMS);

    // 5) Abrir detalle de cada producto
    const results = [];
    for (const it of slice) {
      try {
        const p2 = await context.newPage();
        await p2.goto(it.url, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });

        if (/punish|captcha/i.test(p2.url())) {
          await p2.close();
          continue;
        }

        // Descripción
        let desc = "";
        try {
          await p2.waitForSelector("#module_product-details", {
            timeout: 12000,
          });
          desc = await p2.$eval("#module_product-details", (n) =>
            n.innerText.replace(/\s+/g, " ").trim()
          );
        } catch (_) {}

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
        } catch (_) {}

        results.push({
          ...it,
          summary: summarize150(desc),
          image,
        });

        await p2.close();
      } catch (e) {
        console.error("Error en detalle:", e);
      }
    }

    await browser.close();
    return res.json({ ok: true, items: results });
  } catch (e) {
    if (browser) await browser.close();
    console.error("Error general:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ======================
   Helper para resumen
   ====================== */
function summarize150(text) {
  if (!text) return "";
  const words = text.trim().split(/\s+/);
  if (words.length <= 150) return words.join(" ");
  return words.slice(0, 150).join(" ") + "…";
}

/* ======================
   Arrancar servidor
   ====================== */
app.listen(PORT, () => {
  console.log("Servidor Miravia activo en puerto", PORT);
});
