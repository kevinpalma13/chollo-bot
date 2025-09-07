// server.js
import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === "1";

// Cache en memoria 10 min para no golpear tanto
let cache = { at: 0, data: null };

app.get("/", (_req, res) => res.send("OK - PcComponentes scraper"));

app.get("/pccom/ofertas.json", async (req, res) => {
  const MAX = Number(req.query.max || 12);
  const now = Date.now();
  if (cache.data && now - cache.at < 10 * 60 * 1000) {
    return res.json(cache.data);
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(45000);

    await page.setExtraHTTPHeaders({
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      DNT: "1",
    });

    if (DEBUG) console.log("[PCC] Abriendo lista…");
    await page.goto(
      "https://www.pccomponentes.com/ofertas-especiales?sort=activation_date",
      { waitUntil: "domcontentloaded" }
    );

    // Si hay cookie wall o antibot, intenta esperar un poco
    try {
      await page.waitForSelector("div.product-card", { timeout: 25000 });
    } catch (e) {
      if (DEBUG)
        console.log("[PCC] No aparecieron product-card a tiempo:", e.message);
      await browser.close();
      return res
        .status(503)
        .json({ ok: false, error: "captcha_or_antibot", items: [] });
    }

    const cards = await page.$$eval("div.product-card", (nodes) => {
      const out = [];
      for (const n of nodes) {
        // enlace: el <a> contenedor cercano o dentro
        let a = n.closest("a");
        if (!a) a = n.querySelector("a");
        const href = a ? a.href : "";

        const titleEl = n.querySelector("h3.product-card__title");
        const title = titleEl
          ? titleEl.textContent.trim().replace(/\s+/g, " ")
          : "";

        // imagen
        let image = "";
        const imgBox = n.querySelector(".product-card__img-container");
        if (imgBox) {
          const img = imgBox.querySelector("img");
          if (img) {
            image =
              img.getAttribute("src") ||
              img.getAttribute("data-src") ||
              (() => {
                const ss = img.getAttribute("srcset") || "";
                if (!ss) return "";
                const parts = ss
                  .split(",")
                  .map((s) => s.trim().split(" ")[0])
                  .filter(Boolean);
                return parts[parts.length - 1] || "";
              })();
          }
        }

        // precios
        const priceBox = n.querySelector(".product-card__price-container");
        let priceNow = null,
          priceWas = null;
        if (priceBox) {
          const spans = Array.from(priceBox.querySelectorAll("span")).map((s) =>
            (s.textContent || "").trim().replace(/\s+/g, " ")
          );
          const parse = (t) => {
            const m = t.match(/(\d{1,5})(?:[.,](\d{1,2}))?/);
            if (!m) return null;
            const i = m[1];
            const d = m[2] || "00";
            return Number(i + "." + (d.length === 1 ? d + "0" : d));
          };
          if (spans[0]) priceNow = parse(spans[0]);
          if (spans[1]) priceWas = parse(spans[1]);
        }

        if (href && title)
          out.push({ url: href, title, image, priceNow, priceWas });
      }
      return out;
    });

    const slice = cards.slice(0, MAX);

    // Detalle: #smart-product-wrapper → resumen
    const results = [];
    for (const it of slice) {
      try {
        const p2 = await context.newPage();
        await p2.goto(it.url, { waitUntil: "domcontentloaded" });
        let desc = "";
        try {
          await p2.waitForSelector("#smart-product-wrapper", { timeout: 15000 });
          desc = await p2.$eval("#smart-product-wrapper", (n) =>
            n.innerText.replace(/\s+/g, " ").trim()
          );
        } catch {}
        await p2.close();

        results.push({ ...it, summary: summarize150(desc) });
      } catch (e) {
        if (DEBUG) console.log("[PCC] Detalle KO", it.url, e.message);
      }
    }

    await browser.close();
    const payload = { ok: true, items: results };
    cache = { at: Date.now(), data: payload };
    res.json(payload);
  } catch (e) {
    if (browser) await browser.close();
    console.error("[PCC] ERROR:", e.stack || e.message || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

function summarize150(text) {
  if (!text) return "";
  const w = text.trim().split(/\s+/);
  return w.length <= 150 ? w.join(" ") : w.slice(0, 150).join(" ") + "…";
}

app.listen(PORT, () => console.log("Servidor PcComponentes en puerto", PORT));
