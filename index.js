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
    const token = await getEbayToken();
    const encoded = encodeURIComponent(keywords);
    const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' };

    // Active listings
    const activeRes = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encoded}&limit=50&filter=buyingOptions:%7BFIXED_PRICE%7D`,
      { headers }
    );
    const activeData = await activeRes.json();
    const activeItems = activeData.itemSummaries || [];
    const activePrices = activeItems.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0);
    const avgActivePrice = activePrices.length ? activePrices.reduce((a,b)=>a+b,0)/activePrices.length : 0;

    // Sold listings using Browse API with lastSoldDate filter
    const soldRes = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encoded}&limit=50&filter=buyingOptions:%7BFIXED_PRICE%7D,soldItems:true`,
      { headers }
    );
    const soldData = await soldRes.json();
    const soldItems = soldData.itemSummaries || [];
    const soldPrices = soldItems.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0);
    const avgSoldPrice = soldPrices.length ? soldPrices.reduce((a,b)=>a+b,0)/soldPrices.length : 0;

    // Calculate sell-through using total from API if available
    const totalActive = parseInt(activeData.total || activeItems.length);
    const totalSold = parseInt(soldData.total || soldItems.length);

    console.log('Active:', activeItems.length, 'total:', totalActive, 'avg:', avgActivePrice.toFixed(2));
    console.log('Sold:', soldItems.length, 'total:', totalSold, 'avg:', avgSoldPrice.toFixed(2));

    const result = {
      avgSoldPrice: parseFloat(avgSoldPrice.toFixed(2)),
      soldCount: totalSold,
      activeCount: totalActive,
      avgActivePrice: parseFloat(avgActivePrice.toFixed(2)),
      totalCount: totalActive + totalSold,
      hasData: totalActive > 0 || totalSold > 0
    };

    console.log('Result:', JSON.stringify(result));
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
