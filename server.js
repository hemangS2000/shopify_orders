require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// 1️⃣ Create a new Schema object
const OrderSchema = new mongoose.Schema({

  shopifyId:     { type: String, unique: true, required: true },
  orderNumber:   { type: String, required: true },

  // your existing line_items array (we’ll let it be “any” shape for now)
  line_items:    { type: Array, default: [] },

  // shipping_address as a plain JS object
  shipping_address: { type: Object, default: {} },

  // shipping_lines array
  shipping_lines:   { type: Array, default: [] },

  // the timestamp when Shopify sent the order
  created_at:       { type: Date, default: Date.now },

  dimensions: {
    length: { type: Number, default: null },  // L in cm
    width:  { type: Number, default: null },  // W in cm
    height: { type: Number, default: null },  // H in cm
    weight: { type: Number, default: null },  // weight in kg
    boxes:  { type: Number, default: null }   // box count, whole number
  },
  pickupPoint: { 
    pupCode: String,
    publicName: String,
    streetAddress: String,
    postcode: String,
    city: String,
    countryCode: String,
    parcelLocker: Boolean,
    distance: String,
  },
  isFulfilled: { type: Boolean, default: false },
  shipping_method: { type: String, enum: ['service_point', 'home_delivery'] }
}, {
  timestamps: true
});

// 2️⃣ Compile the schema into a Model class
const Order = mongoose.model('Order', OrderSchema);



