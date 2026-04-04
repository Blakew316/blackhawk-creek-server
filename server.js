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

// Use node-fetch for Node < 18, native fetch for Node 18+
if (!globalThis.fetch) {
  const nodeFetch = require('node-fetch');
  globalThis.fetch = nodeFetch;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Determine writable data directory
function resolveDataDir() {
  const diskPath = process.env.RENDER_DISK_PATH;
  if (diskPath) {
    try {
      if (!fs.existsSync(diskPath)) fs.mkdirSync(diskPath, { recursive: true });
      // Test write access
      const testFile = path.join(diskPath, '.write-test');
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      console.log('✅ Using persistent disk at:', diskPath);
      return diskPath;
    } catch (e) {
      console.warn('⚠️ RENDER_DISK_PATH not writable (' + diskPath + '):', e.message);
      console.warn('   Falling back to local data/ directory (ephemeral)');
    }
  }
  const localDir = path.join(__dirname, 'data');
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
  return localDir;
}

const PERSISTENT_DATA_DIR = resolveDataDir();

// Serve uploaded images
const IMAGES_DIR = path.join(PERSISTENT_DATA_DIR, 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
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

// Data files use the resolved persistent directory
const DATA_DIR = PERSISTENT_DATA_DIR;
const DATA_FILE = path.join(DATA_DIR, 'products.json');
const SALES_FILE = path.join(DATA_DIR, 'sales.json');

console.log('📁 Data directory:', DATA_DIR);
console.log('   Products file:', DATA_FILE);
console.log('   Sales file:', SALES_FILE);

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

// Auto-categorize products by name keywords (server-side version)
function autoCategorizeServer(name) {
  const n = (name || '').toLowerCase();
  if (/railworm|tapout|twitch\s?\d|fw shad|crappie dapper|tiny shad|boosa|ridge lizard|crappie strobe|strobe minnow|ribbon tail|hogwalla|nedfry|bamboosa|crappie shindo|creature|worm\s?\d|shad\s?\d|minnow\s?\d|grub|craw|tube|swimbait|soft plastic/i.test(n)) return 'Soft Plastics';
  if (/pressure series|pd\d|crankbait|jerkbait|topwater|popper|walking|rattl|quake|duke\s*\d|splashback/i.test(n)) return 'Hardbaits';
  if (/spinnerbait|spinner bait/i.test(n)) return 'Spinnerbaits';
  if (/flock blade|bladed jig|chatterbait|blade\s/i.test(n)) return 'Bladed Jigs';
  if (/swim jig/i.test(n)) return 'Swim Jigs';
  if (/frog|hush frog|vega frog|vega hush/i.test(n)) return 'Frogs';
  if (/hook|jugular|catfish hook|minnow hook|bluegill.*hook|sunfish.*hook/i.test(n)) return 'Hooks';
  if (/jighead|jig head|ned head|juggle head|panorama axle|pecos underspin|finesse minnow/i.test(n)) return 'Jigheads';
  if (/weight|sinker|split shot|worm weight|lead\s/i.test(n)) return 'Weights & Sinkers';
  if (/reel butter|reel oil|reel grease|reel care|lubricant|lubrication/i.test(n)) return 'Reel Care';
  if (/combo/i.test(n)) return 'Rod & Reel Combos';
  if (/hat|shirt|hoodie|cap|apparel|banner|sticker|decal|patch|koozie/i.test(n)) return 'Apparel & Accessories';
  if (/clean|soap|wash|d-funk|funk/i.test(n)) return 'Cleaning Products';
  return null; // Return null to use Clover's category
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

// ─── Auto-resolve product images from manufacturer Shopify stores ──────
// Fetches product catalogs from 6th Sense, Bass Assassin, and Ardent
// then matches by product name to find the correct CDN image URL
let _imageCache = null;
async function buildImageCache() {
  if (_imageCache) return _imageCache;
  console.log('🖼️  Building product image cache from manufacturer stores...');
  const cache = {};

  async function fetchShopify(storeUrl) {
    try {
      const resp = await fetch(storeUrl + '/products.json?limit=250');
      const data = await resp.json();
      const map = {};
      (data.products || []).forEach(p => {
        const title = p.title.toLowerCase();
        const img = p.images && p.images[0] ? p.images[0].src.split('?')[0] : null;
        if (img) {
          map[title] = img;
          if (p.variants) p.variants.forEach(v => {
            const vImg = v.featured_image ? v.featured_image.src.split('?')[0] : img;
            map[(title + ' - ' + (v.title || '')).toLowerCase()] = vImg;
          });
        }
      });
      return map;
    } catch (e) {
      console.warn('   ⚠️ Failed to fetch ' + storeUrl + ':', e.message);
      return {};
    }
  }

  try {
    const [s6, ba, ard] = await Promise.all([
      fetchShopify('https://6thsensefishing.com'),
      fetchShopify('https://bassassassin.com'),
      fetchShopify('https://ardentoutdoors.com')
    ]);

    function findImg(store, storeKeys, searchKey, color) {
      const c = (color || '').toLowerCase().trim();
      if (c) {
        const m1 = storeKeys.find(k => k.includes(searchKey) && k.includes(c) && !k.includes('/'));
        if (m1) return store[m1];
        const m2 = storeKeys.find(k => k.includes(searchKey) && k.includes(c));
        if (m2) return store[m2];
      }
      const base = storeKeys.filter(k => k === searchKey || (k.startsWith(searchKey) && k.split(' - ').length <= 2));
      if (base.length) { base.sort((a, b) => a.length - b.length); return store[base[0]]; }
      const any = storeKeys.find(k => k.includes(searchKey));
      return any ? store[any] : null;
    }

    const s6k = Object.keys(s6), bak = Object.keys(ba), ardk = Object.keys(ard);

    // Matching rules: [regex, store, storeKeys, searchKey]
    const rules = [
      // 6th Sense products
      [/divine spinnerbait/i, s6, s6k, 'divine spinnerbait'],
      [/divine swim jig/i, s6, s6k, 'divine swim jig'],
      [/flock blade/i, s6, s6k, 'flock blade series'],
      [/vega hush frog/i, s6, s6k, 'vega hush frog'],
      [/vega frog/i, s6, s6k, 'vega frog'],
      [/boosa/i, s6, s6k, 'boosa'],
      [/ridge lizard/i, s6, s6k, 'ridge lizard 5.7'],
      [/crappie strobe/i, s6, s6k, 'crappie strobe'],
      [/strobe minnow/i, s6, s6k, 'strobe minnow'],
      [/pressure series/i, s6, s6k, 'pressure series'],
      [/jugular h/i, s6, s6k, 'jugular hybrid hook'],
      [/catfish hook/i, s6, s6k, 'catfish hook'],
      [/live minnow hook/i, s6, s6k, 'live minnow hook'],
      [/bluegill.*hook|sunfish.*hook/i, s6, s6k, 'bluegill and sunfish hook'],
      [/lead split shot/i, s6, s6k, 'splitball'],
      [/lead worm weight/i, s6, s6k, 'divine worm weights'],
      [/6th sense banner/i, s6, s6k, '6th sense club banner'],
      [/duke\s*\d/i, s6, s6k, 'duke'],
      [/hogwalla/i, s6, s6k, 'hogwalla 5.8'],
      [/nedfry/i, s6, s6k, 'nedfry 4.6'],
      [/bamboosa/i, s6, s6k, 'bamboosa 5.3'],
      [/crappie shindo/i, s6, s6k, 'the crappie shindo 2.2'],
      [/panorama axle/i, s6, s6k, 'panorama axle jighead'],
      [/quake/i, s6, s6k, 'quake'],
      [/splashback/i, s6, s6k, 'splashback popper'],
      [/pecos underspin/i, s6, s6k, 'pecos underspin jighead'],
      [/juggle head/i, s6, s6k, 'masterclass juggle head'],
      [/finesse minnow/i, s6, s6k, 'finesse minnow jighead'],
      [/6th sense hat/i, s6, s6k, 'sobro capsule hat'],
      // Bass Assassin products
      [/railworm|rail worm/i, ba, bak, '7" rail worm'],
      [/tapout/i, ba, bak, '7.5" tapout'],
      [/twitch\s*\d/i, ba, bak, '6" twitch'],
      [/fw shad/i, ba, bak, '5" fw shad'],
      [/crappie dapper/i, ba, bak, '2" crappie dapper'],
      [/tiny shad/i, ba, bak, '2" pro tiny shad'],
      // Ardent products
      [/reel butter oil/i, ard, ardk, 'reel butter oil'],
      [/reel butter grease/i, ard, ardk, 'reel butter grease'],
      [/ardent reel care/i, ard, ardk, 'reel care'],
      [/lubrication kit/i, ard, ardk, 'reel butter lubrication pack'],
      [/reel kleen/i, ard, ardk, 'reel kleen cleaning kit'],
      [/cooler-d-funk.*wipe/i, ard, ardk, 'cooler d-funk wipes'],
      [/cooler-d-funk/i, ard, ardk, 'cooler d-funk 16 oz bottle'],
      [/fish-d-funk.*wipe/i, ard, ardk, 'fish d-funk wipes'],
      [/fish-d-funk/i, ard, ardk, 'fish-d-funk 8oz. spray'],
      [/combo.*finesse/i, ard, ardk, 'finesse ultra-light combo'],
      [/combo.*big water/i, ard, ardk, 'big water comfort grip combos'],
      [/combo.*super duty/i, ard, ardk, 'super duty spinning combo'],
      [/combo.*primo/i, ard, ardk, 'comfort grip combo - primo'],
      [/combo.*vario|combo.*hd|combo.*pink/i, ard, ardk, 'finesse ultra-light combo'],
    ];

    cache._rules = rules;
    cache._findImg = findImg;
    console.log(`   ✅ Image cache built: ${s6k.length} 6thSense + ${bak.length} BassAssassin + ${ardk.length} Ardent entries`);
  } catch (e) {
    console.warn('   ⚠️ Image cache build failed:', e.message);
  }

  _imageCache = cache;
  return cache;
}

function resolveProductImage(productName) {
  if (!_imageCache || !_imageCache._rules) return null;
  const rules = _imageCache._rules;
  const findImg = _imageCache._findImg;

  // Extract color from product name
  const parts = productName.split(/\s*-\s*/);
  let color = '';
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i].trim().toLowerCase();
    if (p && !/^\d/.test(p) && !/(oz|hook|pk|ct|dc|\d+\s*(ct|pk))$/i.test(p) && p.length > 1) {
      color = p;
      break;
    }
  }

  for (const [regex, store, storeKeys, searchKey] of rules) {
    if (regex.test(productName)) {
      return findImg(store, storeKeys, searchKey, color);
    }
  }
  return null;
}

// ─── Sync products from Clover ──────────────────────────
async function syncFromClover() {
  // DATA PROTECTION: This sync ONLY adds new products and updates stock counts.
  // It NEVER overwrites: images, prices, categories, or names of existing products.
  // These fields are resolved from manufacturer websites and must not be touched.
  console.log('\n🔄 Starting Clover sync...');
  const startTime = Date.now();

  // 0. Build image cache from manufacturer Shopify stores
  await buildImageCache();

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

  // 1b. Build item→category mapping by fetching items for each category
  // (more reliable than expand=categories on items endpoint)
  const itemCategoryMap = {}; // itemId → { name, id }
  for (const [catId, cat] of Object.entries(categoriesMap)) {
    try {
      const catItems = await cloverFetch(`/categories/${catId}/items?limit=500`);
      if (catItems.elements) {
        for (const ci of catItems.elements) {
          // First category wins (don't overwrite if already assigned)
          if (!itemCategoryMap[ci.id]) {
            itemCategoryMap[ci.id] = { name: cat.name, id: catId };
          }
        }
        console.log(`   📁 Category "${cat.name}" has ${catItems.elements.length} items`);
      }
    } catch (e) {
      console.warn(`   ⚠️  Failed to fetch items for category "${cat.name}": ${e.message}`);
    }
  }
  console.log(`   📋 Mapped ${Object.keys(itemCategoryMap).length} items to categories`);

  // 2. Fetch all items with tags
  console.log('📦 Fetching items...');
  const itemsData = await cloverFetch('/items?expand=tags,modifierGroups&limit=500');

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

    // Use Clover's actual category names directly (from item→category mapping)
    let categoryKey = 'general';
    let categoryDisplayName = 'General';
    const catLookup = itemCategoryMap[item.id];
    if (catLookup) {
      categoryDisplayName = catLookup.name;
      categoryKey = categoryToKey(categoryDisplayName);
    } else if (item.categories && item.categories.elements && item.categories.elements.length > 0) {
      // Fallback to expand data if available
      const firstCategory = item.categories.elements[0];
      categoryDisplayName = firstCategory.name || 'General';
      categoryKey = categoryToKey(categoryDisplayName);
    }
    // If still "General", try auto-categorize by product name
    if (categoryKey === 'general') {
      const autoCategory = autoCategorizeServer(item.name);
      if (autoCategory) {
        categoryDisplayName = autoCategory;
        categoryKey = categoryToKey(autoCategory);
      }
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
      // UPDATE existing item — preserve any manually edited fields
      const existing = existingMatch.item;
      const oldCatKey = existingMatch.categoryKey;
      const manualEdits = existing._manualEdits || {};

      // Update fields from Clover ONLY if not manually edited
      existing.cloverId = item.id;
      // Never overwrite product names — they are the key for image/price matching
      // if (!manualEdits.name) existing.name = item.name;
      existing.sku = item.sku || existing.sku;
      if (!manualEdits.price && (!existing.price || existing.price === 0)) {
        existing.price = salePrice || priceInDollars;
        existing.original = salePrice ? priceInDollars : null;
      }
      existing.inStock = !item.stockCount || item.stockCount > 0;
      if (!manualEdits.stock) existing.stockCount = item.stockCount || existing.stockCount;
      if (!manualEdits.description) existing.desc = item.description || existing.desc;
      existing.badge = item.tags?.elements?.some(t => t.name?.toLowerCase() === 'sale') ? 'sale'
           : item.tags?.elements?.some(t => t.name?.toLowerCase() === 'new') ? 'new'
           : existing.badge;
      // Resolve imageUrl if missing (don't overwrite manual uploads)
      if (!existing.imageUrl && !manualEdits?.image) {
        existing.imageUrl = resolveProductImage(item.name) || null;
      }
      // Preserve brand if manually edited (only set if currently default)
      const cloverBrand = extractBrand(item.name);
      if (!manualEdits.brand && cloverBrand && (!existing.brand || existing.brand === 'Blackhawk Creek')) {
        existing.brand = cloverBrand;
      }

      // Only move if the product was in "general" (uncategorized) — NEVER move already-categorized products
      if (categoryKey !== oldCatKey && oldCatKey === 'general') {
        products[oldCatKey] = (products[oldCatKey] || []).filter(p => p.id !== existing.id);
        if (products[oldCatKey] && products[oldCatKey].length === 0) delete products[oldCatKey];
        existing.cloverCategory = categoryDisplayName;
        existing.icon = getCategoryIcon(categoryDisplayName);
        if (!products[categoryKey]) products[categoryKey] = [];
        products[categoryKey].push(existing);
      }
      // Don't update cloverCategory for already-categorized products

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
        imageUrl: resolveProductImage(item.name) || null,
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

// POST /api/sync — Pull fresh data from Clover
app.post('/api/sync', async (req, res) => {
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

    // Track manually edited fields so Clover sync won't overwrite them
    if (!foundItem._manualEdits) foundItem._manualEdits = {};

    // Apply basic field updates
    if (updates.name !== undefined) { foundItem.name = updates.name; foundItem._manualEdits.name = true; }
    if (updates.brand !== undefined) { foundItem.brand = updates.brand; foundItem._manualEdits.brand = true; }
    if (updates.price !== undefined) { foundItem.price = parseFloat(updates.price); foundItem._manualEdits.price = true; }
    if (updates.stock !== undefined) { foundItem.stockCount = parseInt(updates.stock); foundItem._manualEdits.stock = true; }
    if (updates.description !== undefined) { foundItem.desc = updates.description; foundItem._manualEdits.description = true; }

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

// ─── Clover Ecommerce: Get PAKMS key for frontend ──────────
// Fetches the real PAKMS apiAccessKey from Clover's API
let cachedPakmsKey = null;
let pakmsKeyFetchedAt = 0;

app.get('/api/checkout/config', async (req, res) => {
  try {
    // Try to fetch the real PAKMS key from Clover (cache for 1 hour)
    const now = Date.now();
    if (!cachedPakmsKey || (now - pakmsKeyFetchedAt) > 3600000) {
      if (CLOVER_ECOM_PRIVATE_KEY && MERCHANT_ID) {
        try {
          const pakmsUrl = `${BASE_URL}/pakms/apikey`;
          console.log('🔑 Fetching PAKMS key from:', pakmsUrl);
          const pakmsRes = await fetch(pakmsUrl, {
            headers: {
              'Authorization': `Bearer ${CLOVER_ECOM_PRIVATE_KEY}`,
              'Content-Type': 'application/json'
            }
          });
          if (pakmsRes.ok) {
            const pakmsData = await pakmsRes.json();
            if (pakmsData.apiAccessKey) {
              cachedPakmsKey = pakmsData.apiAccessKey;
              pakmsKeyFetchedAt = now;
              console.log('✅ PAKMS key fetched:', cachedPakmsKey.substring(0, 12) + '...');
            } else {
              console.warn('⚠️ PAKMS response missing apiAccessKey:', JSON.stringify(pakmsData));
            }
          } else {
            const errText = await pakmsRes.text();
            console.warn('⚠️ PAKMS fetch failed:', pakmsRes.status, errText);
          }
        } catch (pakmsErr) {
          console.warn('⚠️ PAKMS fetch error:', pakmsErr.message);
        }
      }
    }

    // Use PAKMS key if available, otherwise fall back to env var
    const publicKey = cachedPakmsKey || CLOVER_ECOM_PUBLIC_KEY || '';

    res.json({
      publicKey,
      merchantId: MERCHANT_ID || '',
      environment: ENVIRONMENT
    });
  } catch (err) {
    res.json({
      publicKey: CLOVER_ECOM_PUBLIC_KEY || '',
      merchantId: MERCHANT_ID || '',
      environment: ENVIRONMENT
    });
  }
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
  const itemSummary = order.items.map(i => `${i.quantity}x ${i.name}`).join(', ');
  const createOrderRes = await fetch(`${cloverAPI}/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      state: 'locked',
      title: `Online Order #${order.id}`,
      note: `Website order — ${order.customerName || 'Guest'} (${order.customerEmail || 'no email'})\nItems: ${itemSummary}`,
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

    const priceInCents = Math.round(item.price * 100);

    // Always create a named line item with price so it shows in Clover dashboard
    const lineItemPayload = {
      name: item.name,
      price: priceInCents,
      note: item.sku ? `SKU: ${item.sku}` : ''
    };

    // Link to inventory item if available so Clover tracks stock
    if (cloverItemId) {
      lineItemPayload.item = { id: cloverItemId };
    }

    // Add one line item per quantity unit (Clover counts each line item as qty 1)
    for (let q = 0; q < item.quantity; q++) {
      const lineRes = await fetch(`${cloverAPI}/orders/${cloverOrderId}/line_items`, {
        method: 'POST',
        headers,
        body: JSON.stringify(lineItemPayload)
      });
      if (!lineRes.ok) {
        const errText = await lineRes.text();
        console.warn(`⚠️ Failed to add line item "${item.name}":`, lineRes.status, errText);
      } else {
        console.log(`  ✅ Added line item: ${item.name} — $${item.price}`);
      }
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
const FOOTER_PAGES_FILE = path.join(DATA_DIR, 'footer-pages.json');

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
