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

let ordersStore = [];

// Webhook Verification Middleware
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

// Webhook Handler with Global ID Conversion
app.post('/api/webhook/orders', verifyWebhook, async (req, res) => {
  try {
    const webhookOrder = req.body;
    const totalItemCount = webhookOrder.line_items.reduce((sum, item) => sum + item.current_quantity, 0);

    // Prepare all product IDs for batch query
    const productIds = webhookOrder.line_items.map(
      item => `gid://shopify/Product/${item.product_id}`
    );

    // Batch fetch all product data in a single API call
    const productResponse = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.ACCESS_TOKEN
        },
        body: JSON.stringify({
          query: `query GetMultipleProductDetails($ids: [ID!]!, $namespace: String!, $key: String!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                title
                featuredImage { originalSrc }
                images(first: 1) { edges { node { originalSrc } } }
                metafield(namespace: $namespace, key: $key) { value }
              }
            }
          }`,
          variables: {
            ids: productIds,
            namespace: "shopify_data",
            key: "mini_title"
          }
        })
      }
    );

    const productData = await productResponse.json();
    const productsById = {};
    
    // Create a lookup dictionary for products
    productData.data?.nodes?.forEach(product => {
      if (product) {
        productsById[product.id] = product;
      }
    });

    // Transform line items with product data
    const lineItemsWithProductData = webhookOrder.line_items.map(item => {
      const productId = `gid://shopify/Product/${item.product_id}`;
      return {
        title: item.title,
        product_id: productId,
        variant_id: item.variant_id,
        requires_shipping: item.requires_shipping,
        quantity: item.current_quantity,
        product_data: productsById[productId] || null
      };
    });

    const transformedOrder = {
      id: webhookOrder.id,
      order_number: webhookOrder.order_number,
      line_items: lineItemsWithProductData,
      total_item_count: totalItemCount,
      shipping_address: {
        name: webhookOrder.shipping_address?.name,
        address1: webhookOrder.shipping_address?.address1,
        address2: webhookOrder.shipping_address?.address2,
        city: webhookOrder.shipping_address?.city,
        zip: webhookOrder.shipping_address?.zip,
        country_code: webhookOrder.shipping_address?.country_code,
        phone: webhookOrder.shipping_address?.phone
      },
      shipping_lines: webhookOrder.shipping_lines.map(shipping => ({
        title: shipping.title,
        code: shipping.code
      })),
      created_at: new Date().toISOString()
    };

    ordersStore = [transformedOrder, ...ordersStore.slice(0, 49)];
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Internal Server Error');
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

// Updated Product Image Endpoint (uses pre-fetched data)
app.post('/api/get-product', async (req, res) => {
  try {
    const { orderId } = req.body;
    
    const order = ordersStore.find(o => o.id === orderId);
    if (!order) {
      return res.status(404).json({ 
        error: 'Order not found',
        details: 'Order may have expired from memory'
      });
    }

    res.json({
      data: {
        order: {
          line_items: order.line_items.map(item => ({
            product_data: item.product_data
          }))
        }
      }
    });
  } catch (error) {
    console.error('Product fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Posti API Endpoint (unchanged)
app.post('/api/find-pickup-point', async (req, res) => {
  try {
    const { streetAddress, postcode, locality, countryCode } = req.body;
    
    const postiUrl = new URL("https://sbxgw.ecosystem.posti.fi/location/v3/find-by-address");
    postiUrl.searchParams.append("streetAddress", streetAddress);
    postiUrl.searchParams.append("postcode", postcode);
    postiUrl.searchParams.append("locality", locality || '');
    postiUrl.searchParams.append("countryCode", countryCode || 'FI');
    postiUrl.searchParams.append("limit", "10");

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

// Fulfillment Endpoint (unchanged)
app.post('/api/fulfill-order', async (req, res) => {
  const { orderId } = req.body;
  try {
    // 1️ GET fulfillment orders (REST)
    const getResp = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-04/orders/${orderId}/fulfillment_orders.json`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    const getData = await getResp.json();
    const fulfillmentOrderId = getData.fulfillment_orders?.[0]?.id;
    if (!fulfillmentOrderId) {
      return res.status(400).json({ success: false, error: 'No fulfillment order found' });
    }

    // 2️ POST GraphQL fulfillmentCreate
    const mutation = `
      mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { field message }
        }
      }
    `;
    const variables = {
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: `gid://shopify/FulfillmentOrder/${fulfillmentOrderId}`,
            fulfillmentOrderLineItems: []
          }
        ],
        notifyCustomer: false,
        trackingInfo: {
          company: "Postii",
          number: "856236255210",
          url: `https://www.posti.fi/en/tracking#/lahetys/856236255210`
        }
      }
    };

    const postResp = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-04/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': process.env.ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: mutation, variables })
      }
    );
    const postData = await postResp.json();
    const status = postData?.data?.fulfillmentCreate?.fulfillment?.status;
    if (status === 'SUCCESS') {
      return res.json({ success: true });
    } else {
      return res
        .status(400)
        .json({ success: false, error: postData.data.fulfillmentCreate.userErrors });
    }
  } catch (err) {
    console.error('Fulfillment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));