// Middleware Configuration
app.use(cors({
  origin: [process.env.RENDER_EXTERNAL_URL, 'http://localhost:3000'],
  optionsSuccessStatus: 200
}));
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));
app.use(express.static('public'));


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
            namespace: "test_data",
            key: "binding_mount"
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

    // decide default shipping_method based on Shopify shipping_lines title
    const shippingTitle = webhookOrder.shipping_lines[0]?.title || '';
    let defaultMethod = 'home_delivery';

    // if your “High Price” or “Low Price” shipping line means pickup…
    if (shippingTitle === 'Standard - Pickup Point') {
      defaultMethod = 'service_point';
    }else if (shippingTitle === 'Standard - Home Delivery') {
      defaultMethod = 'home_delivery';
    }

    const transformedOrder = {
      shopifyId: webhookOrder.id.toString(),
      orderNumber: webhookOrder.order_number,
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
      shipping_method: defaultMethod,
      shipping_lines: webhookOrder.shipping_lines.map(shipping => ({
        title: shipping.title,
        code: shipping.code
      })),
      created_at: new Date().toISOString()
    };

     // Upsert into Mongo:
    await Order.findOneAndUpdate(
      { shopifyId: transformedOrder.shopifyId },
      { $set: transformedOrder },
      { upsert: true, setDefaultsOnInsert: true }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Get Orders Endpoint
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find()
      .sort({ created_at: -1 })
      .limit(50)
      .lean();
    res.json(orders);
  } catch (err) {
    console.error('Fetch orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

//measurements endpoint
app.post('/api/update-measurements', async (req, res) => {
  const { orderId, dimensions, method } = req.body;
  try {
    const updated = await Order.findOneAndUpdate(
      { shopifyId: orderId.toString() },
      { $set: { dimensions, shipping_method: method } },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Save measurements error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// Updated Product Image Endpoint (uses pre-fetched data)
app.post('/api/get-product', async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findOne({ shopifyId: orderId.toString() }).lean();

    if (!order) {
      return res.status(404).json({ 
        error: 'Order not found'
      });
    }

    // Return the complete order with line_items
    res.json({
      data: order  // Changed structure to match frontend expectations
    });
  } catch (error) {
    console.error('Product fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/update-pickup-point', async (req, res) => {
  const { orderId, pickupPoint } = req.body;
  try {
    const updated = await Order.findOneAndUpdate(
      { shopifyId: orderId.toString() },
      { $set: { pickupPoint } },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Save pickup point error:', err);
    res.status(500).json({ success: false, error: err.message });
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
    postiUrl.searchParams.append("limit", "15");

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


// Posti create orders endpoint
app.post('/api/create-posti-service-point', async (req, res) => {
  try {
    const { orderId, dimensions, orderData } = req.body;
    
    const shipmentData = {
      pdfConfig: {
        target1XOffset: 0,
        target1YOffset: 0,
        target1Media: "thermo-225",
        target2XOffset: 0,
        target2YOffset: 0,
        target2Media: "laser-a4",
        target3XOffset: 0,
        target3YOffset: 0,
        target3Media: null,
        target4XOffset: 0,
        target4YOffset: 0,
        target4Media: null
      },
      shipment: {
        sender: {
          name: "Posti Oy",
          address1: "Postintaival 7",
          zipcode: "00230",
          city: "HELSINKI",
          country: "FI",
          phone: "+35820077000",
          email: "consumerservice@posti.com"
        },
        senderPartners: [
          {
            id: "POSTI",
            custNo: "654321"
          }
        ],
        receiver: {
          name: orderData.shipping_address.name,
          address1: orderData.shipping_address.address1,
          address2: orderData.shipping_address.address2 || '',
          zipcode: orderData.shipping_address.zip,
          city: orderData.shipping_address.city,
          country: orderData.shipping_address.country_code,
          phone: orderData.shipping_address.phone || '',
          email: ""
        },
        agent: {
          quickId: "207003200", // Example ID, replace with actual or get from pickup point selection
          name: "Posti Service Point",
          address1: "Example Street 1",
          zipcode: "00100",
          city: "HELSINKI",
          country: "FI"
        },
        service: {
          id: "PO2103" // Hardcoded service point ID
        },
        parcels: [
          {
            copies: dimensions.boxes.toString(),
            weight: dimensions.weight.toString(),
            contents: "Products",
            valuePerParcel: true
          }
        ]
      }
    };

    const response = await fetch('https://gateway.posti.fi/shippingapi/api/v1/shipping/order', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.POSTI_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(shipmentData)
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to create Posti service point shipment');
    }

    const data = await response.json();
    res.json({ success: true, data });
  } catch (error) {
    console.error('Posti service point error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/create-posti-home-delivery', async (req, res) => {
  try {
    const { orderId, dimensions, orderData } = req.body;
    
    const shipmentData = {
      pdfConfig: {
        target1XOffset: 0,
        target1YOffset: 0,
        target1Media: "thermo-225",
        target2XOffset: 0,
        target2YOffset: 0,
        target2Media: "laser-a4",
        target3XOffset: 0,
        target3YOffset: 0,
        target3Media: null,
        target4XOffset: 0,
        target4YOffset: 0,
        target4Media: null
      },
      shipment: {
        sender: {
          name: "Posti Oy",
          address1: "Postintaival 7",
          zipcode: "00230",
          city: "HELSINKI",
          country: "FI",
          phone: "+35820077000",
          email: "consumerservice@posti.com"
        },
        senderPartners: [
          {
            id: "POSTI",
            custNo: "654321"
          }
        ],
        receiver: {
          name: orderData.shipping_address.name,
          address1: orderData.shipping_address.address1,
          address2: orderData.shipping_address.address2 || '',
          zipcode: orderData.shipping_address.zip,
          city: orderData.shipping_address.city,
          country: orderData.shipping_address.country_code,
          phone: orderData.shipping_address.phone || '',
          email: ""
        },
        service: {
          id: "PO2104" // Hardcoded home delivery ID
        },
        parcels: [
          {
            copies: dimensions.boxes.toString(),
            weight: dimensions.weight.toString(),
            contents: "Products",
            valuePerParcel: true
          }
        ]
      }
    };

    const response = await fetch('https://gateway.posti.fi/shippingapi/api/v1/shipping/order', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.POSTI_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(shipmentData)
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to create Posti home delivery shipment');
    }

    const data = await response.json();
    res.json({ success: true, data });
  } catch (error) {
    console.error('Posti home delivery error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});




// Fulfillment Endpoint 
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
      await Order.findOneAndUpdate(
        { shopifyId: orderId.toString() },
        { $set: { isFulfilled: true, fulfilledAt: new Date() } }
      );
      return res.json({ success: true });
    } else {
      return res
        .status(400)
        .json({ success: false, error: postData.data.fulfillmentCreate.userErrors });
    }
  }
  
  catch (err) {
    console.error('Fulfillment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));