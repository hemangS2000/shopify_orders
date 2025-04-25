require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/get-product', async (req, res) => {
  try {
    const { productId } = req.body;
    
    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-04/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.ACCESS_TOKEN
        },
        body: JSON.stringify({
          query: `query listProductMetafields($id: ID!) {
            product(id: $id) {
              images(first:1) { edges { node { originalSrc } } 
              metafields(first:10) { edges { node { id namespace key value } }
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