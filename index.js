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

    // Get sold data from RapidAPI
    const soldRes = await fetch('https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'ebay-average-selling-price.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPID_KEY
      },
      body: JSON.stringify({
        keywords,
        excluded_keywords: 'lot wholesale parts broken',
        max_search_results: '60',
        remove_outliers: 'false',
        site_id: '0'
      })
    });
    const soldData = await soldRes.json();
    console.log('RapidAPI response keys:', Object.keys(soldData));
    console.log('average_price:', soldData.average_price, 'total_results:', soldData.total_results, 'results:', soldData.results);

    // Use USD products only for avg price calculation
    let avgSoldPrice = 0;
    if (soldData.products && soldData.products.length > 0) {
      const usdProducts = soldData.products.filter(p => p.currency === 'USD' || p.currency === '$');
      if (usdProducts.length > 0) {
        const prices = usdProducts.map(p => parseFloat(p.sale_price)).filter(p => p > 0);
        avgSoldPrice = prices.length ? prices.reduce((a,b)=>a+b,0)/prices.length : 0;
        console.log('USD products:', usdProducts.length, 'avg:', avgSoldPrice.toFixed(2));
      } else {
        // Fall back to API average_price if no USD products found
        avgSoldPrice = parseFloat(soldData.average_price || 0);
        console.log('No USD products, using API avg:', avgSoldPrice);
      }
    }
    const soldCount = parseInt(soldData.total_results || soldData.results || 0);

    // Get active US-only listing count
    let activeCount = 0;
    try {
      const token = await getEbayToken();
      const activeRes = await fetch(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(keywords)}&limit=1&filter=buyingOptions:%7BFIXED_PRICE%7D,itemLocationCountry:US`,
        { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
      );
      const activeData = await activeRes.json();
      activeCount = parseInt(activeData.total || 0);
    } catch(e) {
      console.log('Active count error:', e.message);
    }

    const sellThru = activeCount > 0 ? soldCount / activeCount : (soldCount > 0 ? 999 : 0);

    const result = {
      avgSoldPrice: parseFloat(avgSoldPrice.toFixed(2)),
      soldCount,
      activeCount,
      totalCount: soldCount + activeCount,
      sellThru: parseFloat(sellThru.toFixed(4)),
      hasData: soldCount > 0 || activeCount > 0
    };

    console.log(`Result: avg=$${result.avgSoldPrice} sold=${soldCount} active=${activeCount} sellThru=${(sellThru*100).toFixed(0)}%`);
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
