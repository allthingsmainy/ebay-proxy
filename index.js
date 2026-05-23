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
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });
  const data = await response.json();
  return data.access_token;
}

app.post('/ebay', async (req, res) => {
  try {
    const { keywords } = req.body;
    const token = await getEbayToken();

    // Search active listings
    const activeRes = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(keywords)}&limit=50&filter=buyingOptions:{FIXED_PRICE}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
      }
    });
    const activeData = await activeRes.json();
    const activeItems = activeData.itemSummaries || [];
    const activePrices = activeItems.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0);
    const avgActivePrice = activePrices.length ? activePrices.reduce((a,b) => a+b, 0) / activePrices.length : 0;

    // Search sold listings
    const soldRes = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(keywords)}&limit=50&filter=buyingOptions:{FIXED_PRICE},soldItems:true`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
      }
    });
    const soldData = await soldRes.json();
    const soldItems = soldData.itemSummaries || [];
    const soldPrices = soldItems.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0);
    const avgSoldPrice = soldPrices.length ? soldPrices.reduce((a,b) => a+b, 0) / soldPrices.length : 0;

    const result = {
      avgSoldPrice: parseFloat(avgSoldPrice.toFixed(2)),
      soldCount: soldItems.length,
      activeCount: activeItems.length,
      avgActivePrice: parseFloat(avgActivePrice.toFixed(2)),
      totalCount: activeItems.length + soldItems.length,
      hasData: activeItems.length > 0 || soldItems.length > 0
    };

    console.log('eBay result:', JSON.stringify(result));
    res.json(result);
  } catch (err) {
    console.error('eBay error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(process.cwd(), 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
