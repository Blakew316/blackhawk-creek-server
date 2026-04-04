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
