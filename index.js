const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

async function getEbayToken() {
  const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });
  const d = await r.json();
  return d.access_token;
}

app.post('/ebay', async (req, res) => {
  try {
    const { keywords } = req.body;

    // Add brand prefix if not already present
    const BRAND_PATTERNS = [
      { p: /^(Denons+)?RC-?d{4}/i, b: 'Denon' },
      { p: /^(Samsungs+)?(AA59|BN59)[-s]?d+/i, b: 'Samsung' },
      { p: /^(Sonys+)?(RMT|RM-)/i, b: 'Sony' },
      { p: /^(LGs+)?(AKB|AGF|MKJ)d+/i, b: 'LG' },
      { p: /^(Yamahas+)?(FSR|RAV)d+/i, b: 'Yamaha' },
      { p: /^(Panasonics+)?(EUR)d+/i, b: 'Panasonic' },
      { p: /^(Vizios+)?XRTd+/i, b: 'Vizio' },
    ];
    let searchKeywords = keywords;
    const alreadyHasBrand = BRAND_PATTERNS.some(e => e.p.test(keywords));
    if (!alreadyHasBrand) {
      for (const e of BRAND_PATTERNS) {
        if (e.p.test(keywords.replace(/^w+s+/, ''))) {
          searchKeywords = e.b + ' ' + keywords;
          break;
        }
      }
    }
    // Strip 'remote control' suffix if brand was added
    if (searchKeywords !== keywords) {
      searchKeywords = searchKeywords.replace(/\s*remote\s*control$/i, '').trim();
    }
    console.log(`Search keywords: ${searchKeywords}`);

    // ── RapidAPI call ─────────────────────────────────────────────────────────
    const soldRes = await fetch('https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'ebay-average-selling-price.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPID_KEY
      },
      body: JSON.stringify({
        keywords: searchKeywords,
        excluded_keywords: 'lot wholesale parts broken',
        max_search_results: '60',
        remove_outliers: 'false',
        site_id: '0'
      })
    });
    const soldData = await soldRes.json();

    // ── Full debug dump so we can see the real shape once ─────────────────────
    console.log('=== RapidAPI RAW RESPONSE ===');
    console.log('Top-level keys:', Object.keys(soldData));
    console.log('average_price:', soldData.average_price);
    console.log('total_results:', soldData.total_results);
    // "results" might be a count OR an array — log both type and value
    console.log('results (type):', typeof soldData.results, '| value:', Array.isArray(soldData.results) ? `array[${soldData.results.length}]` : soldData.results);
    console.log('products (type):', typeof soldData.products, '| count:', Array.isArray(soldData.products) ? soldData.products.length : 'n/a');
    // Log first item of whichever array exists so we can see field names
    const sampleArray = soldData.products || soldData.results || soldData.items || [];
    if (Array.isArray(sampleArray) && sampleArray.length > 0) {
      console.log('Sample item keys:', Object.keys(sampleArray[0]));
      console.log('Sample item:', JSON.stringify(sampleArray[0]));
    }
    console.log('=============================');

    // ── Resolve the items array — handle every known field name ───────────────
    // RapidAPI has returned: products[], results[], items[] across different versions
    const itemsArray = Array.isArray(soldData.products) ? soldData.products
                     : Array.isArray(soldData.results)  ? soldData.results
                     : Array.isArray(soldData.items)    ? soldData.items
                     : [];

    // ── Sold count ────────────────────────────────────────────────────────────
    // total_results is the authoritative count; fall back to items array length
    const soldCount = (() => {
      const raw = soldData.total_results ?? soldData.totalResults ?? soldData.total;
      if (raw !== undefined && raw !== null) {
        const n = parseInt(raw, 10);
        if (!isNaN(n)) return n;
      }
      return itemsArray.length; // last resort
    })();

    // ── Average sold price ────────────────────────────────────────────────────
    let avgSoldPrice = 0;

    if (itemsArray.length > 0) {
      // Filter to USD only; tolerate currency stored as 'USD', '$', or missing (assume USD when site_id=0)
      const usdItems = itemsArray.filter(p => {
        const c = (p.currency || p.Currency || '').toString().toUpperCase();
        return c === 'USD' || c === '$' || c === '';
      });
      console.log(`Items total: ${itemsArray.length} | USD items: ${usdItems.length}`);

      // Price field varies: sale_price, price, sold_price, currentPrice, sellingStatus…
      const prices = usdItems
        .map(p => {
          const raw = p.sale_price ?? p.price ?? p.sold_price ?? p.currentPrice ?? p.sellingStatus?.currentPrice?.value;
          return parseFloat(raw);
        })
        .filter(p => !isNaN(p) && p > 0);

      console.log(`Valid prices found: ${prices.length} | sample: ${prices.slice(0, 5)}`);

      if (prices.length > 0) {
        avgSoldPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        console.log(`Computed avg from items: $${avgSoldPrice.toFixed(2)}`);
      } else {
        // Items exist but no parseable prices — fall back to API-level average
        avgSoldPrice = parseFloat(soldData.average_price || 0);
        console.log(`No parseable prices in items; using API average_price: $${avgSoldPrice}`);
      }
    } else {
      // No items array at all — use the API-level average
      avgSoldPrice = parseFloat(soldData.average_price || 0);
      console.log(`No items array; using API average_price: $${avgSoldPrice}`);
    }

    // ── Active listing count (eBay Browse API, US only) ───────────────────────
    let activeCount = 0;
    try {
      const token = await getEbayToken();
      const activeRes = await fetch(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(searchKeywords.replace(/\s*remote\s*control$/i, "").trim())}&limit=1&filter=buyingOptions:%7BFIXED_PRICE%7D,itemLocationCountry:US`,
        { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
      );
      const activeData = await activeRes.json();
      console.log(`Active search keywords: ${searchKeywords}`);
      console.log(`Active count raw: ${activeData.total}`);
      activeCount = parseInt(activeData.total || 0, 10);
    } catch (e) {
      console.log('Active count error:', e.message);
    }

    // ── Sell-through rate ─────────────────────────────────────────────────────
    const sellThru = activeCount > 0 ? soldCount / activeCount
                   : soldCount > 0   ? 999
                   : 0;

    const result = {
      avgSoldPrice: parseFloat(avgSoldPrice.toFixed(2)),
      soldCount,
      activeCount,
      totalCount: soldCount + activeCount,
      sellThru: parseFloat(sellThru.toFixed(4)),
      hasData: soldCount > 0 || activeCount > 0
    };

    console.log(`✅ Final: avg=$${result.avgSoldPrice} sold=${soldCount} active=${activeCount} sellThru=${(sellThru * 100).toFixed(0)}%`);
    res.json(result);

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(process.cwd(), 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
