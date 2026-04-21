import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import Razorpay from "razorpay";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
}); 

// temp 

/* 
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
  console.log("✅ Razorpay initialized");
} else {
  console.log("⚠️ Razorpay not configured (running in dev mode)");
}
*/
const app = express();
app.use(express.static("public"));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
 
/* ================== CORS ================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-key", "Authorization"]
}));
app.options("*", cors());
app.use(express.json());

const PORT = process.env.PORT || 5001;

/* ================== OPENAI ================== */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000
});

/* ================== MULTER ================== */
const upload = multer({ storage: multer.memoryStorage() });

/* ================== DB ================== */
const DB_FILE = "./db.json";

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      licenses: [],
      pricing: {
        pro: { price: 999, days: 30 }
      }
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function generateKey() {
  return "MEESHO-" + Math.random().toString(36).substr(2, 8).toUpperCase();
}

/* ================== LICENSE ================== */
function validateLicenseCore(licenseKey, deviceId) {
  const db = loadDB();
  const key = db.licenses.find(k => k.key === licenseKey);

  if (!key) return { ok: false, error: "Invalid key" };

if (!key.deviceId) {
  key.deviceId = deviceId; // first login
} else if (key.deviceId === deviceId) {
  // same browser → allow relogin
} else {
  return { ok: false, error: "This license is already used in another browser" };
}

  const now = new Date();
  const expiry = new Date(key.expiry);

  if (now > expiry) {
    return { ok: false, error: "Expired" };
  }

  saveDB(db);

  return {
    ok: true,
    expiry: key.expiry
  };
}

app.post('/logout', (req, res) => {
  // frontend logout only — DO NOT free device
  res.json({ success: true });
});

function requireLicense(req, res, next) {
  const { licenseKey, deviceId } = req.body;

  if (!licenseKey || !deviceId) {
    return res.status(401).json({ success: false });
  }

  const result = validateLicenseCore(licenseKey, deviceId);
  if (!result.ok) {
    return res.status(403).json({ success: false });
  }

  next();
}
//order amount creation 
app.post("/create-order", async (req, res) => {
  try {
    const { plan = "pro" } = req.body;

  const db = loadDB();
const pricing = db.pricing?.[plan];

if (!pricing) {
  return res.status(400).json({
    success: false,
    error: "Invalid plan"
  });
}
    if (!razorpay) {
  return res.status(500).json({
    success: false,
    error: "Payment system not configured yet"
  });
}
    const order = await razorpay.orders.create({
      amount: pricing.price * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now()
    });

res.json({
  success: true,
  order: {
    id: order.id,
    amount: order.amount
  },
  plan,
  days: pricing.days
});

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan
    } = req.body;

    // 🔒 Get plan from DB (NOT frontend days)
    const db = loadDB();
    const pricing = db.pricing?.[plan];
  const existing = db.licenses.find(k => k.paymentId === razorpay_payment_id);
if (existing) {
  return res.status(400).json({
    success: false,
    error: "Payment already used"
  });
}
    if (!razorpay) {
  return res.status(500).json({
    success: false,
    error: "Payment system not configured yet"
  });
}
  const finalDays = pricing.days;
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: "Invalid payment signature"
      });
    }

    // ✅ Generate key
    const newKey = {
      key: generateKey(),
      expiry: new Date(Date.now() + finalDays * 86400000).toISOString(),
      deviceId: null,
      createdAt: new Date().toISOString(),
      lastUsed: null,
      status: "active",
      paymentId: razorpay_payment_id
    };

    db.licenses.push(newKey);
    saveDB(db);

    res.json({
      success: true,
      key: newKey.key,
      expiry: newKey.expiry
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================== ADMIN ================== */
const ADMIN_KEY = process.env.ADMIN_KEY || "admin";

function checkAdmin(req, res) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    res.status(401).json({ success: false });
    return false;
  }
  return true;
}

app.post("/admin/generate-key", (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({ success: false });
  }

  const { days = 30 } = req.body;
  const db = loadDB();

 const newKey = {
  key: generateKey(),
  expiry: new Date(Date.now() + days * 86400000).toISOString(),
  deviceId: null,
  createdAt: new Date().toISOString(),
  lastUsed: null,
  status: "active"
};

  db.licenses.push(newKey);
  saveDB(db);

  res.json({ success: true, key: newKey });
});

