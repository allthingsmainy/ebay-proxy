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

function detectBrand(model) {
  const m = model.toUpperCase()
    .replace(/^(DENON|SONY|SAMSUNG|LG|YAMAHA|PANASONIC|VIZIO|TOSHIBA|PHILIPS|JVC|SANYO|MAGNAVOX|MEMOREX|XFINITY|DISH)\s+/, '');
  if (/^RC[-\s]?\d{4}/.test(m)) return 'Denon';
  if (/^(AA59|BN59)[-\s]?\d+/.test(m)) return 'Samsung';
  if (/^TM\d{4}/.test(m)) return 'Samsung';
  if (/^(RMT|RM-)/.test(m)) return 'Sony';
  if (/^(AKB|AGF|MKJ)\d+/.test(m)) return 'LG';
  if (/^(FSR|RAV)\d+/.test(m)) return 'Yamaha';
  if (/^EUR\d+/.test(m)) return 'Panasonic';
  if (/^XRT\d+/.test(m)) return 'Vizio';
  if (/^CT[-\s]?\d+/.test(m)) return 'Toshiba';
  return null;
}

function normalizeModel(str) {
  return str.replace(/\b(RC|RMT|AKB|BN59|XRT|RAV|EUR|FSR|CT)\s(\w)/gi, '$1-$2');
}

// Get active listing count using eBay Finding API
async function getActiveCount(searchTerm) {
  try {
    const url = `https://svcs.ebay.com/services/search/FindingService/v1` +
      `?OPERATION-NAME=findItemsAdvanced` +
      `&SERVICE-VERSION=1.0.0` +
      `&SECURITY-APPNAME=${process.env.EBAY_APP_ID}` +
      `&RESPONSE-DATA-FORMAT=JSON` +
      `&REST-PAYLOAD` +
      `&keywords=${encodeURIComponent('"' + searchTerm + '"')}` +
      `&itemFilter(0).name=ListingType&itemFilter(0).value=FixedPrice` +
      `&itemFilter(1).name=Condition&itemFilter(1).value=Used` +
      `&itemFilter(2).name=LocatedIn&itemFilter(2).value=US` +
      `&paginationInput.entriesPerPage=1` +
      `&paginationInput.pageNumber=1`;

    const res = await fetch(url);
    const data = await res.json();
    const total = parseInt(
      data?.findItemsAdvancedResponse?.[0]?.paginationOutput?.[0]?.totalEntries?.[0] || 0,
      10
    );
    console.log(`Finding API active count for "${searchTerm}": ${total}`);
    return total;
  } catch (e) {
    console.log('Finding API error:', e.message);
    return null;
  }
}

app.post('/ebay', async (req, res) => {
  try {
    const { keywords } = req.body;

    const modelClean = keywords.replace(/\s*remote\s*control$/i, '').trim();
    const brand = detectBrand(modelClean);
    const hasBrand = brand && modelClean.toUpperCase().startsWith(brand.toUpperCase());
    const brandedSearch = (brand && !hasBrand) ? `${brand} ${modelClean}` : modelClean;
    const activeSearch = normalizeModel(brandedSearch);

    console.log(`Model: "${modelClean}" | Brand: ${brand} | Active search: "${activeSearch}"`);

    // ── RapidAPI sold data ────────────────────────────────────────────────────
    const soldRes = await fetch('https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'ebay-average-selling-price.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPID_KEY
      },
      body: JSON.stringify({
        keywords: keywords,
        excluded_keywords: 'lot wholesale parts broken',
        max_search_results: '240',
        remove_outliers: 'false',
        site_id: '0'
      })
    });
    const soldData = await soldRes.json();

    const itemsArray = Array.isArray(soldData.products) ? soldData.products
                     : Array.isArray(soldData.results)  ? soldData.results
                     : Array.isArray(soldData.items)    ? soldData.items
                     : [];

    const soldCount = (() => {
      const raw = soldData.total_results ?? soldData.totalResults ?? soldData.total;
      if (raw !== undefined && raw !== null) {
        const n = parseInt(raw, 10);
        if (!isNaN(n)) return n;
      }
      return itemsArray.length;
    })();

    let avgSoldPrice = 0;
    if (itemsArray.length > 0) {
      const usdItems = itemsArray.filter(p => {
        const c = (p.currency || '').toString().toUpperCase();
        return c === 'USD' || c === '$' || c === '';
      });
      const prices = usdItems
        .map(p => parseFloat(p.sale_price ?? p.price ?? p.sold_price ?? 0))
        .filter(p => !isNaN(p) && p > 0);
      avgSoldPrice = prices.length
        ? prices.reduce((a, b) => a + b, 0) / prices.length
        : parseFloat(soldData.average_price || 0);
    } else {
      avgSoldPrice = parseFloat(soldData.average_price || 0);
    }

    console.log(`Sold: ${soldCount} | Avg: $${avgSoldPrice.toFixed(2)}`);

    // ── Active count via Finding API ──────────────────────────────────────────
    let activeCount = await getActiveCount(activeSearch) ?? 0;

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

    console.log(`✅ Final: avg=$${result.avgSoldPrice} sold=${soldCount} active=${activeCount} sellThru=${(sellThru*100).toFixed(0)}%`);
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
