require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = 3000;

// Shopify credentials from .env
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_SECRET_KEY = process.env.SHOPIFY_API_SECRET_KEY;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;

// Maya Mobile credentials from .env
const MAYA_MOBILE_API_KEY = process.env.MAYA_MOBILE_API_KEY;
const MAYA_MOBILE_API_SECRET = process.env.MAYA_MOBILE_API_SECRET;
const MAYA_MOBILE_BASE_URL = 'https://connect-api.mayamobile.io/api';

// Middleware to parse JSON payloads
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString(); // Store raw body for webhook verification
  }
}));

// Function to verify Shopify webhook authenticity
const verifyShopifyWebhook = (req) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader) {
    console.error('Webhook verification failed: No HMAC header.');
    return false;
  }
  const digest = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET_KEY)
    .update(req.rawBody)
    .digest('base64');
  return digest === hmacHeader;
};

// Main webhook endpoint
app.post('/shopify/webhooks/orders/paid', async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.error('Webhook verification failed!');
    return res.status(401).send('Unauthorized');
  }

  const order = req.body;
  console.log(`Received paid order #${order.id}`);

  // Find the eSIM product in the order by checking for the maya.maya_product_id metafield
  const esimLineItem = order.line_items.find(item => {
    return item.properties.some(prop => prop.name === 'maya.maya_product_id' && prop.value);
  });

  if (!esimLineItem) {
    console.log(`Order #${order.id} does not contain a Maya Mobile eSIM product. Skipping fulfillment.`);
    return res.status(200).send('No eSIM product found. Skipping.');
  }

  try {
    const mayaSku = esimLineItem.properties.find(prop => prop.name === 'maya.maya_product_id').value;

    // Call Maya Mobile API to activate the eSIM
    const mayaResponse = await axios.post(`${MAYA_MOBILE_BASE_URL}/product/activate`, {
      api_key: MAYA_MOBILE_API_KEY,
      product_sku: mayaSku,
      customer_email: order.email,
      customer_id: order.customer.id,
      reference_id: order.id
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': MAYA_MOBILE_API_SECRET // Use the secret key for authorization
      }
    });

    const esimDetails = mayaResponse.data.data;
    console.log(`Successfully provisioned eSIM for order #${order.id}.`);

    // Fulfill the order in Shopify using the Maya Mobile response
    const fulfillmentPayload = {
      fulfillment: {
        location_id: order.fulfillments[0]?.location_id || null, // Use the first location ID if available
        tracking_number: null, // eSIMs don't have tracking numbers
        tracking_urls: [],
        notify_customer: true,
        line_items_by_fulfillment_order: [
          {
            fulfillment_order_id: esimLineItem.fulfillment_order_id,
            fulfillment_order_line_items: [
              { id: esimLineItem.id, quantity: esimLineItem.quantity }
            ]
          }
        ],
        // You can add the QR code to the fulfillment's note for customer email
        note: `Your eSIM QR Code: ${esimDetails.qrcode_image_url}\nActivation Code: ${esimDetails.activation_code}`
      }
    };

    const fulfillResponse = await axios.post(
      `https://${SHOPIFY_STORE_URL}/admin/api/2024-07/orders/${order.id}/fulfillments.json`,
      fulfillmentPayload,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`Order #${order.id} fulfilled successfully in Shopify.`);
    res.status(200).send('eSIM provisioned and order fulfilled.');

  } catch (error) {
    console.error(`Error processing order #${order.id}:`, error.response?.data || error.message);
    res.status(500).send('Error processing order.');
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});