// api/sync-products.js

const axios = require('axios');

// Shopify credentials from .env
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;

// Maya Mobile credentials from .env
const MAYA_MOBILE_API_SECRET = process.env.MAYA_MOBILE_API_SECRET;
const MAYA_MOBILE_BASE_URL = 'https://api.maya.net'; // Revised Base URL

// Main handler for the Vercel Cron Job
module.exports = async (req, res) => {
  console.log('⏰ Starting Maya Mobile product sync...');

  try {
    // 1. Fetch products from Maya Mobile API
    const mayaProductsResponse = await axios.get(
      `${MAYA_MOBILE_BASE_URL}/product/v1/products`, // Revised endpoint to match documentation
      {
        headers: {
          'X-Auth-Token': MAYA_MOBILE_API_SECRET,
        }
      }
    );

    const mayaProducts = mayaProductsResponse.data.data;
    console.log(`Found ${mayaProducts.length} Maya Mobile products.`);

    // 2. Fetch all existing eSIM products from your Shopify store
    const shopifyProductsResponse = await axios.get(
      `https://${SHOPIFY_STORE_URL}/admin/api/2024-07/products.json?product_type=eSIM`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        }
      }
    );
    const shopifyProducts = shopifyProductsResponse.data.products;

    // 3. Loop through Maya products and sync with Shopify
    for (const mayaProduct of mayaProducts) {
      // Find a matching Shopify product using the Maya SKU
      const existingShopifyProduct = shopifyProducts.find(p =>
        p.variants.some(v => v.metafields?.some(mf => mf.key === 'maya_product_id' && mf.value === mayaProduct.id))
      );

      // Create new product if it doesn't exist
      if (!existingShopifyProduct) {
        const newProductPayload = {
          product: {
            title: mayaProduct.name,
            body_html: mayaProduct.description,
            vendor: 'Maya Mobile',
            product_type: 'eSIM',
            published: true,
            variants: [
              {
                sku: `MAYA_ESIM_${mayaProduct.id}`,
                price: mayaProduct.retail_price,
                inventory_management: null,
                requires_shipping: false,
              }
            ],
            metafields: [{
              key: 'maya_product_id',
              namespace: 'maya',
              value: mayaProduct.id,
              type: 'string'
            }]
          }
        };

        await axios.post(
          `https://${SHOPIFY_STORE_URL}/admin/api/2024-07/products.json`,
          newProductPayload,
          {
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log(`✨ Created new Shopify product for Maya SKU: ${mayaProduct.id}`);
      } else {
        console.log(`ℹ️ Shopify product for SKU ${mayaProduct.id} already exists. Skipping.`);
      }
    }

    console.log('✅ Product sync finished successfully.');
    res.status(200).send('Product sync completed.');
  } catch (error) {
    console.error(
      `❌ Product sync failed:`,
      error.response?.data || error.message
    );
    res.status(500).send('Product sync failed.');
  }
};