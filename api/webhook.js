const crypto = require('crypto');
const axios = require('axios');
const getRawBody = require('raw-body'); 

const SHOPIFY_API_SECRET_KEY = process.env.SHOPIFY_API_SECRET_KEY;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const MAYA_MOBILE_API_KEY = process.env.MAYA_MOBILE_API_KEY;
const MAYA_MOBILE_API_SECRET = process.env.MAYA_MOBILE_API_SECRET;
const MAYA_MOBILE_BASE_URL = process.env.MAYA_MOBILE_BASE_URL;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }
  try {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    if (!hmacHeader) {
      return res.status(401).send('Unauthorized');
    }
    const rawBody = await getRawBody(req);
    const digest = crypto
      .createHmac('sha256', SHOPIFY_API_SECRET_KEY)
      .update(rawBody)
      .digest('base64');
    if (digest !== hmacHeader) {
      return res.status(401).send('Unauthorized');
    }
    const order = JSON.parse(rawBody.toString('utf8'));
    console.log(`✅ Received paid order #${order.id}`);
    const esimLineItem = order.line_items.find(item =>
      item.properties?.some(prop => prop.name === 'maya.maya_product_id' && prop.value)
    );
    const esimFulfillmentOrder = order.fulfillment_orders.find(fo =>
      fo.line_items.some(li => li.id === esimLineItem.id)
    );
    if (!esimLineItem || !esimFulfillmentOrder) {
      return res.status(200).send('No eSIM product found. Skipping.');
    }
    const mayaSku = esimLineItem.properties.find(
      prop => prop.name === 'maya.maya_product_id'
    ).value;
    const mayaResponse = await axios.post(
      `${MAYA_MOBILE_BASE_URL}/connectivity/v1/esim`, 
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