/**
 * Blackhawk Creek Outfitters — Clover POS Sync Server
 *
 * This server acts as a secure middleman between your website and Clover's API.
 * It keeps your API token safe on the server and serves synced product data
 * to your frontend website.
 *
 * Endpoints:
 *   GET  /api/products        → Returns cached product data (for your website)
 *   POST /api/sync            → Pulls fresh data from Clover (admin action)
 *   GET  /api/sync-status     → Check when products were last synced
 *   GET  /                    → Serves your website
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ──────────────────────────────────────────────
const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
const API_TOKEN = process.env.CLOVER_API_TOKEN;
const ENVIRONMENT = process.env.CLOVER_ENVIRONMENT || 'sandbox';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const PORT = process.env.PORT || 3000;

const BASE_URL = ENVIRONMENT === 'production'
  ? 'https://api.clover.com'
  : 'https://sandbox.dev.clover.com';

// Cached product data file
const DATA_FILE = path.join(__dirname, 'data', 'products.json');

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// ─── Clover API Helper ──────────────────────────────────
async function cloverFetch(endpoint) {
  const url = `${BASE_URL}/v3/merchants/${MERCHANT_ID}${endpoint}`;
  console.log(`  ↳ Fetching: ${url}`);

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Clover API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

// ─── Map Clover categories to website sections ──────────
function mapCategory(cloverCategory) {
  if (!cloverCategory) return 'general';

  const name = cloverCategory.name.toLowerCase();

  // Map your Clover categories to website sections
  const categoryMap = {
    // Fishing
    'rods': 'fishing', 'reels': 'fishing', 'fishing': 'fishing',
    'tackle': 'fishing', 'lures': 'fishing', 'bait': 'fishing',
    'fly fishing': 'fishing', 'line': 'fishing', 'fish finder': 'fishing',

    // Hunting
    'hunting': 'hunting', 'blinds': 'hunting', 'decoys': 'hunting',
    'calls': 'hunting', 'tree stands': 'hunting', 'game': 'hunting',

    // Firearms
    'firearms': 'firearms', 'guns': 'firearms', 'rifles': 'firearms',
    'shotguns': 'firearms', 'handguns': 'firearms', 'ammo': 'firearms',
    'ammunition': 'firearms',

    // Apparel
    'apparel': 'apparel', 'clothing': 'apparel', 'boots': 'apparel',
    'waders': 'apparel', 'jackets': 'apparel', 'camo': 'apparel',

    // Optics
    'optics': 'optics', 'scopes': 'optics', 'binoculars': 'optics',
    'rangefinder': 'optics',

    // Archery
    'archery': 'archery', 'bows': 'archery', 'arrows': 'archery',
    'crossbow': 'archery',
  };

  for (const [keyword, category] of Object.entries(categoryMap)) {
    if (name.includes(keyword)) return category;
  }

  return 'general';
}

// ─── Choose an emoji icon based on category ─────────────
function getCategoryIcon(category) {
  const icons = {
    fishing: '&#127907;',
    hunting: '&#127939;',
    firearms: '&#128299;',
    apparel: '&#129509;',
    optics: '&#128269;',
    archery: '&#127993;',
    general: '&#127967;'
  };
  return icons[category] || icons.general;
}

// ─── Sync products from Clover ──────────────────────────
async function syncFromClover() {
  console.log('\n🔄 Starting Clover sync...');
  const startTime = Date.now();

  // 1. Fetch all categories
  console.log('📂 Fetching categories...');
  const categoriesData = await cloverFetch('/categories?limit=100');
  const categoriesMap = {};
  if (categoriesData.elements) {
    for (const cat of categoriesData.elements) {
      categoriesMap[cat.id] = cat;
    }
  }
  console.log(`   Found ${Object.keys(categoriesMap).length} categories`);

  // 2. Fetch all items with their category associations
  console.log('📦 Fetching items...');
  const itemsData = await cloverFetch('/items?expand=categories,tags,modifierGroups&limit=500');

  if (!itemsData.elements || itemsData.elements.length === 0) {
    console.log('   ⚠️  No items found in Clover inventory');
    return { products: {}, syncedAt: new Date().toISOString(), itemCount: 0 };
  }

  console.log(`   Found ${itemsData.elements.length} items`);

  // 3. Transform Clover items into website product format
  const products = {};
  let idCounter = 1;

  for (const item of itemsData.elements) {
    // Skip hidden/deleted items
    if (item.hidden || item.isDeleted) continue;

    // Determine category from Clover's category assignment
    let websiteCategory = 'general';
    let cloverCategoryName = '';
    if (item.categories && item.categories.elements && item.categories.elements.length > 0) {
      const firstCategory = item.categories.elements[0];
      cloverCategoryName = firstCategory.name || '';
      websiteCategory = mapCategory(firstCategory);
    }

    // Convert Clover price (in cents) to dollars
    const priceInDollars = item.price ? item.price / 100 : 0;

    // Build the product object
    const product = {
      id: idCounter++,
      cloverId: item.id,
      name: item.name,
      brand: extractBrand(item.name) || 'Blackhawk Creek',
      price: priceInDollars,
      original: null,         // Set manually or via Clover tags for sale items
      rating: 4.5,            // Default rating — can be enhanced later
      reviews: 0,
      badge: item.tags?.elements?.some(t => t.name?.toLowerCase() === 'sale') ? 'sale'
           : item.tags?.elements?.some(t => t.name?.toLowerCase() === 'new') ? 'new'
           : null,
      icon: getCategoryIcon(websiteCategory),
      desc: item.description || `${item.name} — available at Blackhawk Creek Outfitters.`,
      sku: item.sku || '',
      inStock: !item.stockCount || item.stockCount > 0,
      stockCount: item.stockCount || null,
      cloverCategory: cloverCategoryName,
    };

    // Check for sale price via alternate name or tags
    if (item.alternateName && item.alternateName.match(/^\d+\.?\d*$/)) {
      product.original = priceInDollars;
      product.price = parseFloat(item.alternateName);
    }

    // Group into website category
    if (!products[websiteCategory]) products[websiteCategory] = [];
    products[websiteCategory].push(product);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalItems = Object.values(products).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`✅ Sync complete in ${elapsed}s — ${totalItems} products across ${Object.keys(products).length} categories\n`);

  const result = {
    products,
    syncedAt: new Date().toISOString(),
    itemCount: totalItems,
    categories: Object.keys(products).map(key => ({
      key,
      name: key.charAt(0).toUpperCase() + key.slice(1),
      count: products[key].length
    }))
  };

  // Save to disk for persistence
  fs.writeFileSync(DATA_FILE, JSON.stringify(result, null, 2));

  return result;
}

// ─── Try to extract brand from product name ─────────────
function extractBrand(name) {
  // Common outdoor brands to look for at the start of product names
  const brands = [
    'Shimano', 'Abu Garcia', 'Rapala', 'Daiwa', "Lew's", 'KastKing', 'Garmin',
    'Remington', 'Savage Arms', 'Mossy Oak', 'Muddy', 'Vortex', 'Primos',
    'Smith & Wesson', 'Benelli', 'Mossberg', 'Browning', 'Winchester',
    'Sitka', 'Under Armour', 'Frogg Toggs', 'Leupold', 'Swarovski',
    'Federal', 'Hornady', 'HSS', 'Red Wing', 'Mathews', 'Hoyt', 'Bear',
    'PSE', 'Berkley', 'Strike King', 'Yo-Zuri', 'Storm', 'Mepps',
  ];

  for (const brand of brands) {
    if (name.toLowerCase().startsWith(brand.toLowerCase())) {
      return brand;
    }
  }
  return null;
}

// ─── API Routes ─────────────────────────────────────────

// Clover webhook verification & callback endpoint
// Clover sends a GET to verify the URL exists, and POSTs when events happen
app.get('/webhook', (req, res) => {
  console.log('✅ Clover webhook verification received');
  res.status(200).send('OK');
});

app.post('/webhook', (req, res) => {
  console.log('📨 Clover webhook event received:', JSON.stringify(req.body));
  // You could trigger an auto-sync here in the future
  res.status(200).send('OK');
});

// GET /api/products — Returns cached product data for the website
app.get('/api/products', (req, res) => {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      res.json(data);
    } else {
      res.json({ products: {}, syncedAt: null, itemCount: 0, message: 'No data yet. Run a sync first.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to read product data', details: err.message });
  }
});

// POST /api/sync — Pull fresh data from Clover (password protected)
app.post('/api/sync', async (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  if (!MERCHANT_ID || !API_TOKEN || MERCHANT_ID === 'YOUR_MERCHANT_ID_HERE') {
    return res.status(400).json({
      error: 'Clover credentials not configured',
      help: 'Copy .env.example to .env and add your Merchant ID and API Token'
    });
  }

  try {
    const result = await syncFromClover();
    res.json({
      success: true,
      message: `Synced ${result.itemCount} products from Clover`,
      syncedAt: result.syncedAt,
      categories: result.categories
    });
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    res.status(500).json({ error: 'Sync failed', details: err.message });
  }
});

// GET /api/sync-status — Check last sync time
app.get('/api/sync-status', (req, res) => {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      res.json({
        lastSync: data.syncedAt,
        itemCount: data.itemCount,
        categories: data.categories,
        configured: !!(MERCHANT_ID && API_TOKEN && MERCHANT_ID !== 'YOUR_MERCHANT_ID_HERE')
      });
    } else {
      res.json({
        lastSync: null,
        itemCount: 0,
        configured: !!(MERCHANT_ID && API_TOKEN && MERCHANT_ID !== 'YOUR_MERCHANT_ID_HERE')
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ───────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────────┐
  │  🏔️  Blackhawk Creek Outfitters             │
  │     Clover POS Sync Server                  │
  │                                             │
  │  Local:  http://localhost:${PORT}              │
  │  Env:    ${ENVIRONMENT.padEnd(12)}                    │
  │  Status: ${MERCHANT_ID && MERCHANT_ID !== 'YOUR_MERCHANT_ID_HERE' ? '✅ Clover configured' : '⚠️  Needs .env setup'}           │
  └─────────────────────────────────────────────┘
  `);
});
