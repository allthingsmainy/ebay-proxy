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
  console.log('Token response:', data.access_token ? 'OK' : JSON.stringify(data));
  return data.access_token;
}

app.post('/ebay', async (req, res) => {
  try {
    const { keywords } = req.body;
    const token = await getEbayToken();

    // Active listings
    const activeRes = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(keywords)}&limit=50&filter=buyingOptions:%7BFIXED_PRICE%7D`,
      { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
    );
    const activeData = await activeRes.json();
    const activeItems = activeData.itemSummaries || [];
    const activePrices = activeItems.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0);
    const avgActivePrice = activePrices.length ? activePrices.reduce((a,b)=>a+b,0)/activePrices.length : 0;
    console.log('Active items:', activeItems.length, 'avg price:', avgActivePrice.toFixed(2));

    // Sold listings via Finding API (more reliable for sold data)
    const findingRes = await fetch(
      `https://svcs.ebay.com/services/search/FindingService/v1?OPERATION-NAME=findCompletedItems&SERVICE-VERSION=1.0.0&SECURITY-APPNAME=${process.env.EBAY_APP_ID}&RESPONSE-DATA-FORMAT=JSON&REST-PAYLOAD&keywords=${encodeURIComponent(keywords)}&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true&itemFilter(1).name=ListingType&itemFilter(1).value=FixedPrice&paginationInput.entriesPerPage=50`
    );
    const findingData = await findingRes.json();
    const soldItems = findingData?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    const soldPrices = soldItems.map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0)).filter(p => p > 0);
    const avgSoldPrice = soldPrices.length ? soldPrices.reduce((a,b)=>a+b,0)/soldPrices.length : 0;
    console.log('Sold items:', soldItems.length, 'avg sold price:', avgSoldPrice.toFixed(2));

    const result = {
      avgSoldPrice: parseFloat(avgSoldPrice.toFixed(2)),
      soldCount: soldItems.length,
      activeCount: activeItems.length,
      avgActivePrice: parseFloat(avgActivePrice.toFixed(2)),
      totalCount: activeItems.length + soldItems.length,
      hasData: activeItems.length > 0 || soldItems.length > 0
    };

    console.log('Final result:', JSON.stringify(result));
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
