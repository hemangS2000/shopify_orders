require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

// CORS Configuration
app.use(cors({
  origin: [
    process.env.RENDER_EXTERNAL_URL,
    'http://localhost:3000'
  ],
  optionsSuccessStatus: 200
}));

app.use(express.json());
app.use(express.static('public'));

// Shopify Product Endpoint
app.post('/api/get-product', async (req, res) => {
  try {
    const { productId } = req.body;

    // Validate product ID
    if (!productId?.startsWith('gid://shopify/Product/')) {
      return res.status(400).json({ error: "Invalid Product ID format" });
    }

    const shopifyResponse = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.ACCESS_TOKEN
        },
        body: JSON.stringify({
          query: `query GetProductImage($id: ID!) {
            product(id: $id) {
              title
              images(first: 1) {
                edges {
                  node {
                    originalSrc
                  }
                }
              }
            }
          }`,
          variables: { id: productId }
        })
      }
    );

    const data = await shopifyResponse.json();
    res.json(data);
    
  } catch (error) {
    console.error('Shopify API Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Posti Location Endpoint
app.post('/api/find-pickup-point', async (req, res) => {
  try {
    const { streetAddress, postcode, locality, countryCode } = req.body;

    const postiUrl = new URL("https://sbxgw.ecosystem.posti.fi/location/v3/find-by-address");
    postiUrl.searchParams.append("streetAddress", streetAddress);
    postiUrl.searchParams.append("postcode", postcode);
    postiUrl.searchParams.append("locality", locality);
    postiUrl.searchParams.append("countryCode", countryCode || 'FI');
    postiUrl.searchParams.append("limit", "1");

    const postiResponse = await fetch(postiUrl.toString(), {
      method: 'GET',
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${process.env.POSTI_API_TOKEN}`,
        "Accept-Language": "en"
      }
    });

    const data = await postiResponse.json();
    res.json(data);

  } catch (error) {
    console.error('Posti API Error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));