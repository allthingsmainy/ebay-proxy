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

    // Get sold data from RapidAPI - use their average_price directly (already USD)
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
        remove_outliers: 'true',
        site_id: '0'
      })
    });
    const soldData = await soldRes.json();
    const avgSoldPrice = parseFloat(soldData.average_price || 0);
    const soldCount = parseInt(soldData.total_results || soldData.results || 0);

    // Get active US-only listing count from eBay Browse API
    let activeCount = 0;
    try {
      const token = await getEbayToken();
      const activeRes = await fetch(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(keywords)}&limit=1&filter=buyingOptions:%7BFIXED_PRICE%7D,itemLocationCountry:US`,
        { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
      );
      const activeData = await activeRes.json();
      activeCount = parseInt(activeData.total || 0);
      console.log('Active raw total:', activeData.total);
    } catch(e)
