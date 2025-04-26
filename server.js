require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();

// Middleware Configuration
app.use(cors({
  origin: [process.env.RENDER_EXTERNAL_URL, 'http://localhost:3000'],
  optionsSuccessStatus: 200
}));
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));
app.use(express.static('public'));

// In-memory order storage
let ordersStore = [];

// Webhook Verification
const verifyWebhook = (req, res, next) => {
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const generatedHash = crypto
      .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest('base64');

    if (generatedHash !== hmac) return res.status(401).send('Unauthorized');
    next();
  } catch (error) {
    console.error('Webhook verification failed:', error);
    res.status(401).send('Unauthorized');
  }
};

// Webhook Handler
app.post('/api/webhook/orders', verifyWebhook, (req, res) => {
  try {
    const order = req.body;
    console.log('Received webhook for order:', order.id);

    const transformedOrder = {
      id: order.id,
      order_number: order.order_number,
      line_items: order.line_items.map(item => ({
        title: item.title,
        product_id: item.product_id,
        variant_id: item.variant_id,
        requires_shipping: item.requires_shipping
      })),
      shipping_address: {
        name: order.shipping_address?.name,
        address1: order.shipping_address?.address1,
        city: order.shipping_address?.city,
        zip: order.shipping_address?.zip,
        country_code: order.shipping_address?.country_code,
        phone: order.shipping_address?.phone
      },
      shipping_lines: order.shipping_lines.map(shipping => ({
        title: shipping.title,
        code: shipping.code
      })),
      created_at: new Date(order.created_at).toISOString()
    };

    ordersStore = [transformedOrder, ...ordersStore.slice(0, 49)];
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Get Orders
app.get('/api/orders', (req, res) => {
  try {
    res.json(ordersStore);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Product Details Endpoint
app.post('/api/get-product', async (req, res) => {
  try {
    const { productId } = req.body;
    console.log('Fetching product:', productId);

    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.ACCESS_TOKEN
        },
        body: JSON.stringify({
          query: `query GetProductWithImages($id: ID!) {
            product(id: $id) {
              title
              featuredImage {
                originalSrc
              }
              images(first: 5) {
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

    const data = await response.json();
    
    if (data.errors) {
      console.error('Shopify API Errors:', data.errors);
      return res.status(404).json({ 
        error: 'Product not found',
        details: data.errors
      });
    }

    res.json(data);
  } catch (error) {
    console.error('Product fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Posti API Endpoint
app.post('/api/find-pickup-point', async (req, res) => {
  try {
    const { streetAddress, postcode, locality, countryCode } = req.body;
    
    const postiUrl = new URL("https://sbxgw.ecosystem.posti.fi/location/v3/find-by-address");
    postiUrl.searchParams.append("streetAddress", streetAddress);
    postiUrl.searchParams.append("postcode", postcode);
    postiUrl.searchParams.append("locality", locality || '');
    postiUrl.searchParams.append("countryCode", countryCode || 'FI');
    postiUrl.searchParams.append("limit", "1");

    const response = await fetch(postiUrl.toString(), {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${process.env.POSTI_API_TOKEN}`,
        "Accept-Language": "en"
      }
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));