app.get("/admin/stats", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = loadDB();
  const now = new Date();

  const total = db.licenses.length;
  const active = db.licenses.filter(k => new Date(k.expiry) > now).length;
  const expired = total - active;

  res.json({ total, active, expired });
});

app.post("/admin/login", (req, res) => {
  const { password } = req.body;

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "upanshu123";

  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }

  return res.status(401).json({ success: false });
});


app.get("/admin/licenses", (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({ success: false });
  }

  const db = loadDB();
  res.json({ success: true, licenses: db.licenses });
});

app.post("/admin/reset-device", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { licenseKey } = req.body;

  const db = loadDB();
  const key = db.licenses.find(k => k.key === licenseKey);

  if (!key) return res.json({ success: false });

  key.deviceId = null;
  saveDB(db);

  res.json({ success: true });
});

app.post("/admin/delete-license", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { licenseKey } = req.body;

  const db = loadDB();
  db.licenses = db.licenses.filter(k => k.key !== licenseKey);

  saveDB(db);

  res.json({ success: true });
});

app.post("/admin/extend-license", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { licenseKey, days } = req.body;

  const db = loadDB();
  const key = db.licenses.find(k => k.key === licenseKey);

  if (!key) return res.json({ success: false });

  const currentExpiry = new Date(key.expiry);
  key.expiry = new Date(currentExpiry.getTime() + days * 86400000).toISOString();

  saveDB(db);

  res.json({ success: true, newExpiry: key.expiry });
});
app.post("/admin/update-pricing", (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({ success: false });
  }

  const { plan, price, days } = req.body;

  const db = loadDB();

  if (!db.pricing) db.pricing = {};

  db.pricing[plan] = {
    price: Number(price),
    days: Number(days)
  };

  saveDB(db);

  res.json({ success: true });
});

app.get("/admin/pricing", (req, res) => {
  const db = loadDB();
  res.json({
    success: true,
    pricing: db.pricing || {}
  });
});

app.post('/validate-license', (req, res) => {
  const { licenseKey, deviceId } = req.body;

  if (!licenseKey || !deviceId) {
    return res.json({ success: false, valid: false, error: "Missing data" });
  }

  const db = loadDB();
  const key = db.licenses.find(k => k.key === licenseKey);

  // 1️⃣ Check key exists
  if (!key) {
    return res.json({ success: false, valid: false, error: "Invalid key" });
  }

  // 2️⃣ Check status (ACTIVE / DISABLED)
  if (key.status !== "active") {
    return res.json({
      success: false,
      valid: false,
      error: "License disabled"
    });
  }

  // 3️⃣ ONE BROWSER LOCK
  if (!key.deviceId) {
    key.deviceId = deviceId;
  } else if (key.deviceId !== deviceId) {
    return res.json({
      success: false,
      valid: false,
      error: "This license is already used in another browser"
    });
  }

  // 4️⃣ EXPIRY CHECK
  const now = new Date();
  const expiry = new Date(key.expiry);

  if (now > expiry) {
    return res.json({
      success: false,
      valid: false,
      error: "Expired"
    });
  }

  // 5️⃣ TRACK USAGE
  key.lastUsed = new Date().toISOString();
  saveDB(db);

  const remainingDays = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

  // 6️⃣ SUCCESS RESPONSE
  res.json({
    success: true,
    valid: true,
    expiry: key.expiry,
    remainingDays
  });
});

