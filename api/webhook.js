// api/webhook.js

const crypto = require('crypto');
const axios = require('axios');
const getRawBody = require('raw-body'); 

// Shopify credentials from .env
const SHOPIFY_API_SECRET_KEY = process.env.SHOPIFY_API_SECRET_KEY;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;

// Maya Mobile credentials from .env
const MAYA_MOBILE_API_KEY = process.env.MAYA_MOBILE_API_KEY;
const MAYA_MOBILE_API_SECRET = process.env.MAYA_MOBILE_API_SECRET;
const MAYA_MOBILE_BASE_URL = 'https://api.maya.net'; // Revised Base URL

// Main handler for the Vercel serverless function
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // 1. Get HMAC header from Shopify
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    if (!hmacHeader) {
      console.error('❌ Webhook verification failed: No HMAC header.');
      return res.status(401).send('Unauthorized');
    }

    // 2. Get and verify the raw body for security
    const rawBody = await getRawBody(req);
    const digest = crypto
      .createHmac('sha256', SHOPIFY_API_SECRET_KEY)
      .update(rawBody)
      .digest('base64');

    if (digest !== hmacHeader) {
      console.error('❌ Webhook verification failed!');
      return res.status(401).send('Unauthorized');
    }

    // 3. Parse the JSON order
    const order = JSON.parse(rawBody.toString('utf8'));
    console.log(`✅ Received paid order #${order.id}`);

    // 4. Find the fulfillment order and line item
    const esimLineItem = order.line_items.find(item =>
      item.properties?.some(prop => prop.name === 'maya.maya_product_id' && prop.value)
    );

    const esimFulfillmentOrder = order.fulfillment_orders.find(fo =>
      fo.line_items.some(li => li.id === esimLineItem.id)
    );

    if (!esimLineItem || !esimFulfillmentOrder) {
      console.log(`ℹ️ Order #${order.id} has no Maya Mobile eSIM or fulfillment order. Skipping.`);
      return res.status(200).send('No eSIM product found. Skipping.');
    }

    // 5. Get Maya SKU from properties
    const mayaSku = esimLineItem.properties.find(
      prop => prop.name === 'maya.maya_product_id'
    ).value;

    // 6. Activate eSIM via Maya API
    const mayaResponse = await axios.post(
      `${MAYA_MOBILE_BASE_URL}/connectivity/v1/esim`, // Revised Endpoint
      {
        api_key: MAYA_MOBILE_API_KEY,
        product_sku: mayaSku,
        customer_email: order.email,
        customer_id: order.customer.id,
        reference_id: order.id
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': MAYA_MOBILE_API_SECRET
        }
      }
    );

    const esimDetails = mayaResponse.data.data;
    console.log(`📲 eSIM provisioned for order #${order.id}.`);

    // 7. Fulfill order in Shopify using the Fulfillment Orders API
    const fulfillmentPayload = {
      fulfillment: {
        location_id: esimFulfillmentOrder.assigned_location.location_id,
        line_items_by_fulfillment_order: [
          {
            fulfillment_order_id: esimFulfillmentOrder.id,
            fulfillment_order_line_items: [
              { id: esimLineItem.id, quantity: esimLineItem.quantity }
            ]
          }
        ],
        notify_customer: true,
        message: `Your eSIM QR Code: ${esimDetails.qrcode_image_url}\nActivation Code: ${esimDetails.activation_code}`
      }
    };

    await axios.post(
      `https://${SHOPIFY_STORE_URL}/admin/api/2024-07/fulfillments.json`,
      fulfillmentPayload,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ Order #${order.id} fulfilled in Shopify.`);
    res.status(200).send('eSIM provisioned and order fulfilled.');
  } catch (error) {
    console.error(
      `❌ Error processing webhook for order ${req.headers['x-shopify-topic']} ${req.headers['x-shopify-order-id'] || 'unknown'}:`,
      error.response?.data || error.message
    );
    res.status(500).send('Error processing order.');
  }
};