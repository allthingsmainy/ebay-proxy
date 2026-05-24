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

async function queryTerapeak(keywords, tabName) {
  const now = Date.now();
  const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    marketplace: 'EBAY-US',
    keywords,
    dayRange: '90',
    endDate: now.toString(),
    startDate: ninetyDaysAgo.toString(),
    categoryId: '61312',
    offset: '0',
    limit: '50',
    tabName,
    tz: 'America/Los_Angeles',
    modules: 'aggregates',
  });
  // modules needs to be repeated
  params.append('modules', 'searchResults');
  params.append('modules', 'resultsHeader');

  const url = `https://www.ebay.com/sh/research/api/search?${params.toString()}`;
  console.log(`Terapeak ${tabName} query: ${keywords}`);

  const res = await fetch(url, {
    headers: {
      'Cookie': process.env.EBAY_COOKIE,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': 'https://www.ebay.com/sh/research',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
      'X-Requested-With': 'XMLHttpRequest'
    }
  });

  if (!res.ok) {
    console.log(`Terapeak ${tabName} HTTP error: ${res.status}`);
    return null;
  }

  // Response is newline-delimited JSON objects
  const text = await res.text();
  const lines = text.trim().split('\n').filter(Boolean);
  const modules = {};
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.meta && obj.meta.name) {
        modules[obj.meta.name] = obj;
      }
    } catch (e) {}
  }
  return modules;
}

function parseAggregates(modules) {
  const agg = modules?.aggregates;
  if (!agg || !agg.sections) return null;

  let avgPrice = 0, soldCount = 0, sellThru = 0, activeCount = 0;

  for (const section of agg.sections) {
    for (const item of section.dataItems || []) {
      const header = item.header?.textSpans?.[0]?.text || '';
      const value = item.value?.textSpans?.[0]?.text || '';
      const clean = value.replace(/[$,%]/g, '').replace(/,/g, '').trim();

      if (header === 'Avg sold price') avgPrice = parseFloat(clean) || 0;
      if (header === 'Total sold') soldCount = parseInt(clean) || 0;
      if (header === 'Sell-through') sellThru = parseFloat(clean) / 100 || 0;
      if (header === 'Total active') activeCount = parseInt(clean) || 0;
      if (header === 'Total listings') activeCount = parseInt(clean) || 0;
    }
  }
  return { avgPrice, soldCount, sellThru, activeCount };
}

app.post('/ebay', async (req, res) => {
  try {
    const { keywords } = req.body;
    const modelClean = keywords.replace(/\s*remote\s*control$/i, '').trim();
    const brand = detectBrand(modelClean);
    const hasBrand = brand && modelClean.toUpperCase().startsWith(brand.toUpperCase());
    const searchTerm = (brand && !hasBrand) ? `${brand} ${modelClean}` : modelClean;

    console.log(`Searching Terapeak for: "${searchTerm}"`);

    // Query sold and active in parallel
    const [soldModules, activeModules] = await Promise.all([
      queryTerapeak(searchTerm, 'SOLD'),
      queryTerapeak(searchTerm, 'ACTIVE')
    ]);

    const soldData = parseAggregates(soldModules);
    const activeData = parseAggregates(activeModules);

    console.log('Sold data:', JSON.stringify(soldData));
    console.log('Active data:', JSON.stringify(activeData));

    if (!soldData) {
      return res.status(500).json({ error: 'Could not fetch sold data from Terapeak' });
    }

    const soldCount = soldData.soldCount;
    const avgSoldPrice = soldData.avgPrice;

    // Get active count from active tab
    const activeCount = activeData?.soldCount || activeData?.activeCount || 0;

    // Compute sell-through your way: sold / active * 100
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
