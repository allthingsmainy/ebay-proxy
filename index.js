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
    const soldBody = { ...req.body, site_id: '0', currency_id: 'USD' };
    const soldRes = await fetch('https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'ebay-average-selling-price.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPID_KEY
      },
      body: JSON.stringify(soldBody)
    });
    const soldData = await soldRes.json();

    // Filter to USD only
    let avgSoldPrice = 0, soldCount = 0;
    if (soldData.products) {
      const usdProducts = soldData.products.filter(p => p.currency === 'USD' || p.currency === '$');
      const usdPrices = usdProducts.map(p => parseFloat(p.sale_price)).filter(p => p > 0);
      avgSoldPrice = usdPrices.length ? usdPrices.reduce((a,b)=>a+b,0)/usdPrices.length : 0;
      soldCount = usdPrices.length;
    }

    // Get active listing count from eBay Browse API
    let activeCount = 0;
    try {
      const token = await getEbayToken();
      const activeRes = await fetch(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(keywords)}&limit=1&filter=buyingOptions:%7BFIXED_PRICE%7D`,
        { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
      );
      const activeData = await activeRes.json();
      activeCount = parseInt(activeData.total || 0);
    } catch(e) {
      console.log('Active count failed:', e.message);
    }

    const sellThrough = (soldCount + activeCount) > 0 ? soldCount / (soldCount + activeCount) : 0;

    const result = {
      avgSoldPrice: parseFloat(avgSoldPrice.toFixed(2)),
      soldCount,
      activeCount,
      avgActivePrice: 0,
      totalCount: soldCount + activeCount,
      hasData: soldCount > 0 || activeCount > 0,
      sellThrough: parseFloat(sellThrough.toFixed(4))
    };

    console.log(`Result: avg=$${result.avgSoldPrice} sold=${soldCount} active=${activeCount} sellThru=${(sellThrough*100).toFixed(0)}%`);
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