// ── Prompts ───────────────────────────────────────────────────────────────────
const TEXT_SYSTEM_PROMPT = `
You are a Meesho product listing expert. Given a product description, extract and generate structured listing fields.

Return ONLY a valid JSON object with these exact keys (use empty string "" if unknown):
{
  "product_name": "Full product name (max 50 chars) ",
  "color": "Primary color(s) of the product",
  "meesho_price": "Selling price in INR (numbers only, no ₹ symbol)",
  "product_mrp": "MRP in INR (numbers only)",
  "only_wrong_return_price": "Wrong return price in INR (usually 0)",
  "inventory": "Stock quantity (number only)",
  "supplier_gst_percent": "GST percentage (e.g. 5, 12, 18 — number only)",
  "hsn_code": "HSN code for the product category",
  "product_weight_in_gms": "Product weight in grams (number only)",
  "supplier_product_id": "A short unique SKU/product ID (e.g. SKU-001)",
  "category": "Meesho product category",
  "brand": "Brand name if mentioned, else empty string",
  "description": "A compelling 2-3 sentence product description for buyers(max 500 chars)"
}

Rules:
- All price/number fields must contain ONLY digits (no currency symbols, no units)
- If GST is not mentioned, infer from product type (clothing=5%, electronics=18%, home=12%)
- If HSN is not mentioned, infer from product category
- If weight is not mentioned, estimate based on product type
- Return ONLY the JSON object, no markdown, no explanation
`.trim();

const IMAGE_SYSTEM_PROMPT = `
You are a Meesho product listing expert. Analyze the product image and generate a complete listing description.
Return a detailed text description including: product name, color, material, style, use case, and suggested price range.
`.trim();

const FIELD_KEYS = [
  'product_name', 'color', 'meesho_price', 'product_mrp',
  'only_wrong_return_price', 'inventory', 'supplier_gst_percent',
  'hsn_code', 'product_weight_in_gms', 'supplier_product_id',
  'category', 'brand', 'description'
];


/* ================== HELPERS ================== */
function enforceLength(text, len) {
  if (!text) return "";
  if (text.length >= len) return text.substring(0, len);
  while (text.length < len) text += " extra quality product";
  return text.substring(0, len);
}

