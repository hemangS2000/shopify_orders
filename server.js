require('dotenv').config();
const express = require('express');
const cors = require('cors');

// node-fetch v2.x compatible require
const fetch = (...args) => 
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;


// Add new endpoint for pickup point lookup
app.post('/api/find-pickup-point', async (req, res) => {
  try {
    const { streetAddress, postcode, locality, countryCode } = req.body;
    
    const apiUrl = new URL("https://sbxgw.ecosystem.posti.fi/location/v3/find-by-address");
    apiUrl.searchParams.append("streetAddress", streetAddress);
    apiUrl.searchParams.append("postcode", postcode);
    apiUrl.searchParams.append("locality", locality);
    apiUrl.searchParams.append("countryCode", countryCode);
    apiUrl.searchParams.append("limit", "1");

    const postiResponse = await fetch(apiUrl.toString(), {
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
    res.status(500).json({ error: error.message });
  }
});

// Existing product endpoint remains the same




app.post('/api/get-product', async (req, res) => {
  try {
    const { productId } = req.body;
    
    if (!productId) {
      return res.status(400).json({ error: "Product ID required" });
    }

    const response = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2025-04/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': ACCESS_TOKEN
        },
        body: JSON.stringify({
          query: `query listProductMetafields($id: ID!) {
            product(id: $id) {
              title
              images(first: 1) {
                edges {
                  node {
                    originalSrc
                  }
                }
              }
              metafields(first: 10) {
                edges {
                  node {
                    id
                    namespace
                    key
                    value
                  }
                }
              }
            }
          }`,
          variables: { id: productId }
        })
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));