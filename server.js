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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Serve uploaded images
const IMAGES_DIR = path.join(__dirname, 'data', 'images');
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}
app.use('/images', express.static(IMAGES_DIR));

// ─── Config ──────────────────────────────────────────────
const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
const API_TOKEN = process.env.CLOVER_API_TOKEN;
const ENVIRONMENT = process.env.CLOVER_ENVIRONMENT || 'sandbox';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const PORT = process.env.PORT || 3000;

// Clover Ecommerce Payment Keys
const CLOVER_ECOM_PRIVATE_KEY = process.env.CLOVER_ECOM_PRIVATE_KEY;
const CLOVER_ECOM_PUBLIC_KEY = process.env.CLOVER_ECOM_PUBLIC_KEY;

const BASE_URL = ENVIRONMENT === 'production'
  ? 'https://api.clover.com'
  : 'https://sandbox.dev.clover.com';

const ECOM_BASE_URL = ENVIRONMENT === 'production'
  ? 'https://scl.clover.com'
  : 'https://scl-sandbox.dev.clover.com';

// Cached product data file
const DATA_FILE = path.join(__dirname, 'data', 'products.json');
const SALES_FILE = path.join(__dirname, 'data', 'sales.json');

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

// ─── Use Clover's actual category names as website sections ──────────
// Converts "Fishing Rods & Reels" → "fishing-rods-reels" (URL-safe key)
// and keeps the original display name
function categoryToKey(name) {
  return name.toLowerCase()
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Choose an emoji icon based on category keywords ─────────────
function getCategoryIcon(categoryName) {
  const name = categoryName.toLowerCase();
  const iconMap = [
    [['fish', 'rod', 'reel', 'tackle', 'lure', 'bait', 'angl'], '&#127907;'],
    [['hunt', 'blind', 'decoy', 'call', 'tree stand', 'game', 'deer', 'duck', 'turkey'], '&#127939;'],
    [['gun', 'firearm', 'rifle', 'shotgun', 'handgun', 'pistol', 'ammo', 'ammunition'], '&#128299;'],
    [['apparel', 'cloth', 'boot', 'wader', 'jacket', 'camo', 'shirt', 'pant', 'hat', 'glove', 'vest', 'wear'], '&#129509;'],
    [['optic', 'scope', 'binocular', 'rangefind', 'sight', 'monocular'], '&#128269;'],
    [['archer', 'bow', 'arrow', 'crossbow', 'quiver', 'broadhead'], '&#127993;'],
    [['boat', 'kayak', 'canoe', 'marine', 'paddle'], '&#128674;'],
    [['camp', 'tent', 'sleep', 'cook', 'lantern', 'stove'], '&#9978;'],
    [['knife', 'knives', 'tool', 'multi-tool', 'axe', 'hatchet'], '&#128296;'],
    [['electronic', 'gps', 'finder', 'radio', 'camera', 'trail cam'], '&#128225;'],
    [['dog', 'pet', 'collar', 'kennel'], '&#128054;'],
    [['food', 'snack', 'jerky', 'drink', 'cooler'], '&#127860;'],
  ];
  for (const [keywords, icon] of iconMap) {
    if (keywords.some(k => name.includes(k))) return icon;
  }
  return '&#127967;';
}

// ─── Pick a gradient background for category cards ──────
function getCategoryGradient(categoryName) {
  const name = categoryName.toLowerCase();
  const gradientMap = [
    [['fish', 'rod', 'reel', 'tackle', 'lure', 'bait'], ['#1a3a2a', '#0d1f15']],
    [['hunt', 'blind', 'decoy', 'deer', 'duck', 'turkey'], ['#3a2a1a', '#1f150d']],
    [['gun', 'firearm', 'rifle', 'shotgun', 'ammo'], ['#2a2a2a', '#151515']],
    [['apparel', 'cloth', 'boot', 'wear', 'camo'], ['#2a331a', '#15190d']],
    [['optic', 'scope', 'binocular'], ['#1a2a3a', '#0d151f']],
    [['archer', 'bow', 'arrow', 'crossbow'], ['#3a1a2a', '#1f0d15']],
    [['boat', 'kayak', 'marine'], ['#1a2a3a', '#0d1520']],
    [['camp', 'tent', 'outdoor'], ['#2a3320', '#151a0d']],
    [['knife', 'tool'], ['#33291a', '#1a150d']],
  ];
  for (const [keywords, colors] of gradientMap) {
    if (keywords.some(k => name.includes(k))) return colors;
  }
  return ['#2a2a2a', '#151515'];
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

  // Debug: log first 3 items' raw price data from Clover
  for (let i = 0; i < Math.min(3, itemsData.elements.length); i++) {
    const dbgItem = itemsData.elements[i];
    console.log(`   🔍 Item "${dbgItem.name}" — raw price: ${dbgItem.price} cents ($${dbgItem.price ? (dbgItem.price / 100).toFixed(2) : '0.00'}), priceType: ${dbgItem.priceType || 'not set'}`);
  }

  // 3. Merge Clover items with existing data (preserving manual edits and manual products)
  let existingData = { products: {}, categoryMeta: {} };
  let maxExistingId = 0;
  const existingByClover = {};   // cloverId → { categoryKey, item }
  const existingBySku = {};      // sku → { categoryKey, item }

  if (fs.existsSync(DATA_FILE)) {
    try {
      existingData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // Build lookup maps of existing products
      for (const [catKey, items] of Object.entries(existingData.products || {})) {
        for (const p of items) {
          if (p.id > maxExistingId) maxExistingId = p.id;
          if (p.cloverId) existingByClover[p.cloverId] = { categoryKey: catKey, item: p };
          if (p.sku) existingBySku[p.sku] = { categoryKey: catKey, item: p };
        }
      }
      console.log(`   📦 Found ${Object.keys(existingByClover).length} existing Clover items, ${maxExistingId} max ID`);
    } catch(e) { /* ignore */ }
  }

  // Start with existing products (preserves manual products + edits)
  const products = JSON.parse(JSON.stringify(existingData.products || {}));
  let idCounter = maxExistingId + 1;
  let updatedCount = 0;
  let addedCount = 0;

  for (const item of itemsData.elements) {
    // Skip hidden/deleted items
    if (item.hidden || item.isDeleted) continue;

    // Use Clover's actual category names directly
    let categoryKey = 'general';
    let categoryDisplayName = 'General';
    if (item.categories && item.categories.elements && item.categories.elements.length > 0) {
      const firstCategory = item.categories.elements[0];
      categoryDisplayName = firstCategory.name || 'General';
      categoryKey = categoryToKey(categoryDisplayName);
    }

    // Convert Clover price (in cents) to dollars
    const priceInDollars = item.price ? item.price / 100 : 0;

    // Check for sale price via alternate name
    let salePrice = null;
    if (item.alternateName && item.alternateName.match(/^\d+\.?\d*$/)) {
      salePrice = parseFloat(item.alternateName);
    }

    // Check if this item already exists (match by cloverId first, then SKU)
    const existingMatch = existingByClover[item.id] || (item.sku ? existingBySku[item.sku] : null);

    if (existingMatch) {
      // UPDATE existing item — only update Clover-sourced fields, preserve manual edits
      const existing = existingMatch.item;
      const oldCatKey = existingMatch.categoryKey;

      // Update fields from Clover (these are Clover's source of truth)
      existing.cloverId = item.id;
      existing.name = item.name;
      existing.sku = item.sku || existing.sku;
      existing.price = salePrice || priceInDollars;
      existing.original = salePrice ? priceInDollars : null;
      existing.inStock = !item.stockCount || item.stockCount > 0;
      existing.stockCount = item.stockCount || existing.stockCount;
      existing.desc = item.description || existing.desc;
      existing.badge = item.tags?.elements?.some(t => t.name?.toLowerCase() === 'sale') ? 'sale'
           : item.tags?.elements?.some(t => t.name?.toLowerCase() === 'new') ? 'new'
           : existing.badge;
      // Preserve imageUrl — don't overwrite manual uploads
      // Preserve brand if manually edited (only set if currently default)
      const cloverBrand = extractBrand(item.name);
      if (cloverBrand && (!existing.brand || existing.brand === 'Blackhawk Creek')) {
        existing.brand = cloverBrand;
      }

      // Handle category change from Clover
      if (categoryKey !== oldCatKey) {
        // Move to new category
        products[oldCatKey] = (products[oldCatKey] || []).filter(p => p.id !== existing.id);
        if (products[oldCatKey] && products[oldCatKey].length === 0) delete products[oldCatKey];
        existing.cloverCategory = categoryDisplayName;
        existing.icon = getCategoryIcon(categoryDisplayName);
        if (!products[categoryKey]) products[categoryKey] = [];
        products[categoryKey].push(existing);
      } else {
        existing.cloverCategory = categoryDisplayName;
      }

      updatedCount++;
    } else {
      // NEW item from Clover — add it
      const product = {
        id: idCounter++,
        cloverId: item.id,
        name: item.name,
        brand: extractBrand(item.name) || 'Blackhawk Creek',
        price: salePrice || priceInDollars,
        original: salePrice ? priceInDollars : null,
        rating: 4.5,
        reviews: 0,
        badge: item.tags?.elements?.some(t => t.name?.toLowerCase() === 'sale') ? 'sale'
             : item.tags?.elements?.some(t => t.name?.toLowerCase() === 'new') ? 'new'
             : null,
        icon: getCategoryIcon(categoryDisplayName),
        desc: item.description || `${item.name} — available at Blackhawk Creek Outfitters.`,
        sku: item.sku || '',
        inStock: !item.stockCount || item.stockCount > 0,
        stockCount: item.stockCount || null,
        cloverCategory: categoryDisplayName,
        imageUrl: null,
      };

      if (!products[categoryKey]) products[categoryKey] = [];
      products[categoryKey].push(product);
      addedCount++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalItems = Object.values(products).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`✅ Sync complete in ${elapsed}s — ${totalItems} products (${addedCount} new, ${updatedCount} updated) across ${Object.keys(products).length} categories\n`);

  // Build category metadata with icons and gradients for the website
  const categoryMeta = {};
  for (const [key, items] of Object.entries(products)) {
    const displayName = items[0]?.cloverCategory || key;
    const gradient = getCategoryGradient(displayName);
    categoryMeta[key] = {
      key,
      name: displayName,
      count: items.length,
      icon: getCategoryIcon(displayName),
      gradient: gradient
    };
  }

  const result = {
    products,
    syncedAt: new Date().toISOString(),
    itemCount: totalItems,
    categoryMeta,
    categories: Object.values(categoryMeta)
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

// ─── Helper: Load & Save product data ───────────────────
function loadProductData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return { products: {}, syncedAt: null, itemCount: 0, categoryMeta: {}, categories: [] };
}

function saveProductData(data) {
  // Recalculate counts
  data.itemCount = Object.values(data.products).reduce((sum, arr) => sum + arr.length, 0);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── GET /api/products/flat — Returns a flat array for the frontend ────
app.get('/api/products/flat', (req, res) => {
  try {
    const data = loadProductData();
    const flat = [];
    for (const [categoryKey, items] of Object.entries(data.products)) {
      const catMeta = data.categoryMeta?.[categoryKey];
      const categoryName = catMeta?.name || categoryKey;
      for (const item of items) {
        flat.push({ ...item, category: categoryName });
      }
    }
    res.json(flat);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/products/:id/image — Upload a product image ─────────
app.post('/api/products/:id/image', (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    const data = loadProductData();
    let found = false;

    // If it's a base64 data URL, save as a file
    let savedUrl = imageUrl;
    if (imageUrl.startsWith('data:image')) {
      const matches = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (matches) {
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `product-${productId}-${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);
        savedUrl = `/images/${filename}`;
      }
    }

    for (const categoryKey of Object.keys(data.products)) {
      for (const item of data.products[categoryKey]) {
        if (item.id === productId) {
          item.imageUrl = savedUrl;
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      return res.status(404).json({ error: 'Product not found' });
    }

    saveProductData(data);
    res.json({ success: true, imageUrl: savedUrl });
  } catch (err) {
    console.error('Image upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/products — Add a new product ────────────────────────
app.post('/api/products', (req, res) => {
  try {
    const { name, brand, category, price, stock, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Product name is required' });

    const data = loadProductData();

    // Find the highest existing ID
    let maxId = 0;
    for (const items of Object.values(data.products)) {
      for (const item of items) {
        if (item.id > maxId) maxId = item.id;
      }
    }

    const categoryKey = category ? categoryToKey(category) : 'general';
    const categoryName = category || 'General';

    const newProduct = {
      id: maxId + 1,
      cloverId: null,
      name,
      brand: brand || 'Blackhawk Creek',
      price: parseFloat(price) || 0,
      original: null,
      rating: 0,
      reviews: 0,
      badge: null,
      icon: getCategoryIcon(categoryName),
      desc: description || `${name} — available at Blackhawk Creek Outfitters.`,
      sku: '',
      inStock: true,
      stockCount: parseInt(stock) || 0,
      cloverCategory: categoryName,
      imageUrl: null
    };

    if (!data.products[categoryKey]) data.products[categoryKey] = [];
    data.products[categoryKey].push(newProduct);

    // Update category metadata
    if (!data.categoryMeta) data.categoryMeta = {};
    const gradient = getCategoryGradient(categoryName);
    data.categoryMeta[categoryKey] = {
      key: categoryKey,
      name: categoryName,
      count: data.products[categoryKey].length,
      icon: getCategoryIcon(categoryName),
      gradient
    };
    data.categories = Object.values(data.categoryMeta);

    saveProductData(data);
    res.json({ success: true, product: newProduct });
  } catch (err) {
    console.error('Add product error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/products/:id — Update a product (supports category change + image) ──
app.put('/api/products/:id', (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const updates = req.body;
    const data = loadProductData();
    let found = false;
    let foundItem = null;
    let oldCategoryKey = null;

    // Find the product
    for (const categoryKey of Object.keys(data.products)) {
      for (const item of data.products[categoryKey]) {
        if (item.id === productId) {
          foundItem = item;
          oldCategoryKey = categoryKey;
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found || !foundItem) return res.status(404).json({ error: 'Product not found' });

    // Apply basic field updates
    if (updates.name !== undefined) foundItem.name = updates.name;
    if (updates.brand !== undefined) foundItem.brand = updates.brand;
    if (updates.price !== undefined) foundItem.price = parseFloat(updates.price);
    if (updates.stock !== undefined) foundItem.stockCount = parseInt(updates.stock);
    if (updates.description !== undefined) foundItem.desc = updates.description;

    // Handle image (base64 or URL)
    if (updates.imageUrl !== undefined) {
      let savedUrl = updates.imageUrl;
      if (updates.imageUrl && updates.imageUrl.startsWith('data:image')) {
        const matches = updates.imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
          const buffer = Buffer.from(matches[2], 'base64');
          const filename = `product-${productId}-${Date.now()}.${ext}`;
          fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);
          savedUrl = `/images/${filename}`;
        }
      }
      foundItem.imageUrl = savedUrl;
    }

    // Handle category change — move product between category arrays
    if (updates.category !== undefined && updates.category) {
      const newCategoryKey = categoryToKey(updates.category);
      const newCategoryName = updates.category;

      if (newCategoryKey !== oldCategoryKey) {
        // Remove from old category
        data.products[oldCategoryKey] = data.products[oldCategoryKey].filter(p => p.id !== productId);
        if (data.products[oldCategoryKey].length === 0) {
          delete data.products[oldCategoryKey];
          if (data.categoryMeta) delete data.categoryMeta[oldCategoryKey];
        }

        // Add to new category
        if (!data.products[newCategoryKey]) data.products[newCategoryKey] = [];
        foundItem.cloverCategory = newCategoryName;
        foundItem.icon = getCategoryIcon(newCategoryName);
        data.products[newCategoryKey].push(foundItem);

        // Update category metadata
        if (!data.categoryMeta) data.categoryMeta = {};
        const gradient = getCategoryGradient(newCategoryName);
        data.categoryMeta[newCategoryKey] = {
          key: newCategoryKey,
          name: newCategoryName,
          count: data.products[newCategoryKey].length,
          icon: getCategoryIcon(newCategoryName),
          gradient
        };
      } else {
        // Same category key but maybe different display name
        foundItem.cloverCategory = newCategoryName;
      }
    }

    // Refresh all category metadata counts
    if (data.categoryMeta) {
      for (const [key, items] of Object.entries(data.products)) {
        if (data.categoryMeta[key]) {
          data.categoryMeta[key].count = items.length;
        }
      }
      data.categories = Object.values(data.categoryMeta);
    }

    saveProductData(data);
    res.json({ success: true, product: foundItem });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/products/export — Export all products as JSON ───────────
app.get('/api/products/export', (req, res) => {
  try {
    const data = loadProductData();
    const flat = [];
    for (const [categoryKey, items] of Object.entries(data.products)) {
      const catMeta = data.categoryMeta?.[categoryKey];
      const categoryName = catMeta?.name || categoryKey;
      for (const item of items) {
        flat.push({
          id: item.id,
          cloverId: item.cloverId || '',
          name: item.name,
          brand: item.brand || '',
          category: categoryName,
          price: item.price || 0,
          stockCount: item.stockCount || 0,
          sku: item.sku || '',
          description: item.desc || '',
          imageUrl: item.imageUrl || '',
          inStock: item.inStock !== false
        });
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="blackhawk-creek-products.json"');
    res.json(flat);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/products/export/csv — Export all products as CSV ───────
app.get('/api/products/export/csv', (req, res) => {
  try {
    const data = loadProductData();
    const rows = [['ID','Clover ID','Name','Brand','Category','Price','Stock','SKU','Description','Image URL','In Stock']];
    for (const [categoryKey, items] of Object.entries(data.products)) {
      const catMeta = data.categoryMeta?.[categoryKey];
      const categoryName = catMeta?.name || categoryKey;
      for (const item of items) {
        rows.push([
          item.id,
          item.cloverId || '',
          `"${(item.name || '').replace(/"/g, '""')}"`,
          `"${(item.brand || '').replace(/"/g, '""')}"`,
          `"${categoryName.replace(/"/g, '""')}"`,
          item.price || 0,
          item.stockCount || 0,
          item.sku || '',
          `"${(item.desc || '').replace(/"/g, '""')}"`,
          item.imageUrl || '',
          item.inStock !== false ? 'Yes' : 'No'
        ]);
      }
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="blackhawk-creek-products.csv"');
    res.send(rows.map(r => r.join(',')).join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/products/:id — Remove a product ────────────────────
app.delete('/api/products/:id', (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const data = loadProductData();
    let found = false;

    for (const categoryKey of Object.keys(data.products)) {
      const index = data.products[categoryKey].findIndex(p => p.id === productId);
      if (index !== -1) {
        data.products[categoryKey].splice(index, 1);
        // Remove empty categories
        if (data.products[categoryKey].length === 0) {
          delete data.products[categoryKey];
          if (data.categoryMeta) delete data.categoryMeta[categoryKey];
          data.categories = Object.values(data.categoryMeta || {});
        }
        found = true;
        break;
      }
    }

    if (!found) return res.status(404).json({ error: 'Product not found' });

    saveProductData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Clover Ecommerce: Get public key for frontend ─────────
app.get('/api/checkout/config', (req, res) => {
  res.json({
    publicKey: CLOVER_ECOM_PUBLIC_KEY || '',
    merchantId: MERCHANT_ID || '',
    environment: ENVIRONMENT
  });
});

// ─── Clover Ecommerce: Process a payment ────────────────────
app.post('/api/checkout', async (req, res) => {
  try {
    const { token, amount, items, shipping, billing, email } = req.body;

    if (!token) return res.status(400).json({ error: 'Payment token is required' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!CLOVER_ECOM_PRIVATE_KEY) return res.status(500).json({ error: 'Payment processing not configured' });

    const amountInCents = Math.round(amount * 100);
    const taxRate = 0.0825; // Texas 8.25%
    const taxInCents = Math.round(amountInCents * taxRate);
    const totalInCents = amountInCents + taxInCents;

    // Create charge via Clover Ecommerce API
    const chargePayload = {
      amount: totalInCents,
      currency: 'usd',
      source: token,
      description: 'Blackhawk Creek Outfitters — Online Order',
      receipt_email: email || undefined,
      metadata: {
        shipping_name: shipping ? `${shipping.firstName} ${shipping.lastName}` : '',
        shipping_address: shipping ? `${shipping.address}, ${shipping.city}, ${shipping.state} ${shipping.zip}` : ''
      }
    };

    console.log('💳 Processing Clover payment — $' + (totalInCents / 100).toFixed(2));

    const chargeResponse = await fetch(`${ECOM_BASE_URL}/v1/charges`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOVER_ECOM_PRIVATE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(chargePayload)
    });

    const chargeData = await chargeResponse.json();

    if (!chargeResponse.ok) {
      console.error('❌ Clover charge failed:', chargeData);
      const errorMsg = chargeData.error?.message || chargeData.message || 'Payment was declined';
      return res.status(400).json({ error: errorMsg });
    }

    console.log('✅ Payment successful — Charge ID:', chargeData.id);

    // Record the sale in our system
    const salesData = loadSalesData();
    const productData = loadProductData();

    const subtotal = amount;
    const tax = Math.round(amount * taxRate * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;

    const order = {
      id: salesData.nextOrderId++,
      cloverChargeId: chargeData.id,
      timestamp: new Date().toISOString(),
      items: (items || []).map(i => ({
        productId: i.id,
        name: i.name,
        brand: i.brand || '',
        category: i.category || '',
        sku: i.sku || '',
        price: i.price,
        quantity: i.quantity,
        lineTotal: i.price * i.quantity
      })),
      subtotal,
      discount: 0,
      tax,
      total,
      paymentMethod: 'card',
      cardLast4: chargeData.source?.last4 || '',
      cardBrand: chargeData.source?.brand || '',
      customerName: shipping ? `${shipping.firstName} ${shipping.lastName}` : '',
      customerEmail: email || '',
      shippingAddress: shipping || null,
      billingAddress: billing || null,
      itemCount: (items || []).reduce((s, i) => s + i.quantity, 0),
      status: 'completed',
      source: 'online'
    };

    salesData.orders.push(order);
    saveSalesData(salesData);

    // Update stock counts
    for (const orderItem of order.items) {
      if (orderItem.productId) {
        for (const catItems of Object.values(productData.products)) {
          const prod = catItems.find(p => p.id === orderItem.productId);
          if (prod && prod.stockCount !== null && prod.stockCount !== undefined) {
            prod.stockCount = Math.max(0, prod.stockCount - orderItem.quantity);
            prod.inStock = prod.stockCount > 0;
          }
        }
      }
    }
    saveProductData(productData);

    // ─── Sync order to Clover POS as a paid order ───
    let cloverOrderId = null;
    try {
      cloverOrderId = await syncOrderToClover(order, productData);
      if (cloverOrderId) {
        order.cloverOrderId = cloverOrderId;
        saveSalesData(salesData);
        console.log('✅ Order synced to Clover — Order ID:', cloverOrderId);
      }
    } catch (syncErr) {
      // Don't fail the customer checkout if Clover sync fails
      console.error('⚠️ Clover order sync failed (non-blocking):', syncErr.message);
    }

    res.json({
      success: true,
      orderId: order.id,
      chargeId: chargeData.id,
      cloverOrderId: cloverOrderId || null,
      total: order.total,
      last4: order.cardLast4,
      brand: order.cardBrand
    });

  } catch (err) {
    console.error('❌ Checkout error:', err.message);
    res.status(500).json({ error: 'Payment processing failed. Please try again.' });
  }
});

// ─── Sync Online Order to Clover POS ─────────────────────────
async function syncOrderToClover(order, productData) {
  if (!MERCHANT_ID || !API_TOKEN) {
    console.log('⚠️ Clover POS credentials not set — skipping order sync');
    return null;
  }

  const cloverAPI = `${BASE_URL}/v3/merchants/${MERCHANT_ID}`;
  const headers = {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json'
  };

  // 1. Create the order
  const createOrderRes = await fetch(`${cloverAPI}/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      state: 'locked',
      title: `Online Order #${order.id}`,
      note: `Website order — ${order.customerName || 'Guest'} (${order.customerEmail || 'no email'})`,
      orderType: { id: 'online' }
    })
  });

  if (!createOrderRes.ok) {
    const errText = await createOrderRes.text();
    throw new Error(`Create order failed: ${createOrderRes.status} ${errText}`);
  }

  const cloverOrder = await createOrderRes.json();
  const cloverOrderId = cloverOrder.id;

  // 2. Add line items to the order
  for (const item of order.items) {
    // Try to find the Clover inventory item ID
    let cloverItemId = null;
    for (const catItems of Object.values(productData.products)) {
      const prod = catItems.find(p => p.id === item.productId);
      if (prod && prod.cloverId) {
        cloverItemId = prod.cloverId;
        break;
      }
    }

    if (cloverItemId) {
      // Add the existing Clover inventory item
      await fetch(`${cloverAPI}/orders/${cloverOrderId}/line_items`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          item: { id: cloverItemId },
          unitQty: item.quantity
        })
      });
    } else {
      // Create a custom line item (for products not synced from Clover)
      await fetch(`${cloverAPI}/orders/${cloverOrderId}/line_items`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: item.name,
          price: Math.round(item.price * 100),
          unitQty: item.quantity
        })
      });
    }
  }

  // 3. Apply the tax
  if (order.tax > 0) {
    const taxInCents = Math.round(order.tax * 100);
    // Add manually-applied tax
    await fetch(`${cloverAPI}/orders/${cloverOrderId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        manualTransaction: true,
        total: Math.round(order.total * 100)
      })
    });
  }

  // 4. Record payment against the order so it shows as PAID
  const paymentPayload = {
    order: { id: cloverOrderId },
    amount: Math.round(order.total * 100),
    taxAmount: Math.round(order.tax * 100),
    result: 'SUCCESS',
    externalPaymentId: order.cloverChargeId || `web-${order.id}-${Date.now()}`,
    note: 'Paid online via Clover Ecommerce',
    tender: {
      labelKey: 'com.clover.tender.credit_card',
      label: 'Credit Card',
      opensCashDrawer: false
    },
    cardTransaction: {
      last4: order.cardLast4 || '0000',
      cardType: (order.cardBrand || 'VISA').toUpperCase(),
      type: 'AUTH_CAPTURE',
      state: 'CLOSED',
      referenceId: order.cloverChargeId || ''
    }
  };

  const paymentRes = await fetch(`${cloverAPI}/orders/${cloverOrderId}/payments`, {
    method: 'POST',
    headers,
    body: JSON.stringify(paymentPayload)
  });

  if (!paymentRes.ok) {
    const errText = await paymentRes.text();
    console.warn('⚠️ Payment sync partial — order created but payment record failed:', paymentRes.status, errText);
  }

  return cloverOrderId;
}

// ─── Sales Data Helpers ────────────────────────────────────
function loadSalesData() {
  if (fs.existsSync(SALES_FILE)) {
    return JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'));
  }
  return { orders: [], nextOrderId: 1001 };
}

function saveSalesData(data) {
  fs.writeFileSync(SALES_FILE, JSON.stringify(data, null, 2));
}

// ─── POST /api/sales — Record a new sale/order ────────────────────────
app.post('/api/sales', (req, res) => {
  try {
    const { items, paymentMethod, customerName, discount, tax } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Order must contain at least one item' });
    }

    const salesData = loadSalesData();
    const productData = loadProductData();

    const subtotal = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    const discountAmt = parseFloat(discount) || 0;
    const taxAmt = parseFloat(tax) || (subtotal * 0.0825); // Default 8.25% TX sales tax
    const total = subtotal - discountAmt + taxAmt;

    const order = {
      id: salesData.nextOrderId++,
      timestamp: new Date().toISOString(),
      items: items.map(i => ({
        productId: i.id,
        name: i.name,
        brand: i.brand || '',
        category: i.category || '',
        sku: i.sku || '',
        price: i.price,
        quantity: i.quantity,
        lineTotal: i.price * i.quantity
      })),
      subtotal: Math.round(subtotal * 100) / 100,
      discount: Math.round(discountAmt * 100) / 100,
      tax: Math.round(taxAmt * 100) / 100,
      total: Math.round(total * 100) / 100,
      paymentMethod: paymentMethod || 'card',
      customerName: customerName || null,
      itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
      status: 'completed'
    };

    salesData.orders.push(order);
    saveSalesData(salesData);

    // Update stock counts
    for (const orderItem of order.items) {
      if (orderItem.productId) {
        for (const catItems of Object.values(productData.products)) {
          const prod = catItems.find(p => p.id === orderItem.productId);
          if (prod && prod.stockCount !== null && prod.stockCount !== undefined) {
            prod.stockCount = Math.max(0, prod.stockCount - orderItem.quantity);
            prod.inStock = prod.stockCount > 0;
          }
        }
      }
    }
    saveProductData(productData);

    res.json({ success: true, order });
  } catch (err) {
    console.error('Record sale error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sales/:id/refund — Refund an order ────────────────────
app.post('/api/sales/:id/refund', (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const salesData = loadSalesData();
    const order = salesData.orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'refunded') return res.status(400).json({ error: 'Order already refunded' });

    order.status = 'refunded';
    order.refundedAt = new Date().toISOString();
    saveSalesData(salesData);

    // Restore stock
    const productData = loadProductData();
    for (const orderItem of order.items) {
      if (orderItem.productId) {
        for (const catItems of Object.values(productData.products)) {
          const prod = catItems.find(p => p.id === orderItem.productId);
          if (prod && prod.stockCount !== null) {
            prod.stockCount += orderItem.quantity;
            prod.inStock = true;
          }
        }
      }
    }
    saveProductData(productData);

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sales — Get all sales (with optional date filters) ─────
app.get('/api/sales', (req, res) => {
  try {
    const salesData = loadSalesData();
    let orders = salesData.orders || [];

    // Date filtering
    if (req.query.from) {
      const from = new Date(req.query.from);
      orders = orders.filter(o => new Date(o.timestamp) >= from);
    }
    if (req.query.to) {
      const to = new Date(req.query.to);
      to.setHours(23, 59, 59, 999);
      orders = orders.filter(o => new Date(o.timestamp) <= to);
    }
    if (req.query.status) {
      orders = orders.filter(o => o.status === req.query.status);
    }

    res.json({ orders, total: orders.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sales/summary — Sales dashboard summary with KPIs ──────
app.get('/api/sales/summary', (req, res) => {
  try {
    const salesData = loadSalesData();
    const allOrders = salesData.orders || [];

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    function summarize(orders) {
      const completed = orders.filter(o => o.status === 'completed');
      const refunded = orders.filter(o => o.status === 'refunded');
      return {
        orderCount: completed.length,
        refundCount: refunded.length,
        grossSales: Math.round(completed.reduce((s, o) => s + o.subtotal, 0) * 100) / 100,
        netSales: Math.round(completed.reduce((s, o) => s + o.total, 0) * 100) / 100,
        totalRevenue: Math.round(completed.reduce((s, o) => s + o.total, 0) * 100) / 100,
        totalRefunds: Math.round(refunded.reduce((s, o) => s + o.total, 0) * 100) / 100,
        totalDiscount: Math.round(completed.reduce((s, o) => s + (o.discount || 0), 0) * 100) / 100,
        totalTax: Math.round(completed.reduce((s, o) => s + (o.tax || 0), 0) * 100) / 100,
        avgTicket: completed.length > 0 ? Math.round((completed.reduce((s, o) => s + o.total, 0) / completed.length) * 100) / 100 : 0,
        itemsSold: completed.reduce((s, o) => s + (o.itemCount || 0), 0)
      };
    }

    const todayOrders = allOrders.filter(o => new Date(o.timestamp) >= todayStart);
    const weekOrders = allOrders.filter(o => new Date(o.timestamp) >= weekStart);
    const monthOrders = allOrders.filter(o => new Date(o.timestamp) >= monthStart);
    const lastMonthOrders = allOrders.filter(o => new Date(o.timestamp) >= lastMonthStart && new Date(o.timestamp) <= lastMonthEnd);

    // Top selling items (all time)
    const itemSales = {};
    for (const order of allOrders.filter(o => o.status === 'completed')) {
      for (const item of order.items) {
        const key = item.name;
        if (!itemSales[key]) itemSales[key] = { name: item.name, brand: item.brand, category: item.category, quantity: 0, revenue: 0 };
        itemSales[key].quantity += item.quantity;
        itemSales[key].revenue += item.lineTotal;
      }
    }
    const topItems = Object.values(itemSales).sort((a, b) => b.revenue - a.revenue).slice(0, 20);

    // Sales by category
    const categorySales = {};
    for (const order of allOrders.filter(o => o.status === 'completed')) {
      for (const item of order.items) {
        const cat = item.category || 'Uncategorized';
        if (!categorySales[cat]) categorySales[cat] = { category: cat, quantity: 0, revenue: 0, orderCount: 0 };
        categorySales[cat].quantity += item.quantity;
        categorySales[cat].revenue += item.lineTotal;
        categorySales[cat].orderCount++;
      }
    }

    // Sales by payment method
    const paymentBreakdown = {};
    for (const order of allOrders.filter(o => o.status === 'completed')) {
      const method = order.paymentMethod || 'card';
      if (!paymentBreakdown[method]) paymentBreakdown[method] = { method, count: 0, total: 0 };
      paymentBreakdown[method].count++;
      paymentBreakdown[method].total += order.total;
    }

    // Hourly breakdown for today
    const hourlyToday = Array(24).fill(null).map((_, i) => ({ hour: i, orders: 0, revenue: 0 }));
    for (const order of todayOrders.filter(o => o.status === 'completed')) {
      const h = new Date(order.timestamp).getHours();
      hourlyToday[h].orders++;
      hourlyToday[h].revenue += order.total;
    }

    // Daily breakdown for the last 30 days
    const dailySales = [];
    for (let i = 29; i >= 0; i--) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dayEnd = new Date(day);
      dayEnd.setHours(23, 59, 59, 999);
      const dayOrders = allOrders.filter(o => {
        const d = new Date(o.timestamp);
        return d >= day && d <= dayEnd && o.status === 'completed';
      });
      dailySales.push({
        date: day.toISOString().split('T')[0],
        label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        orders: dayOrders.length,
        revenue: Math.round(dayOrders.reduce((s, o) => s + o.total, 0) * 100) / 100,
        items: dayOrders.reduce((s, o) => s + (o.itemCount || 0), 0)
      });
    }

    res.json({
      today: summarize(todayOrders),
      thisWeek: summarize(weekOrders),
      thisMonth: summarize(monthOrders),
      lastMonth: summarize(lastMonthOrders),
      allTime: summarize(allOrders),
      topItems,
      categorySales: Object.values(categorySales).sort((a, b) => b.revenue - a.revenue),
      paymentBreakdown: Object.values(paymentBreakdown),
      hourlyToday,
      dailySales,
      recentOrders: allOrders.slice(-50).reverse()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sales/export/csv — Export sales as CSV ─────────────────
app.get('/api/sales/export/csv', (req, res) => {
  try {
    const salesData = loadSalesData();
    let orders = salesData.orders || [];
    if (req.query.from) orders = orders.filter(o => new Date(o.timestamp) >= new Date(req.query.from));
    if (req.query.to) { const to = new Date(req.query.to); to.setHours(23,59,59,999); orders = orders.filter(o => new Date(o.timestamp) <= to); }

    const rows = [['Order ID','Date','Time','Items','Item Count','Subtotal','Discount','Tax','Total','Payment Method','Status','Customer']];
    for (const o of orders) {
      const d = new Date(o.timestamp);
      const itemNames = o.items.map(i => `${i.name} x${i.quantity}`).join('; ');
      rows.push([
        o.id,
        d.toLocaleDateString(),
        d.toLocaleTimeString(),
        `"${itemNames.replace(/"/g, '""')}"`,
        o.itemCount,
        o.subtotal,
        o.discount || 0,
        o.tax || 0,
        o.total,
        o.paymentMethod || 'card',
        o.status,
        o.customerName || ''
      ]);
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="blackhawk-creek-sales.csv"');
    res.send(rows.map(r => r.join(',')).join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Footer Pages ───────────────────────────────────────
const FOOTER_PAGES_FILE = path.join(__dirname, 'data', 'footer-pages.json');

function loadFooterPages() {
  try {
    if (fs.existsSync(FOOTER_PAGES_FILE)) {
      return JSON.parse(fs.readFileSync(FOOTER_PAGES_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error loading footer pages:', e.message); }
  return null;
}

function saveFooterPages(data) {
  const dir = path.dirname(FOOTER_PAGES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FOOTER_PAGES_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/footer-pages', (req, res) => {
  const data = loadFooterPages();
  if (data) {
    res.json(data);
  } else {
    res.json([]);
  }
});

app.post('/api/footer-pages', (req, res) => {
  try {
    const data = req.body;
    if (!Array.isArray(data)) {
      return res.status(400).json({ error: 'Expected an array of footer sections' });
    }
    saveFooterPages(data);
    res.json({ success: true });
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
