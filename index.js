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

app.post('/ebay', async (req, res) => {
  try {
    const body = { ...req.body, site_id: '0', currency_id: 'USD' };
    const response = await fetch('https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'ebay-average-selling-price.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPID_KEY
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    // Filter to USD only
    if (data.products) {
      data.products = data.products.filter(p => p.currency === 'USD' || p.currency === '$');
      const usdPrices = data.products.map(p => parseFloat(p.sale_price)).filter(p => p > 0);
      if (usdPrices.length > 0) {
        data.average_price = usdPrices.reduce((a,b)=>a+b,0) / usdPrices.length;
        data.results = usdPrices.length;
      }
    }
    console.log('RapidAPI filtered response: avg=$' + (data.average_price||0).toFixed(2) + ' count=' + (data.results||0));
    res.json(data);
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