/* ================== TEXT ================== */
app.post('/generate-from-text', requireLicense, async (req, res) => {
  try {
    const { description } = req.body;
    if (!description || !description.trim()) {
      return res.status(400).json({ success: false, error: "Missing 'description' in request body" });
    }

    if (!openai) {
      return res.status(500).json({ success: false, error: 'OpenAI package not available' });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ success: false, error: 'OPENAI_API_KEY not set. Create a .env file with OPENAI_API_KEY=sk-...' });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: TEXT_SYSTEM_PROMPT },
        { role: 'user',   content: `Product description: ${description.trim()}` }
      ],
      temperature: 0.3,
      max_tokens: 600
    });

    let raw = response.choices[0].message.content.trim();

    // Strip markdown code fences if present
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    const parsed = JSON.parse(raw);

    // Ensure all expected keys exist as strings
    const fields = {};
    for (const key of FIELD_KEYS) {
      fields[key] = String(parsed[key] || '').trim();
    }

    return res.json({ success: true, fields });

  } catch (err) {
    console.error('❌ /generate-from-text error:', err.message);
    if (err instanceof SyntaxError) {
      return res.status(500).json({ success: false, error: 'AI returned invalid JSON. Try again.' });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Pads or truncates product_name to exactly `targetLen` characters.
 * Padding uses comma-separated SEO keywords.
 */
function enforceProductNameLength(name, targetLen = 150) {
  if (!name) return name;
  if (name.length >= targetLen) return name.substring(0, targetLen);
  const keywords = [
    'Durable Quality', 'Long Lasting', 'Easy to Use', 'Lightweight Design',
    'Compact Size', 'Multi Purpose', 'Versatile Product', 'Modern Style',
    'Attractive Look', 'Great Value', 'Functional Design', 'Practical Use',
    'Quality Material', 'Reliable Product', 'Stylish Finish', 'Smooth Texture',
    'Sturdy Build', 'Eco Friendly', 'Washable Material', 'Reusable Design'
  ];
  let padded = name;
  for (const kw of keywords) {
    if (padded.length >= targetLen) break;
    const addition = ', ' + kw;
    if (padded.length + addition.length <= targetLen) {
      padded += addition;
    } else {
      const remaining = targetLen - padded.length;
      if (remaining > 3) padded += addition.substring(0, remaining);
      break;
    }
  }
  // Final pad with spaces if still short
  while (padded.length < targetLen) padded += ' ';
  return padded.substring(0, targetLen);
}
 // Padding uses generic SEO-friendly product sentences with rich keywords.
 
function enforceDescriptionLength(desc, targetLen =600) {
  if (!desc) return desc;
  if (desc.length >= targetLen) return desc.substring(0, targetLen);
  const additions = [
    ' This product is crafted with attention to detail, ensuring durability and long-lasting performance for daily use.',
    ' The ergonomic design ensures comfortable handling and ease of use for all users across different age groups.',
    ' Made from high-quality materials, this product meets strict quality standards and delivers consistent results.',
    ' The compact and lightweight design makes it easy to store and carry, perfect for travel and outdoor use.',
    ' Easy to clean and maintain, ensuring hygiene and longevity of the product with minimal effort required.',
    ' Available in attractive designs, this product enhances the visual appeal of any space it is placed in.',
    ' A reliable and affordable choice for those seeking quality, value, and functionality in a single product.',
    ' Suitable for gifting on occasions like birthdays, anniversaries, and festivals, making it a thoughtful choice.',
    ' The product undergoes rigorous quality checks to ensure it meets the highest standards before reaching customers.',
    ' Order now and experience the perfect blend of style, functionality, and durability in this exceptional product.',
    ' Ideal for indoor and outdoor use, this versatile product adapts to a wide range of settings and requirements.',
    ' The smooth finish and polished look make it an attractive addition to any collection or living space.',
    ' Designed for long-term use, this product resists wear and tear, maintaining its original quality over time.',
    ' A must-have product for modern households, combining practicality with an elegant and contemporary aesthetic.',
    ' The thoughtful construction ensures that every component works seamlessly together for optimal performance.',
    ' Trusted by thousands of satisfied customers, this product has earned a reputation for reliability and value.',
    ' Whether used professionally or casually, this product delivers consistent, high-quality results every time.',
    ' The innovative design incorporates user feedback to provide an improved and more intuitive experience.',
    ' Packaged securely to prevent damage during transit, ensuring the product arrives in perfect condition.',
    ' This product is an excellent value-for-money option, offering features typically found in higher-priced alternatives.',
    ' Crafted using eco-conscious manufacturing processes, this product is a responsible choice for mindful shoppers.',
    ' The non-toxic, food-grade, and skin-safe materials make it suitable for use by children and adults alike.',
    ' With its multi-functional design, this product eliminates the need for multiple separate items, saving space and cost.',
    ' The rust-proof, waterproof, and stain-resistant surface ensures the product remains pristine even after extended use.',
    ' Lightweight yet sturdy, this product strikes the perfect balance between portability and structural integrity.',
    ' Designed to meet Indian household needs, this product is tailored for local preferences and usage patterns.',
    ' The vibrant color options and modern patterns make this product a stylish and eye-catching choice.',
    ' Backed by a quality assurance process, every unit is inspected before dispatch to ensure customer satisfaction.',
    ' This product makes an ideal return gift, corporate gift, or festive hamper addition for all occasions.',
    ' The wide compatibility and universal design ensure this product works seamlessly across various use cases.',
  ];
  let padded = desc;
  for (const addition of additions) {
    if (padded.length >= targetLen) break;
    if (padded.length + addition.length <= targetLen) {
      padded += addition;
    } else {
      const remaining = targetLen - padded.length;
      if (remaining > 10) padded += addition.substring(0, remaining);
      break;
    }
  }
  // Final pad with spaces if still short
  while (padded.length < targetLen) padded += ' ';
  return padded.substring(0, targetLen);
}


/* ================== FORM (BEST VERSION) ================== */
app.post('/generate-from-form', requireLicense, async (req, res) => {
  try {
    const { description, formFields } = req.body;

    if (!description || !description.trim()) {
      return res.status(400).json({ success: false, error: "Missing 'description' in request body" });
    }
    if (!formFields || !Array.isArray(formFields) || formFields.length === 0) {
      return res.status(400).json({ success: false, error: "Missing 'formFields' array in request body" });
    }
    if (!openai) {
      return res.status(500).json({ success: false, error: 'OpenAI package not available' });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ success: false, error: 'OPENAI_API_KEY not set. Create a .env file with OPENAI_API_KEY=sk-...' });
    }

    // Build a field list for the prompt using the actual scanned fields
    const fieldList = formFields.map(f =>
      `- Selector: "${f.selector}" | Label: "${f.label}" | Type: ${f.type}${f.id ? ' | ID: ' + f.id : ''}`
    ).join('\n');

    const prompt = `You are a Meesho product listing expert. Generate accurate, SEO-rich listing data for the product described below.

The Meesho listing form has these fields (use EXACT selectors):
${fieldList}

Product description: "${description.trim()}"

━━━━━━━━━━━━━━━━━━━━━━
FIXED VALUES — always use these exact values for matching fields:
- Inventory / Stock: 100
- Variation / Size: Free Size
- Country of Origin: India
- Manufacturer Name: Groow with Deep
- Manufacturer Address: Railway Station Shamli , UTTARPRADESH
- Manufacturer Pincode: 247776
- Packer Name: Groowithdeep 
- Packer Address: Railway Station Shamli , UTTARPRADESH
- Packer Pincode: 247776
- Importer Name: Groowithdeep 
- Importer Address: Railway Station Shamli , UTTARPRADESH
- Importer Pincode: 247776
- Group ID: GROUP 1
- Brand Name: (DO NOT fill — leave blank, skip this field entirely)

━━━━━━━━━━━━━━━━━━━━━━
GENERATION RULES:

Product Name:
- SEO-rich marketplace title, EXACTLY 200 characters (use the FULL 200 character limit — pad with additional keywords, colors, use-cases, materials if needed)
- Include: Product Type + Material + Key Specs + Use-case + Color + Target Audience + Key Features
- NO brand names
- NO non-compliance words: you, everyday, home, homes, house, premium, safe, guaranteed, best, top
- Include high-intent SEO keywords, synonyms, and related search terms to fill all 200 characters

SKU ID: ST-<ProductType>-001 (e.g. ST-Kurti-001, ST-Dispenser-001)

HSN Code: Infer from product category (e.g. clothing=6211, kitchenware=7323, plastic items=3924)

GST: Always use 5 (number only, no % symbol — fixed value for all products)

Price (Meesho Price): Realistic market price in INR, digits only, no ₹ symbol

Weight: Realistic weight in grams, digits only

Packaging Dimensions: Realistic values based on product type and size

Product Dimensions: Realistic values based on product type and size

Description: EXACTLY 600 characters (use the FULL 600 character limit). Write a detailed, SEO-rich product description that includes:
- Product name and type
- Material and build quality
- Key features and specifications (at least 7-10 bullet-style points written as sentences)
- Usage scenarios and benefits
- Dimensions, capacity, or size details
- Care instructions or usage tips
- Target audience (women, men, kids, kitchen, office, travel, gifting, etc.)
- 40+ high-intent SEO keywords naturally woven in, covering:
    * Product type synonyms and alternate names
    * Material keywords (e.g. stainless steel, BPA-free plastic, pure cotton, polyester, ceramic)
    * Color and finish keywords (e.g. multicolor, printed, solid, matte, glossy)
    * Use-case keywords (e.g. kitchen use, office use, travel friendly, outdoor, gifting, festive)
    * Audience keywords (e.g. women, men, girls, boys, kids, adults, family)
    * Quality keywords (e.g. durable, long-lasting, sturdy, lightweight, rust-proof, waterproof, washable)
    * Shopping intent keywords (e.g. buy online, affordable, value for money, budget friendly, under 500)
    * Occasion keywords (e.g. birthday gift, anniversary gift, wedding gift, Diwali, Holi, Raksha Bandhan)
    * Trending marketplace search terms relevant to the product category
- NO brand names. NO non-compliance words (you, everyday, home, homes, house, premium, safe, guaranteed, best, top).
- Must be exactly 600 characters — count carefully and pad with additional keyword-rich sentences if needed.

For dropdown fields (type=select or type=dropdown): provide the most common valid option value that would appear in a Meesho dropdown (e.g. for Material: "Plastic", "Stainless Steel", "Cotton"; for Generic Name: the product type; for Net Quantity: "1"; for Packaging Unit: "cm" or "inch")

━━━━━━━━━━━━━━━━━━━━━━
Return ONLY a valid JSON array (no markdown, no explanation, no code fences):
[
  { "selector": "exact_selector_from_above", "value": "generated_value" }
]

IMPORTANT:
- Use the EXACT selector strings from the field list above
- Do NOT include Brand Name field in output
- Do NOT include fields with empty or null values
- For number-only fields: digits only, no symbols or units`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2500
    });

    let raw = response.choices[0].message.content.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return res.status(500).json({ success: false, error: 'AI returned invalid JSON. Try again.' });
    }

    if (!Array.isArray(parsed)) {
      return res.status(500).json({ success: false, error: 'AI returned unexpected format. Try again.' });
    }

    // Filter out entries without selector or value
    let fields = parsed.filter(f => f && f.selector && f.value !== undefined && String(f.value).trim() !== '');

    // ── Enforce exact character lengths for product_name and description ──────
    fields = fields.map(f => {
      const sel = String(f.selector || '');
      const lbl = String(f.label || '').toLowerCase();
      let val = String(f.value || '');

      // Product Name → exactly 300 chars
      if (sel.includes('product_name') || lbl.includes('product name')) {
        val = enforceProductNameLength(val, 150);
      }

      // Description textarea → exactly 700 chars
      if (
        sel.toLowerCase().includes('description') ||
        lbl.includes('description') ||
        sel.toLowerCase().includes('textarea')
      ) {
        val = enforceDescriptionLength(val, 600);
      }

      return { ...f, value: val };
    });

    // ── Enforce price rules: wrong_return = price-1, mrp = price×4 ───────────
    const priceField = fields.find(f =>
      String(f.selector).includes('meesho_price') ||
      String(f.label || '').toLowerCase().includes('meesho price')
    );
    if (priceField) {
      const price = parseInt(String(priceField.value), 10);
      if (!isNaN(price) && price > 0) {
        const wrongReturnSel = 'input[id="only_wrong_return_price"]';
        const mrpSel = 'input[id="product_mrp"]';

        // Wrong/Defective Returns Price = Meesho Price - 1
        const wrongIdx = fields.findIndex(f => String(f.selector).includes('only_wrong_return_price'));
        if (wrongIdx > -1) {
          fields[wrongIdx] = { ...fields[wrongIdx], value: String(price - 1) };
        } else {
          fields.push({ selector: wrongReturnSel, value: String(price - 1), label: 'Wrong/Defective Returns Price' });
        }

        // MRP = Meesho Price × 4
        const mrpIdx = fields.findIndex(f => String(f.selector).includes('product_mrp'));
        if (mrpIdx > -1) {
          fields[mrpIdx] = { ...fields[mrpIdx], value: String(price * 4) };
        } else {
          fields.push({ selector: mrpSel, value: String(price * 4), label: 'MRP' });
        }
      }
    }

    return res.json({ success: true, fields, count: fields.length });

  } catch (err) {
    console.error('❌ /generate-from-form error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
/* ================== IMAGE ================== */
app.post('/generate', upload.single('image'), requireLicense, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file provided' });
    }

    if (!openai) {
      return res.status(500).json({ success: false, error: 'OpenAI package not available' });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ success: false, error: 'OPENAI_API_KEY not set' });
    }

    const imageB64  = req.file.buffer.toString('base64');
    const mimeType  = req.file.mimetype || 'image/jpeg';
    const licenseKey = req.body.licenseKey || req.headers['x-license-key'];
    const deviceId = req.body.deviceId || req.headers['x-device-id'];
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: IMAGE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${imageB64}` }
            },
            {
              type: 'text',
              text: 'Analyze this product image and generate a complete Meesho listing description.'
            }
          ]
        }
      ],
      temperature: 0.4,
      max_tokens: 800
    });

    const result = response.choices[0].message.content.trim();
    return res.json({ success: true, result });

  } catch (err) {
    console.error('❌ /generate error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


/* ================== HEALTH ================== */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* ================== START ================== */
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on " + PORT);
});
