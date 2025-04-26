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

// In-memory order storage (replace with DB in production)
let ordersStore = [];

// Webhook Verification Middleware
const verifyWebhook = (req, res, next) => {
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const generatedHash = crypto
      .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest('base64');

    if (generatedHash !== hmac) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  } catch (error) {
    console.error('Webhook verification failed:', error);
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// Webhook Endpoint
app.post('/api/webhook/orders', verifyWebhook, (req, res) => {
  try {
    const webhookOrder = req.body;
    
    const transformedOrder = {
      id: webhookOrder.id,
      order_number: webhookOrder.order_number,
      source_name: webhookOrder.source_name,
      customer: {
        email: webhookOrder.email,
        phone: webhookOrder.shipping_address?.phone
      },
      shipping_address: {
        name: webhookOrder.shipping_address?.name,
        address1: webhookOrder.shipping_address?.address1,
        address2: webhookOrder.shipping_address?.address2,
        zip: webhookOrder.shipping_address?.zip,
        city: webhookOrder.shipping_address?.city,
        country_code: webhookOrder.shipping_address?.country_code,
        phone: webhookOrder.shipping_address?.phone
      },
      line_items: webhookOrder.line_items.map(item => ({
        title: item.title,
        product_id: item.product_id,
        requires_shipping: item.requires_shipping
      })),
      shipping_lines: webhookOrder.shipping_lines.map(shipping => ({
        title: shipping.title,
        price: shipping.price
      })),
      created_at: new Date(webhookOrder.created_at).toISOString()
    };

    // Store last 50 orders
    ordersStore = [transformedOrder, ...ordersStore.slice(0, 49)];
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Orders Endpoint
app.get('/api/orders', (req, res) => {
  try {
    res.json(ordersStore);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Product Image Endpoint
app.post('/api/get-product', async (req, res) => {
  try {
    const { productId } = req.body;
    
    const response = await fetch(
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

    const data = await response.json();
    res.json(data);
  } catch (error) {
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

    const postiRes = await fetch(postiUrl.toString(), {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${process.env.POSTI_API_TOKEN}`,
        "Accept-Language": "en"
      }
    });

    const data = await postiRes.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));