const { useState, useEffect, useMemo, useRef, useCallback, memo, useDeferredValue } = React;
const API_URL = "https://script.google.com/macros/s/AKfycbynxNksVH5dgUUcwfyAD-LzAKC41GUtfYUZM61Ml-RUilBX7Prpks8BiJpTiidpH_Yu/exec";

// ===== CLOUDINARY CONFIG =====
const CLOUDINARY_CLOUD_NAME = "fjw0er3b";
const CLOUDINARY_UPLOAD_PRESET = "dessie_martuploads";
const CLOUDINARY_BASE_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

// ===== REQUEST DEDUPLICATION & CACHE =====
const _pendingRequests = new Map();
const _requestTimeouts = new Map();

function _makeRequestKey(action, params) {
  try { return action + "::" + JSON.stringify(params || {}); } catch { return action + "::" + Date.now(); }
}

async function _dedupedRequest(action, params, requestFn) {
  const key = _makeRequestKey(action, params);
  if (_pendingRequests.has(key)) return _pendingRequests.get(key);
  const promise = requestFn().finally(() => {
    _pendingRequests.delete(key);
    clearTimeout(_requestTimeouts.get(key));
    _requestTimeouts.delete(key);
  });
  _pendingRequests.set(key, promise);
  _requestTimeouts.set(key, setTimeout(() => { _pendingRequests.delete(key); }, 20000));
  return promise;
}

// ===== API =====
async function apiGet(action, params = {}) {
  return _dedupedRequest(action, params, async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    try {
      const q = new URLSearchParams({ action, _ts: Date.now(), ...params });
      const res = await fetch(API_URL + "?" + q, { cache: "no-store", signal: controller.signal });
      clearTimeout(timeoutId);
      return res.json();
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') throw new Error('Request timed out');
      throw e;
    }
  });
}

async function apiPost(action, payload = {}) {
  return _dedupedRequest(action + "_POST", payload, async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, ...payload, _ts: Date.now(), _id: Math.random().toString(36).slice(2) }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return res.json();
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') throw new Error('Request timed out');
      throw e;
    }
  });
}

// ===== CACHE (with configurable TTL) =====
function cacheGet(k, maxAgeMs = 300000) {
  try {
    const item = localStorage.getItem('dm_cache_' + k);
    if (!item) return null;
    const d = JSON.parse(item);
    if (Date.now() - d.timestamp > maxAgeMs) { localStorage.removeItem('dm_cache_' + k); return null; }
    return d.value;
  } catch(e) { return null; }
}
function cacheSet(k, v) {
  try { localStorage.setItem('dm_cache_' + k, JSON.stringify({ timestamp: Date.now(), value: v })); } catch(e) {}
}
function cacheClear(pattern = null) {
  try {
    if (!pattern) { Object.keys(localStorage).filter(k => k.startsWith('dm_cache_')).forEach(k => localStorage.removeItem(k)); return; }
    Object.keys(localStorage).filter(k => k.startsWith('dm_cache_') && k.includes(pattern)).forEach(k => localStorage.removeItem(k));
  } catch(e) {}
}

// ===== IMAGE HELPERS =====
function compressImage(file, maxDim = 1200, quality = 0.82) {
  return new Promise(resolve => {
    if (!file.type || !file.type.startsWith("image/") || file.type === "image/gif") { resolve(file); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: h } = img;
      if (w <= maxDim && h <= maxDim) { resolve(file); return; }
      const s = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * s); h = Math.round(h * s);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      c.toBlob(b => resolve(b ? new File([b], file.name, { type: "image/jpeg" }) : file), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function apiUploadFile(file) {
  const compressed = await compressImage(file);
  const b64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(compressed);
  });
  const res = await apiPost("uploadImage", { file: { base64: b64, mimeType: compressed.type, filename: file.name } });
  return res && res.url ? res.url : null;
}

// Upload to Cloudinary directly from browser
async function uploadToCloudinary(file) {
  const compressed = await compressImage(file, 1600, 0.85);
  const formData = new FormData();
  formData.append("file", compressed);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", "dessie_mart");
  try {
    const res = await fetch(CLOUDINARY_BASE_URL, { method: "POST", body: formData });
    const data = await res.json();
    return data.secure_url || data.url || null;
  } catch (e) { return null; }
}

// Smart upload - tries Cloudinary first, falls back to Apps Script
async function smartUpload(file, preferCloudinary = true) {
  if (preferCloudinary) {
    const cloudUrl = await uploadToCloudinary(file);
    if (cloudUrl) return cloudUrl;
  }
  return apiUploadFile(file);
}

// Normalize any image URL (handles Cloudinary, existing URLs, old URLs)
function normalizeImageUrl(url, fallback = null) {
  if (!url) return fallback;
  if (typeof url !== "string") return fallback;
  // Already a full URL
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  // Cloudinary public ID
  if (url.includes("/")) return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/${url}`;
  // Legacy ID or relative path
  return url;
}

// Check if URL is a Cloudinary URL
function isCloudinaryUrl(url) {
  return typeof url === "string" && url.includes("cloudinary.com");
}

// Get optimized Cloudinary URL with transformations
function getCloudinaryUrl(url, opts = {}) {
  if (!url || !isCloudinaryUrl(url)) return url;
  const { width, height, quality = "auto", format = "auto", crop = "fill" } = opts;
  const base = url.replace(/\/upload\/v\d+\//, "/upload/").replace("/upload/", "/upload/");
  const parts = base.split("/upload/");
  if (parts.length !== 2) return url;
  let transforms = "f_" + format + ",q_" + quality;
  if (width) transforms += ",w_" + width;
  if (height) transforms += ",h_" + height;
  if (crop) transforms += ",c_" + crop;
  return parts[0] + "/upload/" + transforms + "/" + parts[1];
}

// ===== SHARED DATA LOADERS =====
// Unified data loading with caching, deduplication, and error handling

async function loadProducts(token = null) {
  const cacheKey = token ? 'products_admin' : 'products';
  const cached = cacheGet(cacheKey, token ? 60000 : 300000);
  if (cached && !token) return cached;
  try {
    const p = await apiGet("getProducts", token ? { token } : {});
    const arr = Array.isArray(p) ? p : [];
    if (!token) cacheSet(cacheKey, arr);
    return arr;
  } catch (e) { console.error("Products load failed", e); return []; }
}

async function loadCategories() {
  const cached = cacheGet('categories');
  if (cached) return cached;
  try {
    const cats = await apiGet("getCategories");
    const arr = Array.isArray(cats) ? cats : [];
    cacheSet('categories', arr);
    return arr;
  } catch (e) { return []; }
}

async function loadSettings() {
  const c = cacheGet('settings');
  if (c) return c;
  try {
    const s = await apiGet("getSettings");
    const m = {}; (Array.isArray(s) ? s : []).forEach(r => { m[r.key] = r.value; });
    const o = {
      mediumSurcharge: Number(m.mediumSurcharge) || DEFAULT_MEDIUM_SURCHARGE,
      heavySurcharge: Number(m.heavySurcharge) || DEFAULT_HEAVY_SURCHARGE,
      paymentMethods: safeParse(m.paymentMethods)
    };
    cacheSet('settings', o);
    return o;
  } catch (e) { return { mediumSurcharge: DEFAULT_MEDIUM_SURCHARGE, heavySurcharge: DEFAULT_HEAVY_SURCHARGE, paymentMethods: [] }; }
}

async function loadDeliveryZones() {
  const cached = cacheGet('deliveryZones');
  if (cached) return cached;
  try {
    const z = await apiGet("getDeliveryZones");
    const arr = Array.isArray(z) && z.length > 0 ? z : DEFAULT_DELIVERY_ZONES;
    cacheSet('deliveryZones', arr);
    return arr;
  } catch (e) { return DEFAULT_DELIVERY_ZONES; }
}

async function loadAdmins() {
  try { const a = await apiGet("getAdmins"); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}

async function loadOrders(token) {
  if (!token) return [];
  try {
    const a = await apiGet("getOrders", { token });
    return (Array.isArray(a) ? a : []).map(o => ({ ...o, items: safeParse(o.itemsJson) })).reverse();
  } catch (e) { return []; }
}

async function loadTickets() {
  try { const a = await apiGet("getTickets"); return (Array.isArray(a) ? a : []).reverse(); }
  catch (e) { return []; }
}

async function loadPickupLocations() {
  try { const locs = await apiGet("getPickupLocations"); return Array.isArray(locs) ? locs : []; }
  catch (e) { return []; }
}

async function loadTicketMessages(ticketId) {
  try { const m = await apiGet("getMessages", { ticketId }); return Array.isArray(m) ? m : []; }
  catch (e) { return []; }
}

async function trackOrderByPhone(phone) {
  try {
    const m = await apiGet("trackOrder", { phone: normalizePhone(phone) });
    return (Array.isArray(m) ? m : []).map(o => ({ ...o, items: safeParse(o.itemsJson) })).reverse();
  } catch (e) { return []; }
}

async function findTicketsByPhone(phone) {
  try { const r = await apiGet("findTickets", { phone: normalizePhone(phone) }); return Array.isArray(r) ? r.reverse() : []; }
  catch (e) { return []; }
}

// ===== ORDER CALCULATION UTILITIES =====
function groupItemsBySeller(items, productMap, admins) {
  const groups = {};
  items.forEach(c => {
    const product = productMap[c.id];
    if (!product) return;
    const sellerId = product.sellerId || product.sellerID || product.adminId || "default";
    if (!groups[sellerId]) groups[sellerId] = { sellerId, items: [], subtotal: 0, weightCounts: { light: 0, medium: 0, heavy: 0 } };
    groups[sellerId].items.push({ ...c, product });
    groups[sellerId].subtotal += (Number(product.price) || 0) * c.qty;
    const w = product.weight || "light";
    groups[sellerId].weightCounts[w] = (groups[sellerId].weightCounts[w] || 0) + c.qty;
  });
  return Object.values(groups);
}

function calculateSurcharge(weightCounts, settings) {
  const mr = (settings && settings.mediumSurcharge) || DEFAULT_MEDIUM_SURCHARGE;
  const hr = (settings && settings.heavySurcharge) || DEFAULT_HEAVY_SURCHARGE;
  return (weightCounts.medium || 0) * mr + (weightCounts.heavy || 0) * hr;
}

function calculateDeliveryFee(zone, fulfilment, surcharge = 0) {
  if (fulfilment === "pickup") return 0;
  const baseFee = zone ? Number(zone.fee) || 0 : 0;
  return baseFee + surcharge;
}

function calculateOrderTotals(items, productMap, zone, settings, fulfilment = "delivery") {
  const subtotal = items.reduce((s, c) => {
    const p = productMap[c.id];
    return s + (p ? (Number(p.price) || 0) * c.qty : 0);
  }, 0);
  const wc = items.reduce((a, c) => {
    const p = productMap[c.id];
    const w = p ? (p.weight || "light") : "light";
    a[w] = (a[w] || 0) + c.qty;
    return a;
  }, {});
  const surcharge = calculateSurcharge(wc, settings);
  const deliveryFee = calculateDeliveryFee(zone, fulfilment, surcharge);
  const total = subtotal + deliveryFee;
  return { subtotal, surcharge, deliveryFee, total, weightCounts: wc };
}

function isPickupOrder(order) {
  return order && (order.fulfilment === "pickup" || order.zoneName === "Pickup" || order.deliveryFee === 0);
}

function isDeliveryOrder(order) {
  return !isPickupOrder(order);
}

// ===== PAGINATION / LAZY LOADING =====
function usePaginatedData(items, pageSize = 20) {
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const displayed = useMemo(() => items.slice(0, page * pageSize), [items, page, pageSize]);
  useEffect(() => { setPage(1); setHasMore(items.length > pageSize); }, [items, pageSize]);
  const loadMore = useCallback(() => {
    const next = page + 1;
    setPage(next);
    setHasMore(items.length > next * pageSize);
  }, [page, items, pageSize]);
  return { displayed, hasMore, loadMore, page };
}

function useLazyImage(src) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [currentSrc, setCurrentSrc] = useState(null);
  const imgRef = useRef(null);

  useEffect(() => {
    if (!src) { setCurrentSrc(null); setLoaded(false); setError(false); return; }
    const normalized = normalizeImageUrl(src);
    setCurrentSrc(normalized);
    setLoaded(false);
    setError(false);
  }, [src]);

  const onLoad = useCallback(() => setLoaded(true), []);
  const onError = useCallback(() => { setError(true); setLoaded(true); }, []);

  return { src: currentSrc, loaded, error, onLoad, onError, imgRef };
}

// ===== EXISTING CODE (preserved) =====
const EMOJI = {
  ShoppingCart: "🛒", Search: "🔍", X: "✕", Plus: "➕", Minus: "➖",
  Package: "📦", Truck: "🚚", CreditCard: "💳", Phone: "📞", Instagram: "📸",
  Send: "✈️", Mail: "✉️", ArrowLeft: "←", Trash2: "🗑️", Save: "💾",
  Smartphone: "📱", Shirt: "👕", Sofa: "🛋️", ShoppingBasket: "🧺", Sparkles: "✨",
  Baby: "🍼", Dumbbell: "🏋️", BookOpen: "📚", Lock: "🔒", BarChart3: "📊",
  ClipboardList: "📋", LifeBuoy: "🛟", CheckCircle2: "✅", AlertTriangle: "⚠️",
  Clock: "🕐", MessageCircle: "💬", Menu: "☰", Copy: "📋", Globe: "🌐",
  Bolt: "⚡", Home: "🏠", MapPin: "📍", Edit3: "✏️", Navigation: "🧭",
  Sun: "☀️", Moon: "🌙", User: "👤", Camera: "📷", Star: "⭐",
  TrendingUp: "📈", DollarSign: "💵", Eye: "👁️", Filter: "🔎", RefreshCw: "🔄",
  LogOut: "🚪", Settings: "⚙️", Shield: "🛡️", Award: "🏆", Zap: "⚡"
};
const Icon = memo(({ name, size = 18, className = "" }) => (
  <span className={className} style={{ fontSize: size, lineHeight: 1, display: "inline-flex" }}>{EMOJI[name] || "•"}</span>
));

function getChildren(cats, pid) {
  return cats.filter(c => String(c.parentId || "") === String(pid || "") && c.active !== false && c.active !== "FALSE")
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
}
function flattenCategoryOptions(cats, pid, depth = 0) {
  return getChildren(cats, pid).reduce((a, c) => {
    a.push({ id: c.id, label: "— ".repeat(depth) + c.name });
    return a.concat(flattenCategoryOptions(cats, c.id, depth + 1));
  }, []);
}
function getDescendantIds(cats, id) {
  return cats.filter(c => String(c.parentId || "") === String(id))
    .reduce((a, c) => a.concat(c.id, getDescendantIds(cats, c.id)), []);
}
function countProductsInCategory(prods, cats, id) {
  const ids = [id, ...getDescendantIds(cats, id)];
  return prods.filter(p => ids.includes(p.category)).length;
}
function normalizePhone(raw) {
  let d = String(raw || "").replace(/[^0-9]/g, "");
  if (d.startsWith("251")) d = "0" + d.slice(3);
  if (d.length === 9 && !d.startsWith("0")) d = "0" + d;
  return d;
}
function etb(n) { return `${Number(n || 0).toLocaleString()} ETB`; }
function safeParse(s) { try { return JSON.parse(s); } catch(e) { return []; } }
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function timeAgo(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const DEFAULT_DELIVERY_ZONES = [
  { id: "piassa", name: "Piassa", fee: 100, eta: "15 min – 1 hr" },
  { id: "buanbuha", name: "Buanbuha", fee: 100, eta: "30 min - 1 hr" },
  { id: "dandeboro", name: "Dande Boro", fee: 150, eta: "1–2 hrs" },
  { id: "university", name: "University", fee: 250, eta: "1–2 hrs" },
  { id: "arada", name: "Arada", fee: 150, eta: "30 min – 1 hr" },
  { id: "segno", name: "Segno Gebeya", fee: 100, eta: "30 min – 1 hr" }
];
const DEFAULT_MEDIUM_SURCHARGE = 50;
const DEFAULT_HEAVY_SURCHARGE = 100;
const PICKUP_LOCATION = "Piassa – Family Supermarket";
const DEFAULT_PAYMENT_METHODS = [
  { id: "cbe", name: "CBE", account: "1000771527148", note: "Commercial Bank of Ethiopia" },
  { id: "abyssinia", name: "Abyssinia", account: "260138391", note: "Bank of Abyssinia" },
  { id: "telebirr", name: "Telebirr", account: "0989610229", note: "Mobile money" },
  { id: "mpesa", name: "M-Pesa", account: "0714878079", note: "Mobile money" }
];
const CONTACT = {
  phone: "+251989610229", telegram: "https://t.me/+251989610229",
  instagram: "https://www.instagram.com/dessiemart?igsh=MWFsb21pdHp0ejcwdQ==",
  email: "dessiemart964@gmail.com", whatsapp: "https://wa.me/251989610229",
  tiktok: "https://www.tiktok.com/@dessiemart?_r=1&_t=ZS-98EmkISwR5r"
};

const ORDER_STATUSES = [
  "Pending Payment Verification",
  "Pending Seller Approval",
  "Accepted by Seller",
  "Driver Assigned",
  "Ready for Pickup",
  "Out for Delivery",
  "Delivered",
  "Rejected"
];
const PAYMENT_STATUSES = ["Pending", "Completed", "Rejected"];
const SUPPORT_CATEGORIES = ["Unsuccessful Payment", "Unsuccessful Delivery", "Order Not Found", "Product Issue", "Other"];

const TRANSLATIONS = {
  en: {
    tagline1: "Shop Everything You Need", tagline2: "in Dessie",
    subtitle: "Quality products, best prices, and fast delivery to your door.",
    searchPlaceholder: "Search products…", shopByCategory: "Shop by Category",
    home: "Home", trackOrder: "Track Order", support: "Support", cart: "Cart",
    addToCart: "Add to Cart", buyNow: "Buy Now", goToCart: "Go to Cart",
    startShopping: "Start Shopping", emptyCart: "Your cart is empty",
    proceedCheckout: "Proceed to Checkout", checkout: "Checkout",
    deliveryOrPickup: "Delivery or Pickup", delivery: "Delivery", pickup: "Pickup",
    deliveryZone: "Delivery Zone", deliveryAddress: "Delivery Address / Landmark",
    yourDetails: "Your Details", fullName: "Full Name", phoneNumber: "Phone Number",
    payment: "Payment", paymentMethod: "Payment Method", transactionId: "Transaction ID",
    senderAccount: "Sender's Account / Phone", screenshotOptional: "Payment Screenshot (Optional)",
    tapToCopy: "Tap to copy", copied: "Copied!", orderSummary: "Order Summary",
    subtotal: "Subtotal", deliveryFee: "Delivery Fee", total: "Total",
    placeOrder: "Place Order", placingOrder: "Placing Order…", orderPlaced: "Order Placed!",
    findYourOrder: "Find Your Order", phoneUsed: "Phone used at checkout",
    searching: "Searching…", whatsIssue: "What's the issue?", yourName: "Your Name",
    describeIssue: "Describe the issue", sendToOwner: "Send to Owner", sending: "Sending…",
    goHome: "Go Home", weightLight: "Light", weightMedium: "Medium", weightHeavy: "Heavy",
    quantity: "Qty", stockWord: "in stock", outOfStockLabel: "Out of Stock",
    pickupNote: "Pickup at {location}. Ready in ~1–2 hrs.",
    sendAmountTo: "Send {amount} to", surchargeWord: "surcharge",
    itemWord: "item", itemsWord: "items", includesWord: "Includes", appliedWord: "applied",
    surchargeFixedNote: "Surcharge set by seller.",
    deliveryLocationFeeLabel: "Delivery", pickupFeeLabel: "Pickup",
    enterNamePhone: "Enter name and phone.", enterAddress: "Enter delivery address.",
    enterTxn: "Enter transaction ID and sender account.",
    duplicateTxn: "Transaction ID already used.", orderError: "Failed to place order. Try again.",
    popularProducts: "Popular", newArrivals: "New Arrivals", noProductsMatch: "No products match.",
    onlyLeftPill: "Only {n} left", itemsCount: "items", subtotalNote: "Delivery at checkout",
    findYourOrderTitle: "Track Order", noOrdersFound: "No orders found.", trackOrderBtn: "Track",
    viewScreenshot: "View Screenshot →", alreadyTalking: "Already talking to us?",
    chatRefreshNote: "If chat disappeared, find it with your phone number.",
    findBtn: "Find", noConversationFound: "No conversation found.",
    yourNameField: "Your Name", describeIssueField: "Describe Issue",
    screenshotOptField: "Screenshot (Optional)", attached: "Attached",
    productNotFound: "Product not found.", orderNumber: "Order", status: "Status",
    paymentStatus: "Payment", savePhoneNote: "Save your phone to track anytime.",
    gotScreenshot: "Got a payment screenshot?",
    sendScreenshotNote: "Send it on WhatsApp/Telegram with order #{orderId} for faster verification.",
    continueShopping: "Continue Shopping", weWillVerify: "We'll verify and confirm shortly.",
    step: "Step", next: "Next", back: "Back", review: "Review & Pay",
    step1Title: "Delivery", step2Title: "Details & Payment", step3Title: "Review",
    step1Desc: "Choose delivery or pickup.", step2Desc: "Enter your info.", step3Desc: "Confirm order.",
    returningCustomer: "Returning customer? We'll auto-fill.", enterPhoneToLoad: "Enter phone to load saved info.",
    loadInfo: "Load Info", deliveryPerson: "Driver", accept: "Accept", reject: "Reject",
    sellerDashboard: "Seller Dashboard", deliveryDashboard: "Driver Dashboard",
    adminLogin: "Admin Login", username: "Username", password: "Password", login: "Log In",
    paymentTransfers: "Payment Transfers", selectAdmin: "Select Admin", messageToSend: "Message",
    sendPaymentNotification: "Send", paymentTransfersDesc: "Notify admin about payment transfer.",
    markDelivered: "Mark Delivered", history: "History", noHistory: "No history yet.",
    active: "Active", handToDelivery: "Hand to Driver", selectDelivery: "Select Driver", ship: "Ship",
    claim: "Claim", sellerAccept: "Accept Order", deliveryZones: "Delivery Zones",
    zoneName: "Zone", zoneFee: "Fee (ETB)", zoneEta: "ETA", addZone: "Add Zone",
    saveZone: "Save", deleteZone: "Delete", noZones: "No zones configured.",
    myProducts: "My Products", allProducts: "All Products", editProduct: "Edit",
    restock: "Restock", priceEdit: "Price", stockEdit: "Stock", descriptionEdit: "Description",
    weightEdit: "Weight", categoryAccess: "Category Access", selectCategories: "Select categories…",
    noCategoriesAvailable: "No categories.", preparing: "Preparing", readyForDelivery: "Ready for Pickup",
    outForDelivery: "Out for Delivery", giveToDelivery: "Hand to Driver", acceptDelivery: "Accept Delivery",
    sellerPickupLocation: "Pickup Location", pickupAddress: "Pickup Address", pickupPhone: "Pickup Phone",
    deliveryRoute: "Route", openInMaps: "Open Maps", seller: "Seller", customer: "Customer", mapLink: "Map",
    pendingSellerApproval: "Pending Seller Approval", acceptedBySeller: "Accepted by Seller",
    driverAssigned: "Driver Assigned", readyForPickup: "Ready for Pickup",
    outForDelivery: "Out for Delivery", delivered: "Delivered", rejected: "Rejected",
    orderPlaced: "Order Placed", otpCode: "Verification Code", enterOTP: "Enter OTP",
    uploadProof: "Upload Delivery Photo", verifyAndDeliver: "Verify & Deliver",
    orderTimeline: "Order Timeline", orderDetails: "Order Details",
    assignedDriver: "Assigned Driver", driverPhone: "Driver Phone",
    verificationCode: "OTP", copy: "Copy", copiedToClipboard: "Copied!",
    noPendingOrders: "No pending orders.", noActiveOrders: "No active orders.",
    noAvailableOrders: "No available orders.", claimOrder: "Claim Order",
    packagePickedUp: "Package Picked Up", markAsPickedUp: "Mark Picked Up",
    darkMode: "Dark Mode", lightMode: "Light Mode", logout: "Logout",
    ownerDashboard: "Owner Dashboard", analytics: "Analytics", products: "Products",
    categories: "Categories", tickets: "Support", settings: "Settings",
    admins: "Admins", zones: "Zones", orders: "Orders", dashboard: "Dashboard",
    totalOrders: "Total Orders", totalRevenue: "Total Revenue", activeOrders: "Active",
    pendingOrders: "Pending", completedToday: "Completed Today",
    refresh: "Refresh", loadMore: "Load More", showing: "Showing",
    filterByStatus: "Filter by Status", all: "All", search: "Search",
    orderID: "Order ID", customerName: "Customer", customerPhone: "Phone",
    address: "Address", items: "Items", actions: "Actions", update: "Update",
    cancel: "Cancel", confirm: "Confirm", areYouSure: "Are you sure?",
    delete: "Delete", edit: "Edit", save: "Save", close: "Close",
    addProduct: "Add Product", productName: "Product Name", category: "Category",
    price: "Price", stock: "Stock", weight: "Weight", description: "Description",
    image: "Image", active: "Active", inactive: "Inactive", add: "Add",
    addCategory: "Add Category", parentCategory: "Parent Category", none: "None",
    categoryName: "Name", bannerImage: "Banner", icon: "Icon",
    addAdmin: "Add Admin", role: "Role", owner: "Owner", seller: "Seller",
    delivery: "Delivery", telegramID: "Telegram ID", vehicle: "Vehicle",
    photoUrl: "Photo URL", notifications: "Notifications", sendNotification: "Send",
    markAllRead: "Mark all read", noNotifications: "No notifications.",
    orderUpdated: "Order updated", orderCreated: "Order created",
    newOrder: "New Order", orderAccepted: "Order Accepted", orderRejected: "Order Rejected",
    driverClaimed: "Driver Claimed", readyForPickup: "Ready for Pickup",
    outForDelivery: "Out for Delivery", orderDelivered: "Delivered",
    paymentVerified: "Payment Verified", viewOrder: "View Order",
    deliveryProof: "Delivery Proof", photoRequired: "Photo required",
    otpRequired: "OTP required", invalidOTP: "Invalid OTP", resendOTP: "Resend OTP",
    generateOTP: "Generate OTP", otpGenerated: "OTP generated",
    autoRefresh: "Auto-refresh", refreshNow: "Refresh now", lastUpdated: "Last updated",
    connectionError: "Connection error. Retrying…", retry: "Retry",
    noConnection: "No internet connection", checkConnection: "Check your connection",
    timeoutError: "Request timed out. Please retry.",
    sellerActions: "Seller Actions", deliveryActions: "Driver Actions",
    ownerActions: "Owner Actions", assignDriver: "Assign Driver",
    manualAssign: "Manual Assign", unassigned: "Unassigned",
    distance: "Distance", estimatedTime: "Est. time", navigation: "Navigation",
    googleMaps: "Google Maps", openStreetMap: "OpenStreetMap",
    startNavigation: "Start Navigation", routeDetails: "Route Details",
    from: "From", to: "To", estimated: "Estimated", minutes: "min",
    orderHistory: "Order History", dateRange: "Date Range", export: "Export",
    statistics: "Statistics", revenue: "Revenue", topProducts: "Top Products",
    topSellers: "Top Sellers", topDrivers: "Top Drivers", performance: "Performance",
    averageDeliveryTime: "Avg. Delivery", orderCount: "Orders", rating: "Rating",
    viewDetails: "View Details", backToList: "Back to List",
    orderNotFound: "Order not found", invalidOrderID: "Invalid order ID",
    tryAgain: "Try again", contactSupport: "Contact Support",
    somethingWentWrong: "Something went wrong", pleaseRetry: "Please try again",
    sessionExpired: "Session expired. Please login again.",
    unauthorized: "Unauthorized access", forbidden: "Access denied",
    loading: "Loading…", saving: "Saving…", uploading: "Uploading…",
    processing: "Processing…", pleaseWait: "Please wait…",
    success: "Success", error: "Error", warning: "Warning", info: "Info",
    done: "Done", skip: "Skip", later: "Later", notNow: "Not now",
    yes: "Yes", no: "No", ok: "OK", gotIt: "Got it",
    welcomeBack: "Welcome back", goodMorning: "Good morning", goodAfternoon: "Good afternoon",
    goodEvening: "Good evening", welcome: "Welcome",
    today: "Today", yesterday: "Yesterday", tomorrow: "Tomorrow",
    justNow: "Just now", minutesAgo: "{n} minutes ago", hoursAgo: "{n} hours ago",
    daysAgo: "{n} days ago", weeksAgo: "{n} weeks ago"
  },
  am: {
    tagline1: "የሚፈልጉትን ሁሉ ይግዙ", tagline2: "በደሴ",
    subtitle: "ጥራት ያላቸው ምርቶች፣ ምርጥ ዋጋዎች እና ፈጣን አቅርቦት ወደ ቤትዎ።",
    searchPlaceholder: "ምርቶችን ፈልግ…", shopByCategory: "በምድብ ይግዙ",
    home: "መነሻ", trackOrder: "ትዕዛዝ ይከታተሉ", support: "ድጋፍ", cart: "ጋሪ",
    addToCart: "ወደ ጋሪ ጨምር", buyNow: "አሁን ይግዙ", goToCart: "ወደ ጋሪ ሂድ",
    startShopping: "ግዢ ይጀምሩ", emptyCart: "ጋሪዎ ባዶ ነው",
    proceedCheckout: "ወደ ክፍያ ይሂዱ", checkout: "ክፍያ",
    deliveryOrPickup: "አቅርቦት ወይም ማንሳት", delivery: "አቅርቦት", pickup: "ማንሳት",
    deliveryZone: "የአቅርቦት ዞን", deliveryAddress: "የአቅርቦት አድራሻ / ምልክት",
    yourDetails: "የእርስዎ ዝርዝሮች", fullName: "ሙሉ ስም", phoneNumber: "ስልክ ቁጥር",
    payment: "ክፍያ", paymentMethod: "የክፍያ ዘዴ", transactionId: "የግብይት መለያ",
    senderAccount: "የላኪ አካውንት / ስልክ",
    screenshotOptional: "የክፍያ ቅጽበታዊ ገጽ እይታ (አማራጭ)",
    tapToCopy: "ለመቅዳት ይንኩ", copied: "ተቀድቷል!",
    orderSummary: "የትዕዛዝ ማጠቃለያ",
    subtotal: "ጠቅላላ ድምር", deliveryFee: "የአቅርቦት ወጪ", total: "ድምር",
    placeOrder: "ትዕዛዝ አስገባ", placingOrder: "እያስገባ…",
    orderPlaced: "ትዕዛዝ ተቀበለ!",
    findYourOrder: "ትዕዛዝዎን ያግኙ", phoneUsed: "በቼክአውት ጊዜ ጥቅም ላይ የዋለ ስልክ",
    searching: "እየፈለገ…", whatsIssue: "ምንድነው ችግሩ?",
    yourName: "ስምዎ", describeIssue: "ችግሩን ይግለጹ",
    sendToOwner: "ለባለቤቱ ላክ", sending: "እየላከ…",
    goHome: "ወደ መነሻ ሂድ",
    weightLight: "ቀላል", weightMedium: "መካከለኛ", weightHeavy: "ከባድ",
    quantity: "ብዛት", stockWord: "በክምችት ውስጥ",
    outOfStockLabel: "ክምችት አልቋል",
    pickupNote: "በ{location} ይውሰዱ። በ~1–2 ሰዓታት ውስጥ ይዘጋጃል።",
    sendAmountTo: "{amount} ወደ ላክ", surchargeWord: "ተጨማሪ ክፍያ",
    itemWord: "እቃ", itemsWord: "እቃዎች", includesWord: "ያካትታል",
    appliedWord: "ተተግብሯል", surchargeFixedNote: "ተጨማሪ ክፍያ በሻጩ ተዘጋጅቷል።",
    deliveryLocationFeeLabel: "አቅርቦት", pickupFeeLabel: "ማንሳት",
    enterNamePhone: "ስም እና ስልክ ያስገቡ።",
    enterAddress: "የአቅርቦት አድራሻ ያስገቡ።",
    enterTxn: "የግብይት መለያ እና የላኪ አካውንት ያስገቡ።",
    duplicateTxn: "ይህ የግብይት መለያ አስቀድሞ ጥቅም ላይ ውሏል።",
    orderError: "ትዕዛዝ ማስገባት አልተሳካም። እንደገና ይሞክሩ።",
    popularProducts: "ተወዳጅ", newArrivals: "አዲስ የመጡ",
    noProductsMatch: "ምርቶች አልተገኙም።",
    onlyLeftPill: "የቀሩት {n} ብቻ",
    itemsCount: "እቃዎች",
    subtotalNote: "አቅርቦት በቼክአውት ላይ",
    findYourOrderTitle: "ትዕዛዝ ይከታተሉ",
    noOrdersFound: "ምንም ትዕዛዝ አልተገኘም።",
    trackOrderBtn: "አግኝ",
    viewScreenshot: "ቅጽበታዊ ገጽ እይታ ይመልከቱ →",
    alreadyTalking: "አስቀድመው ያናግሩናል?",
    chatRefreshNote: "ውይይቱ ከተሰወረ፣ በስልክ ቁጥርዎ ያግኙት።",
    findBtn: "አግኝ", noConversationFound: "ምንም ውይይት አልተገኘም።",
    yourNameField: "ስምዎ", describeIssueField: "ችግሩን ይግለጹ",
    screenshotOptField: "ቅጽበታዊ ገጽ (አማራጭ)",
    attached: "ተጨምሯል",
    productNotFound: "ምርቱ አልተገኘም።",
    orderNumber: "ትዕዛዝ", status: "ሁኔታ",
    paymentStatus: "ክፍያ",
    savePhoneNote: "ለመከታተል ስልክዎን ያስቀምጡ።",
    gotScreenshot: "የክፍያ ቅጽበታዊ ገጽ አለዎት?",
    sendScreenshotNote: "ለፈጣን ማረጋገጫ በዋትሳፕ/ቴሌግራም ከትዕዛዝ #{orderId} ጋር ይላኩ።",
    continueShopping: "ግዢዎን ይቀጥሉ",
    weWillVerify: "እናረጋግጣለን እና በቅርቡ እናረጋግጣለን።",
    step: "ደረጃ", next: "ቀጣይ", back: "ተመለስ",
    review: "ገምግም እና ክፈል",
    step1Title: "አቅርቦት", step2Title: "ዝርዝሮች እና ክፍያ", step3Title: "ገምግም",
    step1Desc: "አቅርቦት ወይም ማንሳት ይምረጡ።",
    step2Desc: "መረጃዎን ያስገቡ።",
    step3Desc: "ትዕዛዝ ያረጋግጡ።",
    returningCustomer: "ተመላሽ ደንበኛ? እኛ እንሞላለን።",
    enterPhoneToLoad: "የተቀመጠ መረጃ ለመጫን ስልክ ያስገቡ።",
    loadInfo: "ጫን", deliveryPerson: "አሽከርካሪ",
    accept: "ተቀበል", reject: "አልተቀበልም",
    sellerDashboard: "የሻጩ መቆጣጠሪያ",
    deliveryDashboard: "የአሽከርካሪ መቆጣጠሪያ",
    adminLogin: "የአስተዳዳሪ መግቢያ",
    username: "ስም", password: "የይለፍ ቃል", login: "ግባ",
    paymentTransfers: "የክፍያ ዝውውሮች",
    selectAdmin: "አስተዳዳሪ ምረጥ",
    messageToSend: "መልእክት",
    sendPaymentNotification: "ላክ",
    paymentTransfersDesc: "ስለ ክፍያ ዝውውር ለአስተዳዳሪ አሳውቅ።",
    markDelivered: "አድርሻለሁ", history: "ታሪክ",
    noHistory: "እስካሁን ምንም ታሪክ የለም።",
    active: "ንቁ", handToDelivery: "ለአሽከርካሪ ስጥ",
    selectDelivery: "አሽከርካሪ ምረጥ", ship: "ላክ",
    claim: "ጠይቅ", sellerAccept: "ትዕዛዝ ተቀበል",
    deliveryZones: "የአቅርቦት ዞኖች",
    zoneName: "ዞን", zoneFee: "ወጪ (ETB)", zoneEta: "ግምት",
    addZone: "ዞን ጨምር", saveZone: "አስቀምጥ",
    deleteZone: "ሰርዝ", noZones: "ምንም ዞኖች አልተዋቀሩም።",
    myProducts: "ምርቶቼ", allProducts: "ሁሉም ምርቶች",
    editProduct: "አርትዕ", restock: "ክምችት ጨምር",
    priceEdit: "ዋጋ", stockEdit: "ክምችት",
    descriptionEdit: "መግለጫ", weightEdit: "ክብደት",
    categoryAccess: "የምድብ መድረሻ",
    selectCategories: "ምድቦችን ምረጥ…",
    noCategoriesAvailable: "ምንም ምድቦች የሉም።",
    preparing: "እየተዘጋጀ", readyForDelivery: "ለማንሳት ዝግጁ",
    outForDelivery: "ለአቅርቦት ወጥቷል",
    giveToDelivery: "ለአሽከርካሪ ስጥ",
    acceptDelivery: "አቅርቦት ተቀበል",
    sellerPickupLocation: "የማንሳት ቦታ",
    pickupAddress: "የማንሳት አድራሻ",
    pickupPhone: "የማንሳት ስልክ",
    deliveryRoute: "መንገድ",
    openInMaps: "ካርታ ክፈት",
    seller: "ሻጭ", customer: "ደንበኛ",
    mapLink: "ካርታ",
    pendingSellerApproval: "በሻጭ እየተጠበቀ",
    acceptedBySeller: "በሻጭ ተቀባይነት አግኝቷል",
    driverAssigned: "አሽከርካሪ ተመድቧል",
    readyForPickup: "ለማንሳት ዝግጁ",
    outForDelivery: "ለአቅርቦት ወጥቷል",
    delivered: "አድርሻለሁ",
    rejected: "አልተቀበለም",
    orderPlaced: "ትዕዛዝ ተቀበለ",
    otpCode: "የማረጋገጫ ኮድ",
    enterOTP: "ኮድ አስገባ",
    uploadProof: "የአቅርቦት ፎቶ ይስቀሉ",
    verifyAndDeliver: "አረጋግጥ እና አድርስ",
    orderTimeline: "የትዕዛዝ ጊዜ",
    orderDetails: "የትዕዛዝ ዝርዝሮች",
    assignedDriver: "የተመደበው አሽከርካሪ",
    driverPhone: "የአሽከርካሪ ስልክ",
    verificationCode: "ኮድ",
    copy: "ቅዳ", copiedToClipboard: "ተቀድቷል!",
    noPendingOrders: "ምንም በመጠባበቅ ላይ ያሉ ትዕዛዞች የሉም።",
    noActiveOrders: "ምንም ንቁ ትዕዛዞች የሉም።",
    noAvailableOrders: "ምንም የሚገኙ ትዕዛዞች የሉም።",
    claimOrder: "ትዕዛዝ ጠይቅ",
    packagePickedUp: "ጥቅል ተሰብስቧል",
    markAsPickedUp: "ተሰብስቧል ምልክት አድርግ",
    darkMode: "ጨለማ ሁነታ",
    lightMode: "ብርሃን ሁነታ",
    logout: "ውጣ",
    ownerDashboard: "የባለቤቱ መቆጣጠሪያ",
    analytics: "ትንተና", products: "ምርቶች",
    categories: "ምድቦች", tickets: "ድጋፍ",
    settings: "ቅንብሮች", admins: "አስተዳዳሪዎች",
    zones: "ዞኖች", orders: "ትዕዛዞች",
    dashboard: "መቆጣጠሪያ",
    totalOrders: "ጠቅላላ ትዕዛዞች",
    totalRevenue: "ጠቅላላ ገቢ",
    activeOrders: "ንቁ",
    pendingOrders: "በመጠባበቅ ላይ",
    completedToday: "ዛሬ የተጠናቀቁ",
    refresh: "አድስ", loadMore: "ተጨማሪ ጫን",
    showing: "በማሳየት ላይ",
    filterByStatus: "በሁኔታ አጣራ",
    all: "ሁሉም", search: "ፈልግ",
    orderID: "የትዕዛዝ መለያ",
    customerName: "ደንበኛ",
    customerPhone: "ስልክ",
    address: "አድራሻ",
    items: "እቃዎች",
    actions: "ተግባራት",
    update: "አዘምን", cancel: "ሰርዝ",
    confirm: "አረጋግጥ",
    areYouSure: "እርግጠኛ ነዎት?",
    delete: "ሰርዝ", edit: "አርትዕ",
    save: "አስቀምጥ", close: "ዝጋ",
    addProduct: "ምርት ጨምር",
    productName: "ስም", category: "ምድብ",
    price: "ዋጋ", stock: "ክምችት",
    weight: "ክብደት",
    description: "መግለጫ",
    image: "ምስል",
    active: "ንቁ",
    inactive: "የተሰረዘ",
    add: "ጨምር",
    addCategory: "ምድብ ጨምር",
    parentCategory: "የወላጅ ምድብ",
    none: "ማንም",
    categoryName: "ስም",
    bannerImage: "ባነር",
    icon: "ምልክት",
    addAdmin: "አስተዳዳሪ ጨምር",
    role: "ሚና",
    owner: "ባለቤት",
    seller: "ሻጭ",
    delivery: "አቅርቦት",
    telegramID: "ቴሌግራም መለያ",
    vehicle: "ተሽከርካሪ",
    photoUrl: "የፎቶ አድራሻ",
    notifications: "ማስታወቂያዎች",
    sendNotification: "ላክ",
    markAllRead: "ሁሉንም እንደተነበበ ምልክት አድርግ",
    noNotifications: "ምንም ማስታወቂያዎች የሉም።",
    orderUpdated: "ትዕዛዝ ተዘምኗል",
    orderCreated: "ትዕዛዝ ተፈጥሯል",
    newOrder: "አዲስ ትዕዛዝ",
    orderAccepted: "ትዕዛዝ ተቀባይነት አግኝቷል",
    orderRejected: "ትዕዛዝ አልተቀበለም",
    driverClaimed: "አሽከርካሪ ጠይቋል",
    readyForPickup: "ለማንሳት ዝግጁ",
    outForDelivery: "ለአቅርቦት ወጥቷል",
    orderDelivered: "ትዕዛዝ አድርሻለሁ",
    paymentVerified: "ክፍያ ተረጋግጧል",
    viewOrder: "ትዕዛዝ ይመልከቱ",
    deliveryProof: "የአቅርቦት ማረጋገጫ",
    photoRequired: "ፎቶ ያስፈልጋል",
    otpRequired: "ኮድ ያስፈልጋል",
    invalidOTP: "ኮዱ ትክክል አይደለም",
    resendOTP: "ኮዱን እንደገና ላክ",
    generateOTP: "ኮድ አመንጭ",
    otpGenerated: "ኮድ ተፈጥሯል",
    autoRefresh: "ራስ-ሰር አድስ",
    refreshNow: "አሁን አድስ",
    lastUpdated: "የመጨረሻ ዝመና",
    connectionError: "የግንኙነት ስህተት። እንደገና እየሞከረ…",
    retry: "እንደገና ሞክር",
    noConnection: "የበይነመረብ ግንኙነት የለም",
    checkConnection: "ግንኙነትዎን ያረጋግጡ",
    timeoutError: "ጊዜው አልቋል። እባክዎ እንደገና ይሞክሩ።",
    sellerActions: "የሻጭ ተግባራት",
    deliveryActions: "የአሽከርካሪ ተግባራት",
    ownerActions: "የባለቤት ተግባራት",
    assignDriver: "አሽከርካሪ መድብ",
    manualAssign: "በእጅ መድብ",
    unassigned: "አልተመደበም",
    distance: "ርቀት",
    estimatedTime: "ግምት ጊዜ",
    navigation: "አቅጣጫ",
    googleMaps: "ጎግል ካርታ",
    openStreetMap: "ክፍት ካርታ",
    startNavigation: "አቅጣጫ ጀምር",
    routeDetails: "የመንገድ ዝርዝሮች",
    from: "ከ", to: "ወደ",
    estimated: "ግምት",
    minutes: "ደቂቃ",
    orderHistory: "የትዕዛዝ ታሪክ",
    dateRange: "የቀን ክልል",
    export: "ላክ",
    statistics: "ስታቲስቲክስ",
    revenue: "ገቢ",
    topProducts: "ከፍተኛ ምርቶች",
    topSellers: "ከፍተኛ ሻጮች",
    topDrivers: "ከፍተኛ አሽከርካሪዎች",
    performance: "አፈጻጸም",
    averageDeliveryTime: "አማካይ አቅርቦት",
    orderCount: "ትዕዛዞች",
    rating: "ደረጃ",
    viewDetails: "ዝርዝሮችን ይመልከቱ",
    backToList: "ወደ ዝርዝር ተመለስ",
    orderNotFound: "ትዕዛዝ አልተገኘም",
    invalidOrderID: "የትዕዛዝ መለያ ትክክል አይደለም",
    tryAgain: "እንደገና ሞክር",
    contactSupport: "ድጋፍ ያግኙ",
    somethingWentWrong: "ስህተት ተከስቷል",
    pleaseRetry: "እባክዎ እንደገና ይሞክሩ",
    sessionExpired: "ክፍለ ጊዜው አልቋል። እባክዎ እንደገና ይግቡ።",
    unauthorized: "ያልተፈቀደ መዳረሻ",
    forbidden: "መዳረሻ ተከልክሏል",
    loading: "በመጫን ላይ…",
    saving: "በማስቀመጥ ላይ…",
    uploading: "በመስቀል ላይ…",
    processing: "በማስኬድ ላይ…",
    pleaseWait: "እባክዎ ይጠብቁ…",
    success: "ተሳክቷል",
    error: "ስህተት",
    warning: "ማስጠንቀቂያ",
    info: "መረጃ",
    done: "ተጠናቋል",
    skip: "ዝለል",
    later: "በኋላ",
    notNow: "አሁን አይደለም",
    yes: "አዎ", no: "አይ",
    ok: "እሺ", gotIt: "ገባኝ",
    welcomeBack: "እንኳን ደህና መጡ",
    goodMorning: "እንደምን አደርክ",
    goodAfternoon: "እንደምን ዋልክ",
    goodEvening: "እንደምን አመሸህ",
    welcome: "እንኳን ደህና መጡ",
    today: "ዛሬ", yesterday: "ትላንት",
    tomorrow: "ነገ",
    justNow: "አሁን",
    minutesAgo: "ከ{n} ደቂቃ በፊት",
    hoursAgo: "ከ{n} ሰዓት በፊት",
    daysAgo: "ከ{n} ቀን በፊት",
    weeksAgo: "ከ{n} ሳምንት በፊት"
  }
};

function getLang() { try { return localStorage.getItem("dm_lang") || "en"; } catch { return "en"; } }
function setLang(l) { try { localStorage.setItem("dm_lang", l); } catch {} }
function useT(lang) { return (key) => (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS.en[key] || key; }
function fmt(s, v) { return Object.keys(v || {}).reduce((a, k) => a.replace("{" + k + "}", v[k]), s); }
function getTheme() { try { return localStorage.getItem("dm_theme") || "light"; } catch { return "light"; } }
function setTheme(t) { try { localStorage.setItem("dm_theme", t); document.documentElement.setAttribute("data-theme", t); } catch {} }

const LazyImage = memo(({ src, alt, style = {}, className = "" }) => {
  const [loaded, setLoaded] = useState(false);
  const normalizedSrc = useMemo(() => normalizeImageUrl(src), [src]);
  return (
    <div style={{ position: "relative", overflow: "hidden", ...style }} className={className}>
      {!loaded && <div className="skeleton" style={{ position: "absolute", inset: 0 }} />}
      <img src={normalizedSrc} alt={alt} loading="lazy" onLoad={() => setLoaded(true)} onError={() => setLoaded(true)}
        style={{ width: "100%", height: "100%", objectFit: "cover", opacity: loaded ? 1 : 0, transition: "opacity 0.4s ease" }} />
    </div>
  );
});

function viewToHash(v) {
  if (!v) return "";
  if (v.name === "home") return "";
  if (v.name === "category") return "category/" + v.categoryId;
  if (v.name === "product") return "product/" + v.productId;
  if (v.name === "cart") return "cart";
  if (v.name === "checkout") return "checkout";
  if (v.name === "track") return "track";
  if (v.name === "support") return "support";
  if (v.name === "ticket") return "ticket/" + v.ticketId;
  if (v.name === "admin") return "admin";
  if (v.name === "confirmation") return "confirmation/" + v.orderId;
  return "";
}
function hashToView(h, adminAccess = false) {
  const s = String(h || "").replace(/^#/, "");
  if (!s) return { name: "home" };
  if (s === "admin") return { name: "admin" };
  if (s === "cart") return { name: "cart" };
  if (s === "checkout") return { name: "checkout" };
  if (s === "track") return { name: "track" };
  if (s === "support") return { name: "support" };
  let m = s.match(/^category\/(.+)$/); if (m) return { name: "category", categoryId: m[1] };
  m = s.match(/^product\/(.+)$/); if (m) return { name: "product", productId: m[1] };
  m = s.match(/^ticket\/(.+)$/); if (m) return { name: "ticket", ticketId: m[1] };
  m = s.match(/^confirmation\/(.+)$/); if (m) return { name: "confirmation", orderId: m[1] };
  return { name: "home" };
}

const ToastContext = React.createContext();
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const showToast = useCallback((msg, type = "success", duration = 3000) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
  }, []);
  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <Icon name={t.type === "error" ? "AlertTriangle" : t.type === "warning" ? "AlertTriangle" : "CheckCircle2"} size={16} />
            {t.msg}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
function useToast() { return React.useContext(ToastContext); }


// ===== MAIN APP =====
function DessieShop() {
  const [theme, setThemeState] = useState(getTheme());
  const [adminAccess, setAdminAccess] = useState(() => { try { return sessionStorage.getItem('dm_adminAccess') === 'true'; } catch { return false; } });
  const [view, setViewRaw] = useState(() => hashToView(window.location.hash, adminAccess));
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [cart, setCart] = useState(() => { try { return JSON.parse(localStorage.getItem('dm_cart') || '[]'); } catch { return []; } });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [lang, setLangState] = useState(getLang());
  const [settings, setSettings] = useState({ mediumSurcharge: DEFAULT_MEDIUM_SURCHARGE, heavySurcharge: DEFAULT_HEAVY_SURCHARGE });
  const [adminToken, setAdminTokenState] = useState(() => { try { return localStorage.getItem('dm_adminToken') || null; } catch { return null; } });
  const [adminRole, setAdminRoleState] = useState(() => { try { return localStorage.getItem('dm_adminRole') || null; } catch { return null; } });
  const [deliveryZones, setDeliveryZones] = useState(DEFAULT_DELIVERY_ZONES);
  const [admins, setAdmins] = useState([]);
  const [orders, setOrders] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const showToast = useToast();

  const setAdminToken = useCallback((token) => {
    setAdminTokenState(token);
    try { if (token) localStorage.setItem('dm_adminToken', token); else localStorage.removeItem('dm_adminToken'); } catch(e) {}
  }, []);
  const setAdminRole = useCallback((role) => {
    setAdminRoleState(role);
    try { if (role) localStorage.setItem('dm_adminRole', role); else localStorage.removeItem('dm_adminRole'); } catch(e) {}
  }, []);

  const t = useT(lang);

  const changeTheme = useCallback((t) => { setThemeState(t); setTheme(t); }, []);
  const changeLang = useCallback((l) => { setLangState(l); setLang(l); }, []);

  const setView = useCallback((v) => {
    setViewRaw(v);
    const h = viewToHash(v);
    if (window.location.hash.replace(/^#/, "") !== h) window.location.hash = h;
  }, []);

  const grantAdminAccess = useCallback(() => {
    setAdminAccess(true);
    try { sessionStorage.setItem('dm_adminAccess', 'true'); } catch(e) {}
    setViewRaw({ name: "admin" });
    window.location.hash = "admin";
  }, []);

  const logoutAdmin = useCallback(() => {
    setAdminToken(null);
    setAdminRole(null);
    setAdminAccess(false);
    try { sessionStorage.removeItem('dm_adminAccess'); } catch(e) {}
    setView({ name: "home" });
  }, [setAdminToken, setAdminRole, setView]);

  useEffect(() => {
    try { localStorage.setItem('dm_cart', JSON.stringify(cart)); } catch(e) {}
  }, [cart]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  useEffect(() => {
    const onHashChange = () => setViewRaw(hashToView(window.location.hash, adminAccess));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [adminAccess]);

  useEffect(() => { setTheme(theme); }, [theme]);

  const refreshProducts = useCallback(async () => {
    const arr = await loadProducts(adminToken);
    setProducts(arr);
  }, [adminToken]);

  const refreshCategories = useCallback(async () => {
    const arr = await loadCategories();
    setCategories(arr);
  }, []);

  const refreshSettings = useCallback(async () => {
    const o = await loadSettings();
    setSettings(o);
  }, []);

  const refreshDeliveryZones = useCallback(async () => {
    const arr = await loadDeliveryZones();
    setDeliveryZones(arr);
  }, []);

  const refreshAdmins = useCallback(async () => {
    const a = await loadAdmins();
    setAdmins(a);
  }, []);

  const refreshOrders = useCallback(async () => {
    if (!adminToken) return;
    const l = await loadOrders(adminToken);
    setOrders(l);
    setLastRefresh(Date.now());
  }, [adminToken]);

  const refreshTickets = useCallback(async () => {
    if (!adminToken) return;
    const a = await loadTickets();
    setTickets(a);
  }, [adminToken]);

  useEffect(() => {
    Promise.all([refreshProducts(), refreshCategories(), refreshSettings(), refreshDeliveryZones()])
      .then(() => setLoading(false))
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!adminToken) return;
    refreshOrders();
    refreshTickets();
    refreshAdmins();
    const iv = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshOrders();
        refreshTickets();
      }
    }, 8000);
    return () => clearInterval(iv);
  }, [adminToken]);

  const addToCart = useCallback((id, qty = 1) => {
    setCart(p => {
      const e = p.find(c => c.id === id);
      if (e) return p.map(c => c.id === id ? { ...c, qty: c.qty + qty } : c);
      return [...p, { id, qty }];
    });
    showToast("Added to cart");
  }, [showToast]);

  const updateQty = useCallback((id, qty) => {
    setCart(p => p.map(c => c.id === id ? { ...c, qty } : c).filter(c => c.qty > 0));
  }, []);

  const removeFromCart = useCallback((id) => {
    setCart(p => p.filter(c => c.id !== id));
  }, []);

  const cartCount = cart.reduce((s, c) => s + c.qty, 0);
  const productMap = useMemo(() => Object.fromEntries(products.map(p => [p.id, p])), [products]);

  const nav = useMemo(() => ({
    home: () => setView({ name: "home" }),
    category: (id) => setView({ name: "category", categoryId: id }),
    product: (id) => setView({ name: "product", productId: id }),
    cart: () => setView({ name: "cart" }),
    checkout: () => setView({ name: "checkout" }),
    track: () => setView({ name: "track" }),
    support: () => setView({ name: "support" }),
    admin: () => { if (adminAccess) setView({ name: "admin" }); }
  }), [setView, adminAccess]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {!isOnline && (
        <div style={{ background: "#fef3c7", color: "#92400e", padding: "8px 16px", textAlign: "center", fontSize: 13, fontWeight: 600, position: "sticky", top: 0, zIndex: 200 }}>
          <Icon name="AlertTriangle" size={14} /> No internet connection. Some features may not work.
        </div>
      )}
      <Header cartCount={cartCount} nav={nav} lang={lang} changeLang={changeLang} theme={theme} changeTheme={changeTheme}
        adminToken={adminToken} adminRole={adminRole} logoutAdmin={logoutAdmin} grantAdminAccess={grantAdminAccess} t={t} />
      <div className="market-divider" />

      <main style={{ flex: 1, maxWidth: 900, margin: "0 auto", padding: "0 0 96px", width: "100%" }}>
        {loading ? <LoadingScreen t={t} />
        : loadError ? <ErrorScreen t={t} onRetry={() => window.location.reload()} />
        : view.name === "home" ? <HomeView products={products} categories={categories} nav={nav} t={t} />
        : view.name === "category" ? <CategoryView products={products} categories={categories} categoryId={view.categoryId} nav={nav} t={t} />
        : view.name === "product" ? <ProductView product={productMap[view.productId]} categories={categories} nav={nav} addToCart={addToCart} setCart={setCart} t={t} />
        : view.name === "cart" ? <CartView cart={cart} productMap={productMap} updateQty={updateQty} removeFromCart={removeFromCart} nav={nav} t={t} />
        : view.name === "checkout" ? <CheckoutView cart={cart} productMap={productMap} nav={nav} setCart={setCart} showToast={showToast} setView={setView} refreshProducts={refreshProducts} t={t} settings={settings} deliveryZones={deliveryZones} />
        : view.name === "confirmation" ? <ConfirmationView orderId={view.orderId} orderData={view.orderData} nav={nav} t={t} />
        : view.name === "track" ? <TrackView nav={nav} t={t} />
        : view.name === "support" ? <SupportView nav={nav} showToast={showToast} setView={setView} t={t} />
        : view.name === "ticket" ? <TicketChatView ticketId={view.ticketId} nav={nav} showToast={showToast} />
        : view.name === "admin" ? <AdminView nav={nav} products={products} refreshProducts={refreshProducts} categories={categories} refreshCategories={refreshCategories}
            showToast={showToast} settings={settings} refreshSettings={refreshSettings} adminToken={adminToken} setAdminToken={setAdminToken}
            adminRole={adminRole} setAdminRole={setAdminRole} logoutAdmin={logoutAdmin} t={t} deliveryZones={deliveryZones}
            refreshDeliveryZones={refreshDeliveryZones} orders={orders} refreshOrders={refreshOrders} tickets={tickets}
            refreshTickets={refreshTickets} admins={admins} refreshAdmins={refreshAdmins} lastRefresh={lastRefresh} />
        : null}
      </main>

      {view.name !== "admin" && <BottomNav view={view} nav={nav} cartCount={cartCount} t={t} />}
      <Footer nav={nav} t={t} />
    </div>
  );
}

// ===== LOADING & ERROR SCREENS =====
const LoadingScreen = memo(({ t }) => (
  <div style={{ padding: 80, textAlign: "center" }}>
    <div className="spinner" style={{ width: 40, height: 40, margin: "0 auto 20px", borderWidth: 3 }} />
    <div style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{t("loading")}</div>
  </div>
));

const ErrorScreen = memo(({ t, onRetry }) => (
  <div style={{ padding: 60, textAlign: "center" }}>
    <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
    <div style={{ color: "var(--danger)", fontWeight: 700, fontSize: 16, marginBottom: 8 }}>{t("connectionError")}</div>
    <div style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 20 }}>{t("checkConnection")}</div>
    <button onClick={onRetry} className="btn btn-primary"><Icon name="RefreshCw" size={16} /> {t("retry")}</button>
  </div>
));

// ===== HEADER =====
const Header = memo(({ cartCount, nav, lang, changeLang, theme, changeTheme, adminToken, adminRole, logoutAdmin, grantAdminAccess, t }) => {
  const [tapCount, setTapCount] = useState(0);
  const tapTimer = useRef(null);

  const handleLogoTap = () => {
    setTapCount(c => {
      const n = c + 1;
      if (tapTimer.current) clearTimeout(tapTimer.current);
      if (n >= 5) { tapTimer.current = null; grantAdminAccess(); return 0; }
      tapTimer.current = setTimeout(() => setTapCount(0), 1500);
      return n;
    });
  };

  return (
    <header className="app-header">
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={handleLogoTap} style={{ background: "none", border: "none", padding: 0, display: "flex", cursor: "pointer" }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: "linear-gradient(135deg, #fbbf24, #f59e0b)", display: "flex", alignItems: "center", justifyContent: "center", color: "#14532d", fontWeight: 800, fontSize: 20, fontFamily: "var(--font-display)", boxShadow: "0 2px 8px rgba(245,158,11,0.4)" }}>D</div>
          </button>
          <button onClick={nav.home} style={{ background: "none", border: "none", color: "#fff", padding: 0, cursor: "pointer" }}>
            <span className="font-display" style={{ fontWeight: 700, fontSize: 22, letterSpacing: "-0.5px" }}>Dessie Mart</span>
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => changeTheme(theme === "light" ? "dark" : "light")} className="btn btn-sm" style={{ background: "rgba(255,255,255,0.12)", color: "#fff", border: "none", borderRadius: 10, padding: "8px 10px", minHeight: 36 }}>
            <Icon name={theme === "light" ? "Moon" : "Sun"} size={16} />
          </button>
          <button onClick={() => changeLang(lang === "en" ? "am" : "en")} className="btn btn-sm" style={{ background: "rgba(255,255,255,0.12)", color: "#fff", border: "none", borderRadius: 10, padding: "8px 12px", minHeight: 36, fontWeight: 700, fontSize: 12 }}>
            <Icon name="Globe" size={14} /> {lang === "en" ? "አማ" : "EN"}
          </button>
          {adminToken && (
            <button onClick={logoutAdmin} className="btn btn-sm" style={{ background: "rgba(255,255,255,0.12)", color: "#fff", border: "none", borderRadius: 10, padding: "8px 12px", minHeight: 36, fontSize: 12, fontWeight: 600 }}>
              <Icon name="LogOut" size={13} /> <span className="hidden md:flex">{t("logout")}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
});

// ===== BOTTOM NAV =====
const BottomNav = memo(({ view, nav, cartCount, t }) => {
  const items = [
    { id: "home", label: t("home"), icon: "Home", onClick: nav.home },
    { id: "track", label: t("trackOrder"), icon: "Truck", onClick: nav.track },
    { id: "support", label: t("support"), icon: "LifeBuoy", onClick: nav.support },
    { id: "cart", label: t("cart"), icon: "ShoppingCart", onClick: nav.cart, badge: cartCount }
  ];
  const activeId = view.name === "home" ? "home" : view.name === "track" ? "track" : (view.name === "support" || view.name === "ticket") ? "support" : view.name === "cart" ? "cart" : "";
  return (
    <nav className="bottom-nav">
      <div style={{ maxWidth: 900, margin: "0 auto", display: "flex" }}>
        {items.map(it => {
          const active = activeId === it.id;
          return (
            <button key={it.id} onClick={it.onClick} className={active ? "active" : ""}>
              <span className="nav-icon"><Icon name={it.icon} size={22} /></span>
              {it.badge > 0 && <span style={{ position: "absolute", top: 6, right: "20%", background: "var(--brand-gold)", color: "var(--brand-green-dark)", borderRadius: 999, fontSize: 11, fontWeight: 800, minWidth: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>{it.badge}</span>}
              <span style={{ fontSize: 11, fontWeight: active ? 700 : 500 }}>{it.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
});

// ===== FOOTER =====
const Footer = memo(({ nav, t }) => (
  <footer style={{ background: "var(--bg-secondary)", borderTop: "1px solid var(--border)", padding: "40px 16px 120px", marginTop: "auto" }}>
    <div style={{ maxWidth: 900, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 24 }}>
      <div>
        <div className="font-display" style={{ fontWeight: 800, fontSize: 20, color: "var(--brand-green)", marginBottom: 12 }}>Dessie Mart</div>
        <div style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.6 }}>Quality products, best prices, and fast delivery to your door in Dessie.</div>
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: "var(--text-primary)" }}>Quick Links</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={nav.home} style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 13, textAlign: "left", cursor: "pointer", padding: 0 }}>Home</button>
          <button onClick={nav.track} style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 13, textAlign: "left", cursor: "pointer", padding: 0 }}>Track Order</button>
          <button onClick={nav.support} style={{ background: "none", border: "none", color: "var(--text-secondary)", fontSize: 13, textAlign: "left", cursor: "pointer", padding: 0 }}>Support</button>
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: "var(--text-primary)" }}>Contact</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <a href={CONTACT.whatsapp} target="_blank" rel="noreferrer" style={{ color: "var(--text-secondary)", fontSize: 13, textDecoration: "none" }}>WhatsApp</a>
          <a href={CONTACT.telegram} target="_blank" rel="noreferrer" style={{ color: "var(--text-secondary)", fontSize: 13, textDecoration: "none" }}>Telegram</a>
          <a href={CONTACT.instagram} target="_blank" rel="noreferrer" style={{ color: "var(--text-secondary)", fontSize: 13, textDecoration: "none" }}>Instagram</a>
        </div>
      </div>
    </div>
    <div style={{ maxWidth: 900, margin: "24px auto 0", paddingTop: 20, borderTop: "1px solid var(--border)", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>
      © 2026 Dessie Mart. All rights reserved.
    </div>
  </footer>
));

// ===== HOME VIEW =====
const HomeView = memo(({ products, categories, nav, t }) => {
  const [query, setQuery] = useState("");
  const results = query.trim() ? products.filter(p => p.name && p.name.toLowerCase().includes(query.toLowerCase())) : [];
  const topCats = getChildren(categories, "");

  return (
    <div className="animate-fadeIn">
      <section style={{ padding: "32px 16px 24px", background: "var(--bg-header)", color: "#fff", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -50, right: -50, width: 200, height: 200, borderRadius: "50%", background: "rgba(255,255,255,0.05)", filter: "blur(40px)" }} />
        <div style={{ position: "absolute", bottom: -30, left: -30, width: 150, height: 150, borderRadius: "50%", background: "rgba(251,191,36,0.1)", filter: "blur(30px)" }} />
        <div style={{ maxWidth: 720, margin: "0 auto", position: "relative", zIndex: 1 }}>
          <h1 className="font-display" style={{ fontSize: 32, fontWeight: 800, lineHeight: 1.15, marginBottom: 8, letterSpacing: "-0.5px" }}>
            {t("tagline1")}<br/>{t("tagline2")}
          </h1>
          <p style={{ color: "rgba(255,255,255,0.8)", fontSize: 15, marginBottom: 20, maxWidth: 400 }}>{t("subtitle")}</p>

          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 14, top: 13, color: "var(--text-tertiary)", zIndex: 2 }}><Icon name="Search" size={18} /></span>
            <input
              value={query} onChange={e => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              style={{ width: "100%", padding: "13px 14px 13px 42px", borderRadius: 14, border: "none", fontSize: 15, background: "rgba(255,255,255,0.95)", color: "#0f172a", boxShadow: "0 4px 20px rgba(0,0,0,0.1)", outline: "none" }}
            />
            {query && (
              <button onClick={() => setQuery("")} style={{ position: "absolute", right: 12, top: 10, background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", padding: 4 }}>
                <Icon name="X" size={16} />
              </button>
            )}
          </div>

          {results.length > 0 && (
            <div className="card" style={{ marginTop: 12, padding: 0, overflow: "hidden", animation: "fadeIn 0.2s ease" }}>
              {results.slice(0, 6).map(p => (
                <button key={p.id} onClick={() => nav.product(p.id)} style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: "12px 16px", color: "var(--text-primary)", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border)", cursor: "pointer", fontSize: 14 }}>
                  <span style={{ fontWeight: 500 }}>{p.name}</span>
                  <span style={{ color: "var(--brand-gold-dark)", fontWeight: 700 }}>{etb(p.price)}</span>
                </button>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
            {[["Shield","Secure Payments"],["Truck","Fast Delivery"],["CheckCircle2","Trusted Seller"]].map(([icon,label]) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.1)", borderRadius: 999, padding: "7px 14px", fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.9)", backdropFilter: "blur(4px)" }}>
                <Icon name={icon} size={13} />{label}
              </div>
            ))}
          </div>
        </div>
      </section>

      <div style={{ padding: "24px 16px 8px" }}>
        <h2 className="font-display" style={{ fontSize: 20, fontWeight: 700, margin: "0 0 16px" }}>{t("shopByCategory")}</h2>
        <div className="grid grid-cols-2" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
          {topCats.map(c => {
            const count = countProductsInCategory(products, categories, c.id);
            return (
              <button key={c.id} onClick={() => nav.category(c.id)} className="category-card">
                <div className="icon-box">
                  {c.image ? <LazyImage src={c.image} alt={c.name} style={{ width: 48, height: 48, borderRadius: 12 }} /> : <Icon name="Package" size={22} />}
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>{count} {t("itemsCount")}</div>
                </div>
              </button>
            );
          })}
          {topCats.length === 0 && <div style={{ gridColumn: "1 / -1", textAlign: "center", color: "var(--text-tertiary)", fontSize: 14, padding: 30 }}>No categories yet.</div>}
        </div>
      </div>
    </div>
  );
});

// ===== PRODUCT CARD =====
const ProductCard = memo(({ product, categories, nav }) => {
  const low = product.stock < 5 && product.stock > 0;
  return (
    <div onClick={() => nav.product(product.id)} className="product-card">
      <div className="image-wrap">
        {product.image ? <img src={product.image} alt={product.name} loading="lazy" /> : <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--brand-green)", fontSize: 32 }}><Icon name="Package" size={32} /></div>}
        {product.stock === 0 && <div style={{ position: "absolute", top: 8, left: 8, background: "var(--danger)", color: "white", padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>Out of Stock</div>}
        {low && <div style={{ position: "absolute", top: 8, left: 8, background: "var(--warning)", color: "#451a03", padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>Only {product.stock} left</div>}
      </div>
      <div className="content">
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3, color: "var(--text-primary)" }}>{product.name}</div>
        <div className="price">{etb(product.price)}</div>
      </div>
    </div>
  );
});

// ===== CATEGORY VIEW =====
const CategoryView = memo(({ products, categories, categoryId, nav, t }) => {
  const cat = categories.find(c => c.id === categoryId);
  const children = getChildren(categories, categoryId);
  const parent = cat ? categories.find(c => c.id === cat.parentId) : null;
  const onBack = parent ? () => nav.category(parent.id) : nav.home;
  const [query, setQuery] = useState("");

  if (children.length > 0) {
    return (
      <div style={{ padding: 16 }} className="animate-fadeIn">
        <BackBar onBack={onBack} title={cat?.name || "Category"} />
        {cat?.banner && <div style={{ marginTop: 16, borderRadius: 16, overflow: "hidden", height: 140 }}><LazyImage src={cat.banner} alt={cat.name} style={{ width: "100%", height: "100%" }} /></div>}
        <div className="grid" style={{ marginTop: 16, gridTemplateColumns: "repeat(2, 1fr)" }}>
          {children.map(c => {
            const count = countProductsInCategory(products, categories, c.id);
            return (
              <button key={c.id} onClick={() => nav.category(c.id)} className="category-card">
                <div className="icon-box">{c.image ? <LazyImage src={c.image} alt={c.name} style={{ width: 48, height: 48, borderRadius: 12 }} /> : <Icon name="Package" size={22} />}</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>{count} items</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const items = products.filter(p => p.category === categoryId && p.name && p.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div style={{ padding: 16 }} className="animate-fadeIn">
      <BackBar onBack={onBack} title={cat?.name || "Category"} />
      {cat?.banner && <div style={{ marginTop: 16, borderRadius: 16, overflow: "hidden", height: 140 }}><LazyImage src={cat.banner} alt={cat.name} style={{ width: "100%", height: "100%" }} /></div>}
      <div style={{ marginTop: 16, position: "relative" }}>
        <span style={{ position: "absolute", left: 14, top: 13, color: "var(--text-tertiary)" }}><Icon name="Search" size={16} /></span>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="input" style={{ paddingLeft: 42 }} />
      </div>
      <div className="grid" style={{ marginTop: 16, gridTemplateColumns: "repeat(2, 1fr)" }}>
        {items.map(p => <ProductCard key={p.id} product={p} categories={categories} nav={nav} />)}
        {items.length === 0 && <div style={{ gridColumn: "1 / -1", textAlign: "center", color: "var(--text-tertiary)", fontSize: 14, padding: 40 }}>{t("noProductsMatch")}</div>}
      </div>
    </div>
  );
});

// ===== BACK BAR =====
const BackBar = memo(({ onBack, title }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
    <button onClick={onBack} className="btn btn-secondary btn-sm" style={{ padding: 10, minWidth: 40, minHeight: 40, borderRadius: 12 }}>
      <Icon name="ArrowLeft" size={18} />
    </button>
    <h2 className="font-display" style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{title}</h2>
  </div>
));

// ===== PRODUCT VIEW =====
const ProductView = memo(({ product, categories, nav, addToCart, setCart, t }) => {
  const [qty, setQty] = useState(1);
  if (!product) return <div style={{ padding: 24 }}><BackBar onBack={nav.home} title="Product" /><div className="empty-state"><div className="icon">📦</div>{t("productNotFound")}</div></div>;
  const cat = categories.find(c => c.id === product.category);
  const w = product.weight === "heavy" ? t("weightHeavy") : product.weight === "medium" ? t("weightMedium") : t("weightLight");

  function buyNow() { setCart([{ id: product.id, qty }]); nav.checkout(); }

  return (
    <div style={{ padding: 16 }} className="animate-fadeIn">
      <BackBar onBack={() => nav.category(product.category)} title={cat?.name || "Product"} />
      <div className="card" style={{ marginTop: 16, padding: 0, overflow: "hidden" }}>
        <div style={{ height: 280, background: product.image ? "var(--bg-primary)" : "var(--bg-secondary)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {product.image ? <img src={product.image} alt={product.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon name="Package" size={64} />}
        </div>
        <div style={{ padding: 20 }}>
          <h1 className="font-display" style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>{product.name}</h1>
          <div style={{ fontSize: 28, fontWeight: 800, color: "var(--brand-gold-dark)", marginBottom: 12 }}>{etb(product.price)}</div>
          <p style={{ color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>{product.description}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
            <span className="badge badge-green">{w}</span>
            <span className={`badge ${product.stock === 0 ? 'badge-red' : 'badge-gray'}`}>{product.stock === 0 ? t("outOfStockLabel") : `${product.stock} ${t("stockWord")}`}</span>
          </div>

          {product.stock > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>{t("quantity")}</span>
                <div style={{ display: "flex", alignItems: "center", border: "1.5px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                  <button onClick={() => setQty(q => Math.max(1, q - 1))} className="btn btn-ghost" style={{ minWidth: 44, minHeight: 44, borderRadius: 0, padding: "0 12px" }}><Icon name="Minus" size={14} /></button>
                  <span style={{ padding: "0 16px", fontWeight: 700, fontSize: 16, minWidth: 40, textAlign: "center" }}>{qty}</span>
                  <button onClick={() => setQty(q => Math.min(product.stock, q + 1))} className="btn btn-ghost" style={{ minWidth: 44, minHeight: 44, borderRadius: 0, padding: "0 12px" }}><Icon name="Plus" size={14} /></button>
                </div>
              </div>
              <button onClick={() => addToCart(product.id, qty)} className="btn btn-primary btn-lg" style={{ width: "100%", marginBottom: 10 }}>
                <Icon name="ShoppingCart" size={18} /> {t("addToCart")}
              </button>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={buyNow} className="btn btn-gold" style={{ flex: 1, fontSize: 15 }}>{t("buyNow")}</button>
                <button onClick={nav.cart} className="btn btn-secondary" style={{ flex: 1, fontSize: 15 }}>{t("goToCart")}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
});

// ===== CART VIEW =====
const CartView = memo(({ cart, productMap, updateQty, removeFromCart, nav, t }) => {
  const items = cart.map(c => ({ ...c, product: productMap[c.id] })).filter(c => c.product);
  const subtotal = items.reduce((s, c) => s + (Number(c.product.price) || 0) * c.qty, 0);

  return (
    <div style={{ padding: 16 }} className="animate-fadeIn">
      <BackBar onBack={nav.home} title={t("cart")} />
      {items.length === 0 ? (
        <div className="empty-state">
          <div className="icon"><Icon name="ShoppingCart" size={48} /></div>
          <div style={{ fontSize: 15, marginBottom: 16 }}>{t("emptyCart")}</div>
          <button onClick={nav.home} className="btn btn-primary">{t("startShopping")}</button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
            {items.map(c => (
              <div key={c.id} className="card" style={{ display: "flex", gap: 12, alignItems: "center", padding: 14 }}>
                {c.product?.image && <img src={c.product.image} alt="" style={{ width: 60, height: 60, borderRadius: 10, objectFit: "cover", flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.product.name}</div>
                  <div style={{ fontSize: 15, color: "var(--brand-gold-dark)", fontWeight: 700 }}>{etb(c.product.price)}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", border: "1.5px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                  <button onClick={() => updateQty(c.id, c.qty - 1)} className="btn btn-ghost btn-sm" style={{ borderRadius: 0, minWidth: 36, minHeight: 36, padding: "0 8px" }}><Icon name="Minus" size={12} /></button>
                  <span style={{ padding: "0 10px", fontWeight: 700, fontSize: 13, minWidth: 30, textAlign: "center" }}>{c.qty}</span>
                  <button onClick={() => updateQty(c.id, Math.min(c.product.stock, c.qty + 1))} className="btn btn-ghost btn-sm" style={{ borderRadius: 0, minWidth: 36, minHeight: 36, padding: "0 8px" }}><Icon name="Plus" size={12} /></button>
                </div>
                <button onClick={() => removeFromCart(c.id)} className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", minWidth: 36, minHeight: 36, padding: 0 }}>
                  <Icon name="Trash2" size={16} />
                </button>
              </div>
            ))}
          </div>
          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
              <span>{t("subtotal")}</span><span>{etb(subtotal)}</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{t("subtotalNote")}</div>
          </div>
          <button onClick={nav.checkout} className="btn btn-primary btn-lg" style={{ width: "100%", marginTop: 16 }}>
            {t("proceedCheckout")} — {etb(subtotal)}
          </button>
        </>
      )}
    </div>
  );
});

// ===== CHECKOUT VIEW =====
const CheckoutView = memo(({ cart, productMap, nav, setCart, showToast, setView, refreshProducts, t, settings, deliveryZones }) => {
  const zones = deliveryZones && deliveryZones.length > 0 ? deliveryZones : DEFAULT_DELIVERY_ZONES;
  const paymentMethods = (settings && Array.isArray(settings.paymentMethods) && settings.paymentMethods.length > 0)
    ? settings.paymentMethods
    : DEFAULT_PAYMENT_METHODS;
  const items = cart.map(c => ({ ...c, product: productMap[c.id] })).filter(c => c.product);
  const subtotal = items.reduce((s, c) => s + (Number(c.product.price) || 0) * c.qty, 0);
  const wc = items.reduce((a, c) => { const w = c.product.weight || "light"; a[w] = (a[w] || 0) + c.qty; return a; }, {});
  const mr = (settings && settings.mediumSurcharge) || DEFAULT_MEDIUM_SURCHARGE;
  const hr = (settings && settings.heavySurcharge) || DEFAULT_HEAVY_SURCHARGE;
  const mc = wc.medium || 0; const hc = wc.heavy || 0;
  const surcharge = mc * mr + hc * hr;
  const [step, setStep] = useState(1);
  const [fulfil, setFulfil] = useState("delivery");
  const [zoneId, setZoneId] = useState(zones[0] ? zones[0].id : "");
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [paymentId, setPaymentId] = useState(paymentMethods[0].id);
  const [txnId, setTxnId] = useState("");
  const [senderAccount, setSenderAccount] = useState("");
  const [screenshot, setScreenshot] = useState(null);
  const [uploadingShot, setUploadingShot] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const zone = zones.find(z => z.id === zoneId);
  const deliveryFee = fulfil === "pickup" ? 0 : (zone ? Number(zone.fee) || 0 : 0) + surcharge;
  const total = subtotal + deliveryFee;
  const payment = paymentMethods.find(m => m.id === paymentId);

  const [pickupLocations, setPickupLocations] = useState([]);
  const [pickupLocationId, setPickupLocationId] = useState("");

  useEffect(() => {
    loadPickupLocations().then(locs => {
      setPickupLocations(locs);
      if (locs && locs.length > 0) setPickupLocationId(locs[0].id);
    }).catch(() => {});
  }, []);

  const loadCustomerInfo = useCallback(async (pn) => {
    if (!pn.trim()) return;
    try {
      const o = await apiGet("trackOrder", { phone: normalizePhone(pn) });
      if (o && o.length > 0) {
        const l = o[0];
        if (l.customerName) setName(l.customerName);
        if (l.address) setAddress(l.address);
        showToast("Customer info loaded");
      }
    } catch(e) {}
  }, [showToast]);

  const phoneDebounce = useRef(null);
  useEffect(() => {
    if (phoneDebounce.current) clearTimeout(phoneDebounce.current);
    if (phone.trim().length >= 10) { phoneDebounce.current = setTimeout(() => loadCustomerInfo(phone), 600); }
    return () => clearTimeout(phoneDebounce.current);
  }, [phone, loadCustomerInfo]);

  function nextStep() {
    setError("");
    if (step === 1) {
      if (fulfil === "delivery" && !address.trim()) { setError(t("enterAddress")); return; }
      if (fulfil === "pickup" && !pickupLocationId) { setError("Please select a pickup location"); return; }
      setStep(2);
    } else if (step === 2) {
      if (!name.trim() || !phone.trim()) { setError(t("enterNamePhone")); return; }
      if (!txnId.trim() || !senderAccount.trim()) { setError(t("enterTxn")); return; }
      setStep(3);
    }
  }
  function prevStep() { setStep(step - 1); setError(""); }

  async function submitOrder() {
    setError("");
    setSubmitting(true);
    try {
      let su = "";
      if (screenshot) { setUploadingShot(true); try { su = (await smartUpload(screenshot)) || ""; } catch(e) {} setUploadingShot(false); }
      const op = {
        customerName: name.trim(),
        customerPhone: normalizePhone(phone),
        fulfilment: fulfil,
        zoneName: fulfil === "delivery" ? (zone ? zone.name : "") : "Pickup",
        zoneFee: fulfil === "delivery" ? (zone ? Number(zone.fee) || 0 : 0) : 0,
        eta: fulfil === "delivery" ? (zone ? zone.eta : "") : "Ready in 1–2 hrs",
        address: fulfil === "delivery" ? address.trim() : (pickupLocations.find(l => l.id === pickupLocationId)?.address || "Pickup location"),
        pickupLocationId: fulfil === "pickup" ? pickupLocationId : "",
        items: items.map(c => ({ id: c.product.id, name: c.product.name, price: c.product.price, qty: c.qty, weight: c.product.weight })),
        subtotal, surcharge, deliveryFee, total,
        paymentMethod: payment ? payment.name : "",
        txnId: txnId.trim(),
        senderAccount: senderAccount.trim(),
        paymentScreenshotUrl: su
      };
      const res = await apiPost("createOrder", { order: op });
      if (!res || !res.success || !res.id) {
        if (res && res.error === "Duplicate transaction ID") {
          // Almost certainly means an earlier attempt (e.g. one that looked like it
          // failed from a timeout) actually went through — recover into that order
          // instead of showing a scary duplicate error.
          try {
            const check = await apiGet("checkOrderByTxn", { txnId: txnId.trim() });
            if (check && check.id) {
              await refreshProducts();
              setCart([]);
              setView({ name: "confirmation", orderId: check.id });
              setSubmitting(false);
              return;
            }
          } catch(e3) {}
        }
        throw new Error((res && res.error) || "Order ID not returned");
      }
      await refreshProducts();
      setCart([]);
      setView({ name: "confirmation", orderId: res.id, orderData: res.order });
    } catch(e) {
      // The order may have actually been created on the backend even though we timed
      // out waiting for a response (Apps Script can be slow). Check before telling the
      // customer it failed.
      try {
        const check = await apiGet("checkOrderByTxn", { txnId: txnId.trim() });
        if (check && check.id) {
          await refreshProducts();
          setCart([]);
          setView({ name: "confirmation", orderId: check.id });
          setSubmitting(false);
          return;
        }
      } catch(e2) {}
      setError(e.message || t("orderError"));
    }
    setSubmitting(false);
  }

  if (items.length === 0) return (
    <div style={{ padding: 16 }} className="animate-fadeIn">
      <BackBar onBack={nav.cart} title={t("checkout")} />
      <div className="empty-state"><div className="icon"><Icon name="ShoppingCart" size={48} /></div><div>{t("emptyCart")}</div><button onClick={nav.home} className="btn btn-primary" style={{ marginTop: 16 }}>{t("startShopping")}</button></div>
    </div>
  );

  return (
    <div style={{ padding: 16 }} className="animate-fadeIn">
      <BackBar onBack={nav.cart} title={t("checkout")} />
      <div className="step-bar" style={{ justifyContent: "center", marginTop: 8 }}>
        {[1,2,3].map(s => (
          <React.Fragment key={s}>
            <div className={`step-dot ${s === step ? "active" : s < step ? "done" : ""}`}>{s < step ? "✓" : s}</div>
            {s < 3 && <div className={`step-line ${s < step ? "done" : ""}`}></div>}
          </React.Fragment>
        ))}
      </div>

      {step === 1 && (
        <>
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <Icon name="Truck" size={20} style={{ color: "var(--brand-green)" }} />
              <h3 className="font-display" style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{t("deliveryOrPickup")}</h3>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              {["delivery", "pickup"].map(f => (
                <button key={f} onClick={() => setFulfil(f)} style={{
                  flex: 1,
                  padding: "14px",
                  borderRadius: 12,
                  border: fulfil === f ? "2px solid var(--brand-green)" : "1.5px solid var(--border)",
                  background: fulfil === f ? "var(--brand-green-soft)" : "var(--bg-primary)",
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: "pointer",
                  transition: "all 0.2s",
                  color: "var(--text-primary)"
                }}>
                  <div style={{ fontSize: 22, marginBottom: 4 }}>{f === "delivery" ? "🚚" : "🏪"}</div>
                  {f === "delivery" ? t("delivery") : t("pickup")}
                </button>
              ))}
            </div>
            {fulfil === "delivery" ? (
              <div style={{ marginTop: 16 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>{t("deliveryZone")}</label>
                <select value={zoneId} onChange={e => setZoneId(e.target.value)} className="input">
                  {zones.map(z => <option key={z.id} value={z.id}>{z.name} — {etb(z.fee)} ({z.eta})</option>)}
                </select>
                <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", display: "block", marginTop: 14, marginBottom: 6 }}>{t("deliveryAddress")}</label>
                <input value={address} onChange={e => setAddress(e.target.value)} placeholder="e.g. near St. Gabriel Church" className="input" />
              </div>
            ) : (
              <div style={{ marginTop: 16 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>Pickup Location</label>
                <select value={pickupLocationId} onChange={e => setPickupLocationId(e.target.value)} className="input">
                  {pickupLocations.map(loc => (
                    <option key={loc.id} value={loc.id}>{loc.name} – {loc.address}</option>
                  ))}
                </select>
                {pickupLocations.length === 0 && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No pickup locations configured. Please contact support.</div>}
              </div>
            )}
            {(mc > 0 || hc > 0) && fulfil === "delivery" && (
              <div style={{ marginTop: 12, fontSize: 12, color: "var(--warning)", fontWeight: 500 }}>
                {mc > 0 && <div>{t("includesWord")} {mc} {t("weightMedium")} — +{etb(mc * mr)} {t("surchargeWord")}</div>}
                {hc > 0 && <div>{t("includesWord")} {hc} {t("weightHeavy")} — +{etb(hc * hr)} {t("surchargeWord")}</div>}
              </div>
            )}
          </div>
          <button onClick={nextStep} className="btn btn-primary btn-lg" style={{ width: "100%", marginTop: 16 }}>{t("next")}</button>
        </>
      )}

      {step === 2 && (
        <>
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <Icon name="User" size={20} style={{ color: "var(--brand-green)" }} />
              <h3 className="font-display" style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{t("yourDetails")}</h3>
            </div>
            <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>{t("fullName")}</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t("fullName")} className="input" />
            <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginTop: 14, marginBottom: 6 }}>{t("phoneNumber")}</label>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="09xxxxxxxx" className="input" />
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <Icon name="CreditCard" size={20} style={{ color: "var(--brand-green)" }} />
              <h3 className="font-display" style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{t("payment")}</h3>
            </div>

            <div style={{ background: "var(--brand-green-soft)", border: "1.5px solid var(--brand-green)", borderRadius: 12, padding: 14, marginBottom: 16, textAlign: "center" }}>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>{t("total")}</div>
              <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "var(--font-display)", color: "var(--brand-green-dark)" }}>{etb(total)}</div>
            </div>

            <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>{t("paymentMethod")}</label>
            <select value={paymentId} onChange={e => setPaymentId(e.target.value)} className="input">
              {paymentMethods.map(m => <option key={m.id} value={m.id}>{m.name} — {m.note}</option>)}
            </select>

            <div onClick={() => { if (payment) { navigator.clipboard.writeText(payment.account); showToast(t("copied")); }}}
              style={{ marginTop: 14, background: "var(--bg-secondary)", borderRadius: 12, padding: 16, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", border: "1.5px dashed var(--border)", transition: "all 0.2s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "var(--brand-green)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border)"}
            >
              <div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>{fmt(t("sendAmountTo"), { amount: etb(total) })}</div>
                <div style={{ fontWeight: 800, fontSize: 20, fontFamily: "var(--font-display)", letterSpacing: "1px" }}>{payment ? payment.account : ""}</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>{payment ? payment.name + " · " + payment.note : ""}</div>
              </div>
              <Icon name="Copy" size={20} style={{ color: "var(--brand-green)", flexShrink: 0 }} />
            </div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6, textAlign: "center" }}>{t("tapToCopy")}</div>

            <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginTop: 16, marginBottom: 6 }}>{t("transactionId")}</label>
            <input value={txnId} onChange={e => setTxnId(e.target.value)} placeholder="e.g. FT25196XXXXX" className="input" />
            <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginTop: 14, marginBottom: 6 }}>{t("senderAccount")}</label>
            <input value={senderAccount} onChange={e => setSenderAccount(e.target.value)} placeholder="Account used to pay" className="input" />
            <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginTop: 14, marginBottom: 6 }}>{t("screenshotOptional")}</label>
            <input type="file" accept="image/*" onChange={e => setScreenshot(e.target.files[0] || null)} className="input" style={{ padding: "10px" }} />
            {screenshot && <div style={{ fontSize: 12, color: "var(--success)", marginTop: 6, fontWeight: 500 }}><Icon name="CheckCircle2" size={14} /> {t("attached")}: {screenshot.name}</div>}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={prevStep} className="btn btn-secondary" style={{ flex: 1 }}>{t("back")}</button>
            <button onClick={nextStep} className="btn btn-primary" style={{ flex: 2 }}>{t("next")}</button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <Icon name="ClipboardList" size={20} style={{ color: "var(--brand-green)" }} />
              <h3 className="font-display" style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{t("orderSummary")}</h3>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "var(--text-secondary)" }}><span>{t("subtotal")}</span><span style={{ fontWeight: 600 }}>{etb(subtotal)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "var(--text-secondary)" }}><span>{fulfil === "pickup" ? t("pickupFeeLabel") : t("deliveryLocationFeeLabel")}</span><span style={{ fontWeight: 600 }}>{etb(fulfil === "pickup" ? 0 : (zone ? Number(zone.fee) || 0 : 0))}</span></div>
              {mc > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--text-secondary)" }}><span>{t("weightMedium")} surcharge ({mc})</span><span>{etb(mc * mr)}</span></div>}
              {hc > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--text-secondary)" }}><span>{t("weightHeavy")} surcharge ({hc})</span><span>{etb(hc * hr)}</span></div>}
              <div style={{ borderTop: "1.5px solid var(--border)", margin: "4px 0", paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 800, fontFamily: "var(--font-display)" }}>
                <span>{t("total")}</span><span style={{ color: "var(--brand-gold-dark)" }}>{etb(total)}</span>
              </div>
            </div>
            {surcharge > 0 && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 8 }}>{t("surchargeFixedNote")}</div>}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={prevStep} className="btn btn-secondary" style={{ flex: 1 }}>{t("back")}</button>
            <button onClick={submitOrder} disabled={submitting} className="btn btn-primary btn-lg" style={{ flex: 2 }}>
              {uploadingShot ? "Uploading…" : submitting ? t("placingOrder") : `${t("placeOrder")} — ${etb(total)}`}
            </button>
          </div>
        </>
      )}

      {error && <div style={{ background: "var(--danger-soft)", color: "var(--danger)", padding: 12, borderRadius: 12, fontSize: 13, marginTop: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}><Icon name="AlertTriangle" size={16} />{error}</div>}
    </div>
  );
});

// ===== CONFIRMATION VIEW =====
const ConfirmationView = memo(({ orderId, orderData, nav, t }) => {
  const [order, setOrder] = useState(orderData || null);
  const [loading, setLoading] = useState(!orderData);
  const [verificationCodes, setVerificationCodes] = useState([]);

  useEffect(() => {
    if (!orderId) { setLoading(false); return; }
    let cancelled = false;
    // trackOrder is the public, no-auth lookup — it's what customers can actually call.
    // We use it here (a) as the fallback when orderData wasn't passed (e.g. page reload),
    // and (b) always, to pick up each seller's pickup OTP, which the checkout response
    // doesn't include.
    apiGet("trackOrder", { orderId }).then(subs => {
      if (cancelled) return;
      const list = Array.isArray(subs) ? subs : [];
      const codes = list.map(s => ({ id: s.id, code: s.verificationCode })).filter(c => c.code);
      setVerificationCodes(codes);
      if (!orderData) {
        if (list.length === 0) { setLoading(false); return; }
        const allItems = list.reduce((acc, s) => acc.concat(safeParse(s.itemsJson) || []), []);
        const statuses = [...new Set(list.map(s => s.orderStatus))];
        setOrder({
          id: orderId,
          orderStatus: statuses.length === 1 ? statuses[0] : "Processing",
          paymentStatus: list[0].paymentStatus,
          subtotal: list.reduce((s, o) => s + (Number(o.subtotal) || 0), 0),
          deliveryFee: list.reduce((s, o) => s + (Number(o.deliveryFee) || 0), 0),
          total: list.reduce((s, o) => s + (Number(o.total) || 0), 0),
          paymentScreenshotUrl: list[0].paymentScreenshotUrl,
          items: allItems
        });
      }
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orderId, orderData]);

  if (loading) return <div style={{ padding: 60, textAlign: "center" }}><div className="spinner" style={{ width: 32, height: 32, margin: "0 auto 16px" }} /><div style={{ color: "var(--text-secondary)" }}>Loading order…</div></div>;
  if (!order) return <div style={{ padding: 24 }}><BackBar onBack={nav.home} title="Order" /><div className="empty-state">Order not found.</div></div>;

  return (
    <div style={{ padding: 16, textAlign: "center" }} className="animate-fadeIn">
      <div style={{ width: 72, height: 72, borderRadius: "50%", background: "var(--success-soft)", color: "var(--success)", display: "flex", alignItems: "center", justifyContent: "center", margin: "24px auto 16px", fontSize: 36 }}>
        <Icon name="CheckCircle2" size={36} />
      </div>
      <h2 className="font-display" style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}>{t("orderPlaced")}</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 24 }}>{t("weWillVerify")}</p>

      <div className="card" style={{ textAlign: "left", marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>{t("orderNumber")}</div>
            <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--font-display)", marginTop: 2 }}>{order.id}</div>
          </div>
          <StatusBadge status={order.orderStatus} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}><span style={{ color: "var(--text-secondary)" }}>{t("status")}</span><span style={{ fontWeight: 600 }}>{order.orderStatus}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}><span style={{ color: "var(--text-secondary)" }}>{t("paymentStatus")}</span><span style={{ fontWeight: 600 }}>{order.paymentStatus}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}><span style={{ color: "var(--text-secondary)" }}>{t("subtotal")}</span><span style={{ fontWeight: 600 }}>{etb(order.subtotal)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}><span style={{ color: "var(--text-secondary)" }}>{t("deliveryFee")}</span><span style={{ fontWeight: 600 }}>{etb(order.deliveryFee)}</span></div>
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 800, fontFamily: "var(--font-display)" }}>
            <span>{t("total")}</span><span style={{ color: "var(--brand-gold-dark)" }}>{etb(order.total)}</span>
          </div>
        </div>

        <div style={{ marginTop: 16, padding: 12, background: "var(--bg-secondary)", borderRadius: 10, fontSize: 12, color: "var(--text-tertiary)" }}>
          {t("savePhoneNote")}
        </div>
      </div>

      {verificationCodes.length > 0 && (
        <div className="card" style={{ textAlign: "left", marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>{t("verificationCode")}</div>
          {verificationCodes.map((c, i) => (
            <div key={c.id} className="otp-display" style={{ marginBottom: i < verificationCodes.length - 1 ? 10 : 0 }}>
              {c.code}
            </div>
          ))}
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 10 }}>
            {verificationCodes.length > 1
              ? "You'll need these codes to confirm delivery — one per seller in this order."
              : "You'll need this code to confirm delivery when it arrives."}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={nav.track} className="btn btn-primary" style={{ flex: 1 }}><Icon name="Truck" size={16} /> {t("trackOrder")}</button>
        <button onClick={nav.home} className="btn btn-secondary" style={{ flex: 1 }}>{t("continueShopping")}</button>
      </div>
    </div>
  );
});

// ===== TRACK VIEW =====
const TrackView = memo(({ nav, t }) => {
  const [phone, setPhone] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);

  async function search() {
    if (!phone.trim()) return;
    setSearching(true);
    try {
      const list = await trackOrderByPhone(phone);
      setResults(list);
    } catch(e) { setResults([]); }
    setSearching(false);
  }

  return (
    <div style={{ padding: 16 }} className="animate-fadeIn">
      <BackBar onBack={nav.home} title={t("trackOrder")} />
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <Icon name="Search" size={20} style={{ color: "var(--brand-green)" }} />
          <h3 className="font-display" style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{t("findYourOrderTitle")}</h3>
        </div>
        <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>{t("phoneUsed")}</label>
        <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="09xxxxxxxx" className="input" onKeyDown={e => e.key === "Enter" && search()} />
        <button onClick={search} disabled={!phone.trim() || searching} className="btn btn-primary" style={{ width: "100%", marginTop: 12 }}>
          {searching ? <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> {t("searching")}</> : <><Icon name="Search" size={16} /> {t("trackOrderBtn")}</>}
        </button>
      </div>

      {results && results.length === 0 && (
        <div className="empty-state"><div className="icon">📭</div><div>{t("noOrdersFound")}</div></div>
      )}
      {results && results.length > 0 && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {results.map(o => <TrackOrderCard key={o.id} order={o} t={t} />)}
        </div>
      )}
    </div>
  );
});

// ===== TRACK ORDER CARD =====
const TrackOrderCard = memo(({ order, t }) => {
  const [expanded, setExpanded] = useState(false);
  const items = order.items || [];
  const statusIndex = ORDER_STATUSES.indexOf(order.orderStatus);
  const isRejected = order.orderStatus === "Rejected";
  const isDelivered = order.orderStatus === "Delivered";

  const displayedSteps = ORDER_STATUSES.map((status, idx) => {
    const isCompleted = (idx < statusIndex) || (order.orderStatus === status);
    const isActive = (order.orderStatus === status);
    const isRejectedStatus = (status === "Rejected" && isRejected);
    return {
      label: t(status.replace(/ /g, "")) || status,
      status: isRejectedStatus ? "rejected" : (isCompleted ? "completed" : "pending"),
      active: isActive
    };
  }).slice(0, statusIndex + 1);

  if (isRejected && displayedSteps.length > 0) {
    displayedSteps[displayedSteps.length - 1].status = "rejected";
  }

  return (
    <div className="order-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>{t("orderNumber")}</div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-display)" }}>{order.id}</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>{formatDate(order.createdAt)}</div>
        </div>
        <StatusBadge status={order.orderStatus} />
      </div>

      <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
        {items.slice(0, 3).map(i => `${i.name} ×${i.qty}`).join(", ")}
        {items.length > 3 && ` +${items.length - 3} more`}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{order.zoneName}</span>
        <span style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-display)", color: "var(--brand-gold-dark)" }}>{etb(order.total)}</span>
      </div>

      <button onClick={() => setExpanded(!expanded)} style={{ width: "100%", background: "var(--bg-secondary)", border: "none", borderRadius: 10, padding: "10px", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <Icon name={expanded ? "Minus" : "Plus"} size={14} /> {expanded ? "Hide Timeline" : "Show Timeline"}
      </button>

      {expanded && (
        <div style={{ marginTop: 16 }}>
          <div className="timeline">
            {displayedSteps.map((step, i) => (
              <div key={i} className={`timeline-item ${step.status}`} style={{ paddingBottom: i < displayedSteps.length - 1 ? 20 : 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: step.status === "completed" ? "var(--text-primary)" : step.status === "rejected" ? "var(--danger)" : "var(--text-tertiary)" }}>{step.label}</div>
                {step.status === "completed" && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>Completed</div>}
              </div>
            ))}
          </div>

          {order.deliveryName && order.fulfilment !== "pickup" && (
            <div style={{ marginTop: 16, padding: 12, background: "var(--brand-green-soft)", borderRadius: 10, fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 4, color: "var(--brand-green)" }}><Icon name="Truck" size={14} /> {t("assignedDriver")}</div>
              <div style={{ color: "var(--text-secondary)" }}>{order.deliveryName}</div>
              {order.deliveryPhone && <div style={{ color: "var(--text-tertiary)", fontSize: 12 }}>{order.deliveryPhone}</div>}
            </div>
          )}

          {order.verificationCode && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>{t("verificationCode")}</div>
              <div className="otp-display" style={{ fontSize: 20, padding: "12px 16px" }}>{order.verificationCode}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const StatusBadge = memo(({ status }) => {
  const map = {
    "Pending Payment Verification": { cls: "badge-gray", icon: "Clock" },
    "Pending Seller Approval": { cls: "badge-gray", icon: "Clock" },
    "Accepted by Seller": { cls: "badge-blue", icon: "CheckCircle2" },
    "Driver Assigned": { cls: "badge-blue", icon: "Truck" },
    "Ready for Pickup": { cls: "badge-gold", icon: "Package" },
    "Out for Delivery": { cls: "badge-gold", icon: "Truck" },
    "Delivered": { cls: "badge-green", icon: "CheckCircle2" },
    "Rejected": { cls: "badge-red", icon: "X" },
  };
  const m = map[status] || map["Pending Payment Verification"];
  return <span className={`badge ${m.cls}`}><Icon name={m.icon} size={12} /> {status}</span>;
});

// ===== SUPPORT VIEW =====
const SupportView = memo(({ nav, showToast, setView, t }) => {
  const [category, setCategory] = useState(SUPPORT_CATEGORIES[0]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [txnId, setTxnId] = useState("");
  const [senderAccount, setSenderAccount] = useState("");
  const [deliveryLocation, setDeliveryLocation] = useState("");
  const [message, setMessage] = useState("");
  const [screenshot, setScreenshot] = useState(null);
  const [uploadingShot, setUploadingShot] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [contPhone, setContPhone] = useState("");
  const [contResults, setContResults] = useState(null);
  const [contSearching, setContSearching] = useState(false);
  const nf = category === "Unsuccessful Payment" || category === "Unsuccessful Delivery";
  const ndl = category === "Unsuccessful Delivery";

  async function findConversation() {
    if (!contPhone.trim()) return;
    setContSearching(true); setContResults(null);
    try { const r = await findTicketsByPhone(contPhone); setContResults(r); }
    catch(e) { setContResults([]); }
    setContSearching(false);
  }

  async function submit() {
    if (!name.trim() || !phone.trim()) return;
    setSubmitting(true);
    try {
      let su = "";
      if (screenshot) { setUploadingShot(true); try { su = (await smartUpload(screenshot)) || ""; } catch(e) {} setUploadingShot(false); }
      const res = await apiPost("createTicket", { ticket: {
        category,
        name: name.trim(),
        phone: normalizePhone(phone),
        txnId: txnId.trim(),
        senderAccount: senderAccount.trim(),
        deliveryLocation: deliveryLocation.trim(),
        message: message.trim(),
        screenshotUrl: su
      } });
      setSubmitted(true); showToast("Support request sent");
      if (res && res.id) setTimeout(() => setView({ name: "ticket", ticketId: res.id }), 1200);
    } catch(e) { showToast("Couldn't send — check connection", "error"); }
    setSubmitting(false);
  }

  if (submitted) return (
    <div style={{ padding: 16, textAlign: "center" }} className="animate-fadeIn">
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--success-soft)", color: "var(--success)", display: "flex", alignItems: "center", justifyContent: "center", margin: "32px auto 16px", fontSize: 32 }}><Icon name="CheckCircle2" size={32} /></div>
      <h3 className="font-display" style={{ fontSize: 20, fontWeight: 800 }}>We've got your message</h3>
      <p style={{ color: "var(--text-secondary)", fontSize: 14, marginTop: 8 }}>Taking you to your conversation…</p>
    </div>
  );

  return (
    <div style={{ padding: 16 }} className="animate-fadeIn">
      <BackBar onBack={nav.home} title={t("support")} />

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Icon name="MessageCircle" size={20} style={{ color: "var(--brand-green)" }} />
          <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{t("alreadyTalking")}</h3>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>{t("chatRefreshNote")}</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={contPhone} onChange={e => setContPhone(e.target.value)} placeholder="09xxxxxxxx" className="input" style={{ flex: 1 }} onKeyDown={e => e.key === "Enter" && findConversation()} />
          <button onClick={findConversation} disabled={!contPhone.trim() || contSearching} className="btn btn-primary btn-sm">
            {contSearching ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : t("findBtn")}
          </button>
        </div>
        {contResults && contResults.length === 0 && <div style={{ marginTop: 10, fontSize: 13, color: "var(--text-tertiary)" }}>{t("noConversationFound")}</div>}
        {contResults && contResults.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {contResults.map(tk => (
              <button key={tk.id} onClick={() => setView({ name: "ticket", ticketId: tk.id })} style={{ textAlign: "left", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", minHeight: 48 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{tk.category}</div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{tk.createdAt ? formatDate(tk.createdAt) : ""} · {tk.status}</div>
                </div>
                <Icon name="ArrowLeft" size={14} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <Icon name="LifeBuoy" size={20} style={{ color: "var(--brand-green)" }} />
          <h3 className="font-display" style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{t("whatsIssue")}</h3>
        </div>
        <select value={category} onChange={e => setCategory(e.target.value)} className="input" style={{ marginBottom: 12 }}>
          {SUPPORT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>{t("yourNameField")}</label>
        <input value={name} onChange={e => setName(e.target.value)} className="input" style={{ marginBottom: 12 }} />
        <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>Phone Number</label>
        <input value={phone} onChange={e => setPhone(e.target.value)} className="input" style={{ marginBottom: 12 }} />
        {nf && <><label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>{t("transactionId")}</label><input value={txnId} onChange={e => setTxnId(e.target.value)} className="input" style={{ marginBottom: 12 }} /></>}
        {nf && <><label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>{t("senderAccount")}</label><input value={senderAccount} onChange={e => setSenderAccount(e.target.value)} className="input" style={{ marginBottom: 12 }} /></>}
        {ndl && <><label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>Delivery Location</label><input value={deliveryLocation} onChange={e => setDeliveryLocation(e.target.value)} className="input" style={{ marginBottom: 12 }} /></>}
        <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>{t("describeIssueField")}</label>
        <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4} className="input" style={{ marginBottom: 12 }} />
        <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>{t("screenshotOptField")}</label>
        <input type="file" accept="image/*" onChange={e => setScreenshot(e.target.files[0] || null)} className="input" style={{ padding: "10px", marginBottom: 12 }} />
        {screenshot && <div style={{ fontSize: 12, color: "var(--success)", marginBottom: 12, fontWeight: 500 }}><Icon name="CheckCircle2" size={12} /> {t("attached")}: {screenshot.name}</div>}
        <button onClick={submit} disabled={!name.trim() || !phone.trim() || submitting} className="btn btn-primary btn-lg" style={{ width: "100%" }}>
          {uploadingShot ? "Uploading…" : submitting ? t("sending") : t("sendToOwner")}
        </button>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
        {[["MessageCircle","WhatsApp",CONTACT.whatsapp],["Send","Telegram",CONTACT.telegram],["Instagram","Instagram",CONTACT.instagram],["Mail","Email",`mailto:${CONTACT.email}`],["Smartphone","TikTok",CONTACT.tiktok]].map(([icon,label,url]) => (
          <a key={label} href={url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm" style={{ textDecoration: "none", fontSize: 12 }}>
            <Icon name={icon} size={14} />{label}
          </a>
        ))}
      </div>
    </div>
  );
});

// ===== TICKET CHAT VIEW =====
const TicketChatView = memo(({ ticketId, nav, showToast }) => {
  const [ticket, setTicket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  async function lt() { try { const a = await loadTickets(); const f = a.find(tk => tk.id === ticketId); if (f) setTicket(f); } catch(e) {} }
  async function lm() { try { const m = await loadTicketMessages(ticketId); setMessages(m); } catch(e) {} }

  useEffect(() => { lt(); lm(); const i = setInterval(lm, 5000); return () => clearInterval(i); }, [ticketId]);
  useEffect(() => { if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  async function send() {
    if (!text.trim()) return;
    setSending(true);
    try { await apiPost("sendMessage", { ticketId, sender: "customer", message: text.trim() }); setText(""); await lm(); }
    catch(e) { showToast("Failed to send", "error"); }
    setSending(false);
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", height: "calc(100vh - 120px)" }} className="animate-fadeIn">
      <BackBar onBack={nav.home} title="Conversation" />
      {ticket && <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>{ticket.category} · Ticket {ticketId}</div>}
      <div style={{ flex: 1, background: "var(--bg-secondary)", borderRadius: 16, padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, marginTop: 8, border: "1px solid var(--border)" }}>
        {messages.length === 0 ? <div className="empty-state" style={{ padding: 40 }}><div className="icon">💬</div><div>No messages yet.</div></div>
          : messages.map((m, i) => <div key={i} className={`chat-bubble ${m.sender}`}>{m.message}</div>)}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Type a message…" className="input" style={{ flex: 1 }} onKeyDown={e => e.key === "Enter" && send()} />
        <button onClick={send} disabled={sending || !text.trim()} className="btn btn-primary" style={{ minWidth: 48, padding: "0 16px" }}><Icon name="Send" size={16} /></button>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-tertiary)", textAlign: "center" }}>Bookmark this page to continue anytime.</div>
    </div>
  );
});

// ===== ADMIN VIEW =====
const AdminView = memo(({ nav, products, refreshProducts, categories, refreshCategories, showToast, settings, refreshSettings, adminToken, setAdminToken, adminRole, setAdminRole, logoutAdmin, t, deliveryZones, refreshDeliveryZones, orders, refreshOrders, tickets, refreshTickets, admins, refreshAdmins, lastRefresh }) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [tab, setTab] = useState("orders");
  const [isLoggedIn, setIsLoggedIn] = useState(!!adminToken);

  useEffect(() => { if (adminToken) { setIsLoggedIn(true); refreshOrders(); refreshTickets(); refreshAdmins(); } else setIsLoggedIn(false); }, [adminToken]);

  async function tryLogin() {
    if (!username.trim() || !password.trim() || loggingIn) return;
    setLoginError(""); setLoggingIn(true);
    try {
      const r = await apiPost("adminLogin", { username: username.trim(), password: password.trim() });
      if (r && r.success) { setAdminToken(r.adminId); setAdminRole(r.role); setIsLoggedIn(true); showToast(`Logged in as ${r.role}`); }
      else setLoginError("Invalid username or password.");
    } catch(e) { setLoginError("Couldn't reach the server."); }
    setLoggingIn(false);
  }

  if (!isLoggedIn) return (
    <div style={{ padding: 16, maxWidth: 420, margin: "0 auto" }} className="animate-fadeIn">
      <BackBar onBack={nav.home} title={t("adminLogin")} />
      <div className="card" style={{ marginTop: 24 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: "var(--brand-green-soft)", color: "var(--brand-green)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 28 }}><Icon name="Lock" size={28} /></div>
          <h2 className="font-display" style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>{t("adminLogin")}</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Access your dashboard</p>
        </div>
        <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>{t("username")}</label>
        <input type="text" value={username} onChange={e => setUsername(e.target.value)} className="input" style={{ marginBottom: 14 }} />
        <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>{t("password")}</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && tryLogin()} className="input" style={{ marginBottom: 16 }} />
        {loginError && <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}><Icon name="AlertTriangle" size={14} />{loginError}</div>}
        <button onClick={tryLogin} disabled={loggingIn || !username.trim() || !password.trim()} className="btn btn-primary btn-lg" style={{ width: "100%" }}>
          {loggingIn ? <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Logging in…</> : <><Icon name="Lock" size={16} /> {t("login")}</>}
        </button>
      </div>
    </div>
  );

  if (adminRole === "delivery") return <DeliveryDashboard nav={nav} orders={orders} refreshOrders={refreshOrders} showToast={showToast} t={t} adminToken={adminToken} admins={admins} />;
  if (adminRole === "seller") return <SellerDashboard nav={nav} orders={orders} refreshOrders={refreshOrders} showToast={showToast} t={t} adminToken={adminToken} />;

  const tabs = [
    ["orders", "Orders", "ClipboardList"], ["products", "Products", "Package"],
    ["categories", "Categories", "Home"], ["tickets", "Support", "LifeBuoy"],
    ["analytics", "Analytics", "BarChart3"], ["settings", "Settings", "Settings"],
    ["admins", "Admins", "Shield"], ["zones", "Zones", "MapPin"]
  ];

  return (
    <div className="animate-fadeIn">
      <div style={{ padding: 16 }}>
        <BackBar onBack={nav.home} title={t("ownerDashboard")} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Last updated: {timeAgo(new Date(lastRefresh).toISOString())}</span>
          <button onClick={() => { refreshOrders(); refreshTickets(); refreshAdmins(); showToast("Refreshed"); }} className="btn btn-ghost btn-sm" style={{ padding: "4px 8px", minHeight: 28 }}>
            <Icon name="RefreshCw" size={12} />
          </button>
        </div>
        <div className="tab-bar scrollhide" style={{ marginTop: 12 }}>
          {tabs.map(([id, label, icon]) => (
            <button key={id} onClick={() => setTab(id)} className={`tab-btn ${tab === id ? "active" : ""}`}>
              <Icon name={icon} size={13} /> {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "0 16px 40px" }}>
        {tab === "orders" && <OwnerOrders orders={orders} refreshOrders={refreshOrders} showToast={showToast} t={t} admins={admins} adminToken={adminToken} />}
        {tab === "products" && <OwnerProducts products={products} refreshProducts={refreshProducts} categories={categories} admins={admins} showToast={showToast} t={t} />}
        {tab === "categories" && <OwnerCategories categories={categories} refreshCategories={refreshCategories} showToast={showToast} t={t} />}
        {tab === "tickets" && <OwnerTickets tickets={tickets} refreshTickets={refreshTickets} showToast={showToast} t={t} />}
        {tab === "analytics" && <OwnerAnalytics orders={orders} products={products} t={t} />}
        {tab === "settings" && <OwnerSettings settings={settings} refreshSettings={refreshSettings} showToast={showToast} t={t} />}
        {tab === "admins" && <OwnerAdmins admins={admins} refreshAdmins={refreshAdmins} showToast={showToast} t={t} categories={categories} />}
        {tab === "zones" && <OwnerZones deliveryZones={deliveryZones} refreshDeliveryZones={refreshDeliveryZones} showToast={showToast} t={t} />}
      </div>
    </div>
  );
});

// ===== SELLER DASHBOARD =====
const SellerDashboard = memo(({ nav, orders, refreshOrders, showToast, t, adminToken }) => {
  const [tab, setTab] = useState("pending");
  const [handoverOTP, setHandoverOTP] = useState({});
  const pending = orders.filter(o => o.orderStatus === "Pending Seller Approval");
  const accepted = orders.filter(o => o.orderStatus === "Accepted by Seller" || o.orderStatus === "Driver Assigned");
  const history = orders.filter(o => ["Ready for Pickup", "Out for Delivery", "Delivered", "Rejected"].includes(o.orderStatus));

  const handleAccept = async (id) => {
    try { await apiPost("sellerAcceptOrder", { orderId: id, token: adminToken }); refreshOrders(); showToast("Order accepted"); }
    catch(e) { showToast("Failed to accept", "error"); }
  };
  const handleReject = async (id) => {
    try { await apiPost("sellerRejectOrder", { orderId: id, token: adminToken }); refreshOrders(); showToast("Order rejected"); }
    catch(e) { showToast("Failed to reject", "error"); }
  };
  const handleGive = async (id) => {
    const otp = handoverOTP[id];
    if (!otp || !otp.trim()) { showToast("Enter the OTP from the delivery driver", "warning"); return; }
    try { 
      await apiPost("sellerGiveToDelivery", { orderId: id, token: adminToken, otp }); 
      refreshOrders(); 
      showToast("Handed to delivery — moved to history"); 
      setHandoverOTP(prev => ({ ...prev, [id]: "" }));
    }
    catch(e) { showToast("Failed: " + (e.message || "Invalid OTP"), "error"); }
  };

  return (
    <div style={{ padding: 16 }} className="animate-fadeIn">
      <BackBar onBack={nav.home} title={t("sellerDashboard")} />
      <div className="tab-bar scrollhide" style={{ marginTop: 12 }}>
        {[["pending","Pending"],["accepted","Accepted"],["history","History"]].map(([s,label]) => (
          <button key={s} onClick={() => setTab(s)} className={`tab-btn ${tab===s?"active":""}`}>{label}</button>
        ))}
      </div>
      {tab === "pending" && <OrderList orders={pending} empty={t("noPendingOrders")} actions={[
        { label: t("accept"), handler: handleAccept, style: { background: "var(--success)", color: "white" } },
        { label: t("reject"), handler: handleReject, style: { background: "var(--danger)", color: "white" } }
      ]} t={t} showOTP={false} />}
      {tab === "accepted" && <OrderList orders={accepted} empty="No accepted orders." actions={[
        { label: t("handToDelivery"), handler: handleGive, style: { background: "var(--brand-gold)", color: "var(--brand-green-dark)" }, otpInput: true, otpState: handoverOTP, setOtp: setHandoverOTP }
      ]} t={t} showOTP={true} />}
      {tab === "history" && <OrderList orders={history} empty={t("noHistory")} t={t} showOTP={false} />}
    </div>
  );
});

// ===== DELIVERY DASHBOARD =====
const DeliveryDashboard = memo(({ nav, orders, refreshOrders, showToast, t, adminToken, admins }) => {
  const [tab, setTab] = useState("available");
  const currentAdmin = admins.find(a => a.AdminID === adminToken);
  const currentDeliveryName = currentAdmin ? currentAdmin.Name : "";

  const available = orders.filter(o => o.orderStatus === "Accepted by Seller" && (!o.deliveryName || String(o.deliveryName).trim() === ""));
  const active = orders.filter(o => ["Driver Assigned", "Ready for Pickup", "Out for Delivery"].includes(o.orderStatus) && o.deliveryName === currentDeliveryName);
  const history = orders.filter(o => ["Delivered", "Rejected"].includes(o.orderStatus) && o.deliveryName === currentDeliveryName);

  const handleClaim = async (id) => {
    try { await apiPost("deliveryClaimOrder", { orderId: id, token: adminToken }); refreshOrders(); showToast("Order claimed"); }
    catch(e) { showToast("Failed to claim: " + (e.message || ""), "error"); }
  };
  const handlePickup = async (id) => {
    try { await apiPost("deliveryPickupSub", { orderId: id, token: adminToken }); refreshOrders(); showToast("Marked as picked up / out for delivery"); }
    catch(e) { showToast("Failed", "error"); }
  };
  const handleDeliver = async (id, otp, proofUrl) => {
    try { await apiPost("deliveryDeliver", { orderId: id, token: adminToken, otp, proofUrl }); refreshOrders(); showToast("Order delivered!"); }
    catch(e) { showToast("Failed to deliver: " + (e.message || ""), "error"); }
  };

  return (
    <div style={{ padding: 16 }} className="animate-fadeIn">
      <BackBar onBack={nav.home} title={t("deliveryDashboard")} />
      <div className="tab-bar scrollhide" style={{ marginTop: 12 }}>
        <button onClick={() => setTab("available")} className={`tab-btn ${tab==="available"?"active":""}`}>Available</button>
        <button onClick={() => setTab("active")} className={`tab-btn ${tab==="active"?"active":""}`}>Active</button>
        <button onClick={() => setTab("history")} className={`tab-btn ${tab==="history"?"active":""}`}>History</button>
      </div>
      {tab === "available" && <DeliveryOrderList orders={available} allOrders={orders} empty={t("noAvailableOrders")} t={t} showClaimBtn handleClaim={handleClaim} showToast={showToast} />}
      {tab === "active" && <DeliveryOrderList orders={active} allOrders={orders} empty={t("noActiveOrders")} t={t} showProductDetails showRoute handlePickup={handlePickup} handleDeliver={handleDeliver} admins={admins} showToast={showToast} />}
      {tab === "history" && <DeliveryOrderList orders={history} allOrders={orders} empty={t("noHistory")} t={t} showToast={showToast} />}
    </div>
  );
});

// ===== ORDER LIST =====
const OrderList = memo(({ orders, empty, actions, t, showOTP }) => {
  if (!orders.length) return <div className="empty-state"><div className="icon">📋</div><div>{empty}</div></div>;
  return <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>{orders.map(o => (
    <div key={o.id} className="order-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 600, textTransform: "uppercase" }}>Order</div>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "var(--font-display)" }}>{o.id}</div>
        </div>
        <StatusBadge status={o.orderStatus} />
      </div>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4 }}>{o.customerName} · {o.customerPhone}</div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>{(o.items||[]).map(i=>`${i.name} ×${i.qty}`).join(", ")}</div>
      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-display)", color: "var(--brand-gold-dark)" }}>
        Your Earnings (90%): {etb(o.sellerAmount || Math.round((o.subtotal || o.total || 0) * 0.9))}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>Order total: {etb(o.total)}</div>
      {o.deliveryName && <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}><Icon name="Truck" size={12} /> Driver: {o.deliveryName}</div>}
      {showOTP && o.verificationCode && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, textTransform: "uppercase", marginBottom: 4 }}>{t("verificationCode")}</div>
          <div className="otp-display" style={{ fontSize: 18, padding: "10px 16px" }}>{o.verificationCode}</div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>Give this OTP to the delivery driver for pickup verification</div>
        </div>
      )}
      {actions && actions.map((act, i) => (
        <div key={i} style={{ marginTop: i > 0 ? 6 : 0 }}>
          {act.otpInput && (
            <input 
              value={act.otpState[o.id] || ""} 
              onChange={e => act.setOtp(prev => ({ ...prev, [o.id]: e.target.value }))}
              placeholder="Enter delivery OTP" 
              className="input" 
              style={{ marginBottom: 8, fontSize: 14 }}
            />
          )}
          <button onClick={() => act.handler(o.id)} className="btn" style={{ width: "100%", ...act.style }}>{act.label}</button>
        </div>
      ))}
    </div>
  ))}</div>;
});

// ===== DELIVERY ORDER CARD =====
const DeliveryOrderCard = memo(({ o, allOrders, t, showClaimBtn, handleClaim, showProductDetails, showRoute, handlePickup, handleDeliver, admins, showToast }) => {
  // The order shown here is the parent — the real seller/OTP info lives on its
  // sub-orders (one per seller). Reading o.sellerId/o.verificationCode directly (the
  // old approach) always came up blank on the parent, which is why this always showed
  // "Unknown location" and no OTP.
  const subOrders = (allOrders || []).filter(s => s.parentOrderId === o.id);
  const pickups = subOrders.map(sub => {
    const seller = (sub.sellerId && admins) ? admins.find(a => a.AdminID === sub.sellerId) : null;
    return {
      subId: sub.id,
      name: seller ? (seller.Name || "Unknown seller") : "Unassigned seller",
      address: seller ? (seller.PickupAddress || "No address set") : "Not set",
      phone: seller ? (seller.PickupPhone || "") : "",
      otp: sub.verificationCode || ""
    };
  });
  const firstAddr = pickups[0]?.address || "Not set";
  const mapsLink = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(firstAddr)}&destination=${encodeURIComponent(o.address)}&travelmode=driving`;
  const [otpInput, setOtpInput] = useState("");
  const [proofFile, setProofFile] = useState(null);
  const [delivering, setDelivering] = useState(false);
  const [pickingUp, setPickingUp] = useState(false);
  const driverEarnings = o.driverAmount || Math.round((o.deliveryFee || o.zoneFee || 0) * 0.7);

  async function doDeliver() {
    if (!otpInput.trim()) { showToast?.("Enter the customer OTP", "warning"); return; }
    setDelivering(true);
    let proofUrl = "";
    if (proofFile) { try { proofUrl = await smartUpload(proofFile); } catch(e) {} }
    await handleDeliver(o.id, otpInput, proofUrl);
    setDelivering(false);
  }

  async function doPickup() {
    setPickingUp(true);
    await handlePickup(o.id);
    setPickingUp(false);
  }

  return (
    <div className="order-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 600, textTransform: "uppercase" }}>Order</div>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "var(--font-display)" }}>{o.id}</div>
        </div>
        <StatusBadge status={o.orderStatus} />
      </div>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4 }}>{o.customerName} · {o.customerPhone}</div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 4 }}>{o.address}</div>

      {showProductDetails && (
        <div style={{ marginTop: 10, padding: 10, background: "var(--bg-secondary)", borderRadius: 10 }}>
          {(o.items||[]).map((item, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: i < (o.items||[]).length - 1 ? 8 : 0 }}>
              {item.image && <img src={item.image} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover" }} />}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{item.name}</div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{item.qty} × {etb(item.price)} · {item.weight}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showRoute && pickups.length > 0 && (
        <div style={{ marginTop: 10, padding: 12, background: "var(--bg-secondary)", borderRadius: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: "var(--text-primary)" }}><Icon name="Navigation" size={14} /> {t("deliveryRoute")} {pickups.length > 1 && `(${pickups.length} sellers)`}</div>
          {pickups.map((p, i) => (
            <div key={p.subId} style={{ marginBottom: i < pickups.length - 1 ? 10 : 8, paddingBottom: i < pickups.length - 1 ? 10 : 0, borderBottom: i < pickups.length - 1 ? "1px solid var(--border)" : "none" }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</div>
              <div style={{ fontSize: 12 }}>{p.address}</div>
              {p.phone && <div style={{ fontSize: 12 }}><a href={`tel:${p.phone}`} style={{ color: "var(--brand-green)" }}>{p.phone}</a></div>}
              {p.otp && (o.orderStatus === "Driver Assigned" || o.orderStatus === "Ready for Pickup") && (
                <div style={{ marginTop: 6 }}>
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase" }}>Give this OTP to {p.name}: </span>
                  <span className="otp-display" style={{ fontSize: 15, padding: "4px 10px", display: "inline-block", marginLeft: 4 }}>{p.otp}</span>
                </div>
              )}
            </div>
          ))}
          <div style={{ fontSize: 12, marginBottom: 8 }}><strong>{t("to")}:</strong> {o.address}</div>
          <a href={mapsLink} target="_blank" rel="noreferrer" className="map-link"><Icon name="MapPin" size={14} /> Google Maps</a>
        </div>
      )}

      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-display)", color: "var(--brand-gold-dark)", marginTop: 10, marginBottom: 8 }}>
        Your Earnings (70%): {etb(driverEarnings)}
      </div>

      {showClaimBtn && <button onClick={() => handleClaim(o.id)} className="btn btn-primary" style={{ width: "100%" }}>{t("claim")}</button>}

      {handlePickup && (o.orderStatus === "Driver Assigned" || o.orderStatus === "Ready for Pickup") && (
        <button onClick={doPickup} disabled={pickingUp} className="btn btn-gold" style={{ width: "100%", marginTop: 8 }}>
          {pickingUp ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Processing…</> : "Mark as Picked Up / Out for Delivery"}
        </button>
      )}

      {handleDeliver && o.orderStatus === "Out for Delivery" && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 6, textTransform: "uppercase" }}>Customer Delivery OTP</div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 8 }}>Ask the customer for their OTP from the order tracking page</div>
          <input value={otpInput} onChange={e => setOtpInput(e.target.value)} placeholder="Enter customer OTP" className="input" style={{ marginBottom: 8 }} />
          <input type="file" accept="image/*" onChange={e => setProofFile(e.target.files[0] || null)} className="input" style={{ padding: "8px", marginBottom: 8 }} />
          <button onClick={doDeliver} disabled={delivering || !otpInput.trim()} className="btn btn-primary" style={{ width: "100%" }}>
            {delivering ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Processing…</> : t("markDelivered")}
          </button>
        </div>
      )}
    </div>
  );
});

const DeliveryOrderList = memo(({ orders, allOrders, empty, t, showClaimBtn, handleClaim, showProductDetails, showRoute, handlePickup, handleDeliver, admins, showToast }) => {
  if (!orders.length) return <div className="empty-state"><div className="icon">🚚</div><div>{empty}</div></div>;
  return (
    <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      {orders.map(o => (
        <DeliveryOrderCard
          key={o.id}
          o={o}
          allOrders={allOrders}
          t={t}
          showClaimBtn={showClaimBtn}
          handleClaim={handleClaim}
          showProductDetails={showProductDetails}
          showRoute={showRoute}
          handlePickup={handlePickup}
          handleDeliver={handleDeliver}
          admins={admins}
          showToast={showToast}
        />
      ))}
    </div>
  );
});

// ===== OWNER ORDERS =====
const OwnerOrders = memo(({ orders, refreshOrders, showToast, t, admins, adminToken }) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  // Only show parent orders as cards — see index.html for the full explanation.
  const parentOrders = orders.filter(o => !o.parentOrderId);
  const filtered = parentOrders.filter(o => {
    const matchesSearch = !searchTerm.trim() || o.id.toLowerCase().includes(searchTerm.toLowerCase()) || (o.customerName && o.customerName.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus = statusFilter === "All" || o.orderStatus === statusFilter;
    return matchesSearch && matchesStatus;
  });

  async function updateStatus(id, field, value) {
    try { await apiPost("updateOrder", { id, updates: { [field]: value } }); refreshOrders(); showToast("Updated"); }
    catch(e) { showToast("Update failed", "error"); }
  }

  async function assignDriver(orderId, adminId) {
    try { await apiPost("ownerAssignDriver", { orderId, adminId }); refreshOrders(); showToast("Driver assigned"); }
    catch(e) { showToast("Failed", "error"); }
  }

  async function verifyPayment(orderId) {
    if (!confirm("Mark payment as verified? Sellers will be notified.")) return;
    try {
      const res = await apiPost("verifyPayment", { orderId, token: adminToken });
      if (!res || !res.success) {
        showToast("Failed to verify: " + ((res && res.error) || "Unknown error"), "error");
        return;
      }
      refreshOrders();
      showToast("Payment verified. Sellers notified.");
    } catch(e) {
      showToast("Failed: " + e.message, "error");
    }
  }

  async function rejectPayment(orderId) {
    const reason = prompt("Reason for rejecting this payment (optional):") || "";
    if (!confirm("Reject this payment? The order will be cancelled and never sent to sellers.")) return;
    try {
      const res = await apiPost("rejectPayment", { orderId, token: adminToken, reason });
      if (!res || !res.success) {
        showToast("Failed to reject: " + ((res && res.error) || "Unknown error"), "error");
        return;
      }
      refreshOrders();
      showToast("Payment rejected. Order cancelled.");
    } catch(e) {
      showToast("Failed: " + e.message, "error");
    }
  }

  const deliveryAdmins = admins.filter(a => a.Role === "delivery" && a.Status === "active");

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input placeholder="Search orders…" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="input" style={{ flex: 1, minWidth: 200 }} />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="input" style={{ width: "auto", minWidth: 160 }}>
          <option value="All">All Statuses</option>
          {ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {filtered.length === 0 ? <div className="empty-state"><div className="icon">📋</div><div>No orders found.</div></div>
        : <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{filtered.map(o => {
          const subs = orders.filter(s => s.parentOrderId === o.id);
          const sellerEntries = subs.map(sub => {
            const seller = admins.find(a => a.AdminID === sub.sellerId);
            return { name: seller ? (seller.Name || "Unknown") : "Unknown", phone: seller ? (seller.PickupPhone || "") : "" };
          });
          const sellerName = sellerEntries.length > 0 ? sellerEntries.map(s => s.name).join(", ") : "Not yet assigned";
          const pickupPhone = sellerEntries.length === 1 ? sellerEntries[0].phone : "";
          const isPendingPayment = o.orderStatus === "Pending Payment Verification";
          const isPaymentVerified = o.orderStatus === "Payment Verified";
          return (
            <div key={o.id} className="order-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontWeight: 600, textTransform: "uppercase" }}>Order</div>
                  <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-display)" }}>{o.id}</div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{formatDate(o.createdAt)}</div>
                </div>
                <StatusBadge status={o.orderStatus} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, fontSize: 13, color: "var(--text-secondary)", marginBottom: 10 }}>
                <div><strong style={{ color: "var(--text-primary)" }}>{t("customerName")}:</strong> {o.customerName}</div>
                <div><strong style={{ color: "var(--text-primary)" }}>{t("customerPhone")}:</strong> <a href={`tel:${o.customerPhone}`} style={{ color: "var(--brand-green)", textDecoration: "none" }}>{o.customerPhone}</a></div>
                <div><strong style={{ color: "var(--text-primary)" }}>{t("address")}:</strong> {o.address}</div>
                <div><strong style={{ color: "var(--text-primary)" }}>{t("total")}:</strong> <span style={{ color: "var(--brand-gold-dark)", fontWeight: 700 }}>{etb(o.total)}</span></div>
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
                <strong style={{ color: "var(--text-primary)" }}>Seller:</strong> {sellerName}
                {pickupPhone && <> · <a href={`tel:${pickupPhone}`} style={{ color: "var(--brand-green)", textDecoration: "none" }}>{pickupPhone}</a></>}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 10 }}>{(o.items||[]).map(i=>`${i.name} ×${i.qty}`).join(", ")}</div>
              {o.deliveryName && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}><Icon name="Truck" size={12} /> Driver: {o.deliveryName} {o.deliveryPhone && `· ${o.deliveryPhone}`}</div>}
              {o.verificationCode && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, textTransform: "uppercase" }}>Handover OTP</div>
                  <div className="otp-display" style={{ fontSize: 16, padding: "8px 12px", display: "inline-block" }}>{o.verificationCode}</div>
                </div>
              )}
              {isPendingPayment && (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button onClick={() => verifyPayment(o.id)} className="btn btn-gold" style={{ flex: 1 }}>
                    <Icon name="CheckCircle2" size={14} /> Verify Payment
                  </button>
                  <button onClick={() => rejectPayment(o.id)} className="btn btn-danger" style={{ flex: 1 }}>
                    <Icon name="X" size={14} /> Reject Payment
                  </button>
                </div>
              )}
              {isPaymentVerified && (
                <div style={{ marginTop: 8, padding: 8, background: "var(--success-soft)", borderRadius: 8, color: "var(--success)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                  <Icon name="CheckCircle2" size={14} /> Payment Verified – Sellers Notified
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <select value={o.orderStatus} onChange={e => updateStatus(o.id, "orderStatus", e.target.value)} className="input" style={{ flex: 1, minWidth: 160, fontSize: 12, padding: "8px 12px" }}>
                  {ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <select value={o.paymentStatus || "Pending"} onChange={e => updateStatus(o.id, "paymentStatus", e.target.value)} className="input" style={{ flex: 1, minWidth: 140, fontSize: 12, padding: "8px 12px" }}>
                  {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {!o.deliveryName && (o.orderStatus === "Accepted by Seller" || o.orderStatus === "Pending Seller Approval") && (
                <div style={{ marginTop: 10 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>Assign Driver</label>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {deliveryAdmins.map(d => (
                      <button key={d.AdminID} onClick={() => assignDriver(o.id, d.AdminID)} className="btn btn-sm btn-secondary" style={{ fontSize: 11 }}>
                        {d.Name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}</div>}
    </div>
  );
});

// ===== OWNER PRODUCTS =====
const OwnerProducts = memo(({ products, refreshProducts, categories, admins, showToast, t }) => {
  const [editing, setEditing] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ id: "", name: "", category: "", price: "", weight: "light", stock: "", description: "", image: "", sellerId: "" });
  const [uploadingImage, setUploadingImage] = useState(false);
  const sellers = (admins || []).filter(a => a.Role === "seller");
  const sellerName = (id) => { const s = sellers.find(x => x.AdminID === id); return s ? s.Name : ""; };

  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkSellerId, setBulkSellerId] = useState("");
  const [bulkAssigning, setBulkAssigning] = useState(false);
  function toggleSelect(id) { setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]); }
  function selectAll() { setSelectedIds(products.map(p => p.id)); }
  function clearSelection() { setSelectedIds([]); }
  async function applyBulkAssign() {
    if (!bulkSellerId || selectedIds.length === 0) { showToast("Pick a seller and at least one product", "warning"); return; }
    setBulkAssigning(true);
    try {
      const res = await apiPost("bulkAssignSeller", { productIds: selectedIds, sellerId: bulkSellerId });
      if (!res || !res.success) { showToast("Failed: " + ((res && res.error) || "Unknown error"), "error"); setBulkAssigning(false); return; }
      showToast(`Assigned ${res.updated} product(s) to ${sellerName(bulkSellerId)}`);
      clearSelection();
      setBulkSellerId("");
      refreshProducts();
    } catch(e) { showToast("Failed", "error"); }
    setBulkAssigning(false);
  }

  function startEdit(p) { setEditing(p.id); setForm({ ...p, price: String(p.price), stock: String(p.stock), sellerId: p.sellerId || "" }); setSuggestions(null); setSuggestQuery(""); }
  function startAdd() { setShowAdd(true); setForm({ id: "", name: "", category: categories[0]?.id || "", price: "", weight: "light", stock: "", description: "", image: "", sellerId: "" }); setSuggestions(null); setSuggestQuery(""); }
  function cancel() { setEditing(null); setShowAdd(false); }

  async function handleImageUpload(file) {
    if (!file) return;
    setUploadingImage(true);
    try {
      const url = await smartUpload(file);
      if (url) setForm(f => ({ ...f, image: url }));
      showToast("Image uploaded");
    } catch(e) {
      showToast("Upload failed", "error");
    }
    setUploadingImage(false);
  }

  const [suggestQuery, setSuggestQuery] = useState("");
  const [suggestions, setSuggestions] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [adoptingUrl, setAdoptingUrl] = useState(null);

  async function searchSuggestions(query) {
    const q = (query || form.name || "").trim();
    if (!q) { showToast("Enter a product name first", "warning"); return; }
    setSuggesting(true);
    setSuggestions(null);
    try {
      const res = await apiGet("searchProductImages", { query: q });
      if (!res || !res.success) {
        showToast(res && res.error ? res.error : "Image search failed", "error");
        setSuggestions([]);
      } else {
        setSuggestions(res.images || []);
      }
    } catch(e) {
      showToast("Image search failed", "error");
      setSuggestions([]);
    }
    setSuggesting(false);
  }

  async function adoptSuggestion(imageUrl) {
    setAdoptingUrl(imageUrl);
    try {
      const res = await apiPost("uploadImageFromUrl", { imageUrl });
      if (!res || !res.success) {
        showToast(res && res.error ? res.error : "Couldn't use that image", "error");
      } else {
        setForm(f => ({ ...f, image: res.url }));
        setSuggestions(null);
        showToast("Image set");
      }
    } catch(e) {
      showToast("Couldn't use that image", "error");
    }
    setAdoptingUrl(null);
  }

  async function save() {
    try {
      if (showAdd) {
        const id = "PRD-" + Math.random().toString(36).slice(2, 8).toUpperCase();
        await apiPost("addProduct", { product: { ...form, id, price: Number(form.price), stock: Number(form.stock) } });
        showToast("Product added");
      } else {
        await apiPost("updateProduct", { id: editing, updates: { ...form, price: Number(form.price), stock: Number(form.stock) } });
        showToast("Product updated");
      }
      refreshProducts(); cancel();
    } catch(e) { showToast("Failed", "error"); }
  }

  async function del(id) {
    if (!confirm("Delete this product?")) return;
    try { await apiPost("deleteProduct", { id }); refreshProducts(); showToast("Deleted"); }
    catch(e) { showToast("Failed", "error"); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button onClick={startAdd} className="btn btn-primary btn-sm" style={{ marginBottom: 12 }}><Icon name="Plus" size={14} /> Add Product</button>
      {(showAdd || editing) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h4 className="font-display" style={{ marginBottom: 12 }}>{showAdd ? "Add Product" : "Edit Product"}</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            <div><label className="text-sm font-semibold text-secondary">Name</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" /></div>
            <div><label className="text-sm font-semibold text-secondary">Category</label><select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="input">{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label className="text-sm font-semibold text-secondary">Price</label><input type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} className="input" /></div>
            <div><label className="text-sm font-semibold text-secondary">Stock</label><input type="number" value={form.stock} onChange={e => setForm(f => ({ ...f, stock: e.target.value }))} className="input" /></div>
            <div><label className="text-sm font-semibold text-secondary">Weight</label><select value={form.weight} onChange={e => setForm(f => ({ ...f, weight: e.target.value }))} className="input"><option value="light">Light</option><option value="medium">Medium</option><option value="heavy">Heavy</option></select></div>
            <div>
              <label className="text-sm font-semibold text-secondary">Seller</label>
              <select value={form.sellerId} onChange={e => setForm(f => ({ ...f, sellerId: e.target.value }))} className="input">
                <option value="">Auto (by category)</option>
                {sellers.map(s => <option key={s.AdminID} value={s.AdminID}>{s.Name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-semibold text-secondary">Image</label>
              <input type="file" accept="image/*" onChange={e => handleImageUpload(e.target.files[0])} className="input" style={{ padding: "10px" }} />
              {uploadingImage && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Uploading…</span>}
              {form.image && <div style={{ marginTop: 6, fontSize: 12, color: "var(--success)" }}>✅ Image uploaded</div>}
            </div>
          </div>

          {!form.image && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={suggestQuery}
                  onChange={e => setSuggestQuery(e.target.value)}
                  placeholder={form.name ? `Search "${form.name}"…` : "What should I search for?"}
                  className="input"
                  style={{ flex: 1 }}
                  onKeyDown={e => e.key === "Enter" && searchSuggestions(suggestQuery)}
                />
                <button onClick={() => searchSuggestions(suggestQuery)} disabled={suggesting} className="btn btn-secondary btn-sm" style={{ whiteSpace: "nowrap" }}>
                  {suggesting ? "Searching…" : "Suggest Images"}
                </button>
              </div>
              {suggestions && suggestions.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 8 }}>No results — try a different search.</div>
              )}
              {suggestions && suggestions.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 10, maxHeight: 320, overflowY: "auto", paddingRight: 2 }}>
                  {suggestions.map((img, i) => (
                    <button
                      key={i}
                      onClick={() => adoptSuggestion(img.full)}
                      disabled={adoptingUrl !== null}
                      title={img.title}
                      style={{ padding: 0, border: "2px solid var(--border)", borderRadius: 8, overflow: "hidden", cursor: "pointer", background: "none", aspectRatio: "1", position: "relative" }}
                    >
                      <img src={img.thumbnail} alt={img.title} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: adoptingUrl === img.full ? 0.5 : 1 }} />
                      {adoptingUrl === img.full && (
                        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 10 }}><label className="text-sm font-semibold text-secondary">Description</label><textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input" rows={2} /></div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={save} className="btn btn-primary btn-sm"><Icon name="Save" size={14} /> Save</button>
            <button onClick={cancel} className="btn btn-secondary btn-sm">Cancel</button>
          </div>
        </div>
      )}
      {sellers.length > 0 && (
        <div className="card" style={{ marginBottom: 12, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Bulk assign seller {selectedIds.length > 0 && `(${selectedIds.length} selected)`}</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={selectAll} className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: "4px 8px" }}>Select all</button>
              <button onClick={clearSelection} className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: "4px 8px" }}>Clear</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <select value={bulkSellerId} onChange={e => setBulkSellerId(e.target.value)} className="input" style={{ flex: 1 }}>
              <option value="">Choose seller…</option>
              {sellers.map(s => <option key={s.AdminID} value={s.AdminID}>{s.Name}</option>)}
            </select>
            <button onClick={applyBulkAssign} disabled={bulkAssigning || !bulkSellerId || selectedIds.length === 0} className="btn btn-primary btn-sm" style={{ whiteSpace: "nowrap" }}>
              {bulkAssigning ? "Assigning…" : "Assign"}
            </button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {products.map(p => (
          <div key={p.id} className="order-card" style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {sellers.length > 0 && (
              <input type="checkbox" checked={selectedIds.includes(p.id)} onChange={() => toggleSelect(p.id)} style={{ width: 18, height: 18, flexShrink: 0 }} />
            )}
            {p.image && <img src={p.image} alt="" style={{ width: 50, height: 50, borderRadius: 10, objectFit: "cover" }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{etb(p.price)} · Stock: {p.stock} · {p.weight}</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                Seller: {p.sellerId ? (sellerName(p.sellerId) || "Unknown") : "Auto (by category)"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => startEdit(p)} className="btn btn-ghost btn-sm" style={{ padding: "6px 10px" }}><Icon name="Edit3" size={14} /></button>
              <button onClick={() => del(p.id)} className="btn btn-ghost btn-sm" style={{ padding: "6px 10px", color: "var(--danger)" }}><Icon name="Trash2" size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

// ===== OWNER CATEGORIES (with image upload - EXPLICIT) =====
const OwnerCategories = memo(({ categories, refreshCategories, showToast, t }) => {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ id: "", name: "", description: "", parentId: "", image: "", banner: "", active: true });
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [togglingId, setTogglingId] = useState(null);

  const handleImageUpload = async (file, field) => {
    if (!file) return;
    const setUploading = field === "image" ? setUploadingImage : setUploadingBanner;
    setUploading(true);
    try {
      const url = await smartUpload(file);
      if (url) setForm(f => ({ ...f, [field]: url }));
      showToast("Image uploaded");
    } catch(e) {
      showToast("Upload failed", "error");
    }
    setUploading(false);
  };

  const startAdd = () => {
    setEditId(null);
    setForm({ id: "", name: "", description: "", parentId: "", image: "", banner: "", active: true });
    setShowAdd(true);
  };

  const startEdit = (c) => {
    setEditId(c.id);
    setForm({
      id: c.id, name: c.name || "", description: c.description || "", parentId: c.parentId || "",
      image: c.image || "", banner: c.banner || "",
      active: c.active !== false && c.active !== "FALSE" && c.active !== "false"
    });
    setShowAdd(true);
  };

  const save = async () => {
    if (!form.name.trim()) { showToast("Category name is required", "warning"); return; }
    try {
      if (editId) {
        await apiPost("updateCategory", { id: editId, updates: form });
        showToast("Category updated");
      } else {
        const id = "CAT-" + Math.random().toString(36).slice(2, 8).toUpperCase();
        await apiPost("addCategory", { category: { ...form, id } });
        showToast("Category added");
      }
      refreshCategories();
      setShowAdd(false);
      setEditId(null);
    } catch(e) {
      showToast("Failed", "error");
    }
  };

  const del = async (id) => {
    if (!confirm("Delete this category?")) return;
    try {
      await apiPost("deleteCategory", { id });
      refreshCategories();
      showToast("Deleted");
    } catch(e) {
      showToast("Failed", "error");
    }
  };

  // Only updates this category's active flag — never navigates anywhere.
  const toggleActive = async (c) => {
    const isActive = c.active !== false && c.active !== "FALSE" && c.active !== "false";
    setTogglingId(c.id);
    try {
      await apiPost("updateCategory", { id: c.id, updates: { active: !isActive } });
      await refreshCategories();
      showToast(!isActive ? "Category activated" : "Category deactivated");
    } catch(e) {
      showToast("Failed to update", "error");
    }
    setTogglingId(null);
  };

  return (
    <div style={{ marginTop: 12 }}>
      <button onClick={startAdd} className="btn btn-primary btn-sm" style={{ marginBottom: 12 }}>
        <Icon name="Plus" size={14} /> Add Category
      </button>
      {showAdd && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h4 className="font-display" style={{ marginBottom: 12 }}>{editId ? "Edit Category" : "Add Category"}</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            <div>
              <label className="text-sm font-semibold text-secondary">Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Groceries" className="input" />
            </div>
            <div>
              <label className="text-sm font-semibold text-secondary">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional short description" className="input" />
            </div>
            <div>
              <label className="text-sm font-semibold text-secondary">Parent</label>
              <select value={form.parentId} onChange={e => setForm(f => ({ ...f, parentId: e.target.value }))} className="input">
                <option value="">None</option>
                {categories.filter(c => c.id !== editId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-semibold text-secondary">Icon Image</label>
              <input type="file" accept="image/*" onChange={e => handleImageUpload(e.target.files[0], "image")} className="input" style={{ padding: "10px" }} />
              {uploadingImage && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Uploading…</span>}
              {form.image && <div style={{ marginTop: 4, fontSize: 12, color: "var(--success)" }}>✅ Image uploaded</div>}
              <input value={form.image} onChange={e => setForm(f => ({ ...f, image: e.target.value }))} placeholder="Or paste image URL" className="input" style={{ marginTop: 6, fontSize: 12 }} />
            </div>
            <div>
              <label className="text-sm font-semibold text-secondary">Banner Image</label>
              <input type="file" accept="image/*" onChange={e => handleImageUpload(e.target.files[0], "banner")} className="input" style={{ padding: "10px" }} />
              {uploadingBanner && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Uploading…</span>}
              {form.banner && <div style={{ marginTop: 4, fontSize: 12, color: "var(--success)" }}>✅ Banner uploaded</div>}
              <input value={form.banner} onChange={e => setForm(f => ({ ...f, banner: e.target.value }))} placeholder="Or paste image URL" className="input" style={{ marginTop: 6, fontSize: 12 }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label className="text-sm font-semibold text-secondary">Active</label>
              <button type="button" onClick={() => setForm(f => ({ ...f, active: !f.active }))} className={`toggle-switch ${form.active ? "active" : ""}`} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={save} className="btn btn-primary btn-sm">{editId ? "Save Changes" : "Add"}</button>
            <button onClick={() => { setShowAdd(false); setEditId(null); }} className="btn btn-secondary btn-sm">Cancel</button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {categories.map(c => {
          const isActive = c.active !== false && c.active !== "FALSE" && c.active !== "false";
          return (
            <div key={c.id} className="order-card" style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {c.image && <img src={c.image} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover" }} />}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{c.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Parent: {c.parentId || "None"}</div>
              </div>
              <span className={`badge ${isActive ? "badge-green" : "badge-gray"}`}>{isActive ? "Active" : "Inactive"}</span>
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleActive(c); }}
                disabled={togglingId === c.id}
                className={`toggle-switch ${isActive ? "active" : ""}`}
                aria-label="Toggle category active"
              />
              <button onClick={() => startEdit(c)} className="btn btn-ghost btn-sm" style={{ padding: "6px 10px" }}>
                <Icon name="Edit3" size={14} />
              </button>
              <button onClick={() => del(c.id)} className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", padding: "6px 10px" }}>
                <Icon name="Trash2" size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
// ===== OWNER TICKETS =====
const OwnerTickets = memo(({ tickets, refreshTickets, showToast, t }) => {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {tickets.map(tk => (
          <div key={tk.id} className="order-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{tk.category}</div>
              <span className="badge badge-blue">{tk.status}</span>
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{tk.name} · {tk.phone}</div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>{tk.message}</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>{formatDate(tk.createdAt)}</div>
          </div>
        ))}
        {tickets.length === 0 && <div className="empty-state"><div className="icon">🎫</div><div>No tickets yet.</div></div>}
      </div>
    </div>
  );
});

// ===== OWNER ANALYTICS =====
const OwnerAnalytics = memo(({ orders, products, t }) => {
  const totalRevenue = orders.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const totalOrders = orders.length;
  const activeCount = orders.filter(o => !["Delivered", "Rejected"].includes(o.orderStatus)).length;
  const deliveredCount = orders.filter(o => o.orderStatus === "Delivered").length;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 24 }}>
        <div className="stat-card"><div className="value">{totalOrders}</div><div className="label">{t("totalOrders")}</div></div>
        <div className="stat-card"><div className="value" style={{ color: "var(--brand-gold-dark)" }}>{etb(totalRevenue)}</div><div className="label">{t("totalRevenue")}</div></div>
        <div className="stat-card"><div className="value" style={{ color: "var(--info)" }}>{activeCount}</div><div className="label">{t("activeOrders")}</div></div>
        <div className="stat-card"><div className="value" style={{ color: "var(--success)" }}>{deliveredCount}</div><div className="label">{t("completedToday")}</div></div>
      </div>

      <h3 className="font-display" style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Recent Orders</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {orders.slice(0, 10).map(o => (
          <div key={o.id} className="order-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{o.id}</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{o.customerName} · {formatDate(o.createdAt)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontWeight: 700, color: "var(--brand-gold-dark)" }}>{etb(o.total)}</div>
              <StatusBadge status={o.orderStatus} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

// ===== OWNER SETTINGS =====
const OwnerSettings = memo(({ settings, refreshSettings, showToast, t }) => {
  const [medium, setMedium] = useState(settings.mediumSurcharge);
  const [heavy, setHeavy] = useState(settings.heavySurcharge);
  const [paymentMethods, setPaymentMethods] = useState(
    (settings.paymentMethods && settings.paymentMethods.length > 0) ? settings.paymentMethods : DEFAULT_PAYMENT_METHODS
  );
  const [savingPayments, setSavingPayments] = useState(false);
  const [pickupLocations, setPickupLocations] = useState([]);
  const [showPickupAdd, setShowPickupAdd] = useState(false);
  const [pickupForm, setPickupForm] = useState({ name: "", address: "", phone: "", active: true });
  const [editPickupId, setEditPickupId] = useState(null);

  function updatePaymentMethod(id, field, value) {
    setPaymentMethods(list => list.map(m => m.id === id ? { ...m, [field]: value } : m));
  }

  async function savePaymentMethods() {
    setSavingPayments(true);
    try {
      await apiPost("updateSetting", { key: "paymentMethods", value: JSON.stringify(paymentMethods) });
      refreshSettings();
      showToast("Payment accounts saved");
    } catch(e) { showToast("Failed", "error"); }
    setSavingPayments(false);
  }

  const refreshPickupLocations = useCallback(async () => {
    const locs = await loadPickupLocations();
    setPickupLocations(locs);
  }, []);

  useEffect(() => { refreshPickupLocations(); }, []);

  async function saveSettings() {
    try {
      await apiPost("updateSetting", { key: "mediumSurcharge", value: String(medium) });
      await apiPost("updateSetting", { key: "heavySurcharge", value: String(heavy) });
      refreshSettings(); showToast("Settings saved");
    } catch(e) { showToast("Failed", "error"); }
  }

  async function savePickup() {
    try {
      if (editPickupId) {
        await apiPost("updatePickupLocation", { id: editPickupId, updates: pickupForm });
        showToast("Location updated");
      } else {
        await apiPost("addPickupLocation", { location: pickupForm });
        showToast("Location added");
      }
      refreshPickupLocations();
      setShowPickupAdd(false);
      setEditPickupId(null);
      setPickupForm({ name: "", address: "", phone: "", active: true });
    } catch(e) {
      showToast("Failed", "error");
    }
  }

  function startEditPickup(loc) {
    setEditPickupId(loc.id);
    setPickupForm({ name: loc.name, address: loc.address, phone: loc.phone || "", active: loc.active !== "false" });
    setShowPickupAdd(true);
  }

  async function deletePickup(id) {
    if (!confirm("Delete this pickup location?")) return;
    try {
      await apiPost("deletePickupLocation", { id });
      refreshPickupLocations();
      showToast("Deleted");
    } catch(e) {
      showToast("Failed", "error");
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="card">
        <h4 className="font-display" style={{ marginBottom: 16 }}>Surcharge Settings</h4>
        <div style={{ marginBottom: 14 }}>
          <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>Medium Item Surcharge (ETB)</label>
          <input type="number" value={medium} onChange={e => setMedium(e.target.value)} className="input" />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>Heavy Item Surcharge (ETB)</label>
          <input type="number" value={heavy} onChange={e => setHeavy(e.target.value)} className="input" />
        </div>
        <button onClick={saveSettings} className="btn btn-primary btn-sm"><Icon name="Save" size={14} /> Save Settings</button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h4 className="font-display" style={{ marginBottom: 8 }}>Payment Accounts</h4>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 16 }}>
          These are the accounts customers are shown at checkout to send payment to. Edit the account number if it changes — no code changes needed.
        </div>
        {paymentMethods.map(m => (
          <div key={m.id} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
              <div>
                <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>Name</label>
                <input value={m.name} onChange={e => updatePaymentMethod(m.id, "name", e.target.value)} placeholder="e.g. CBE" className="input" />
              </div>
              <div>
                <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>Account / Phone Number</label>
                <input value={m.account} onChange={e => updatePaymentMethod(m.id, "account", e.target.value)} placeholder="e.g. 1000771527148" className="input" />
              </div>
              <div>
                <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>Note</label>
                <input value={m.note} onChange={e => updatePaymentMethod(m.id, "note", e.target.value)} placeholder="e.g. Commercial Bank of Ethiopia" className="input" />
              </div>
            </div>
          </div>
        ))}
        <button onClick={savePaymentMethods} disabled={savingPayments} className="btn btn-primary btn-sm">
          <Icon name="Save" size={14} /> {savingPayments ? "Saving…" : "Save Payment Accounts"}
        </button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h4 className="font-display" style={{ marginBottom: 16 }}>Pickup Locations</h4>
        <button onClick={() => { setShowPickupAdd(true); setEditPickupId(null); setPickupForm({ name: "", address: "", phone: "", active: true }); }} className="btn btn-primary btn-sm" style={{ marginBottom: 12 }}>
          <Icon name="Plus" size={14} /> Add Pickup Location
        </button>
        {showPickupAdd && (
          <div style={{ marginBottom: 16, padding: 12, background: "var(--bg-secondary)", borderRadius: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
              <div><label className="text-sm font-semibold text-secondary">Name</label><input value={pickupForm.name} onChange={e => setPickupForm(f => ({ ...f, name: e.target.value }))} className="input" /></div>
              <div><label className="text-sm font-semibold text-secondary">Address</label><input value={pickupForm.address} onChange={e => setPickupForm(f => ({ ...f, address: e.target.value }))} className="input" /></div>
              <div><label className="text-sm font-semibold text-secondary">Phone (optional)</label><input value={pickupForm.phone} onChange={e => setPickupForm(f => ({ ...f, phone: e.target.value }))} className="input" /></div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label className="text-sm font-semibold text-secondary">Active</label>
                <button onClick={() => setPickupForm(f => ({ ...f, active: !f.active }))} className={`toggle-switch ${pickupForm.active ? "active" : ""}`} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={savePickup} className="btn btn-primary btn-sm"><Icon name="Save" size={14} /> Save</button>
              <button onClick={() => { setShowPickupAdd(false); setEditPickupId(null); }} className="btn btn-secondary btn-sm">Cancel</button>
            </div>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {pickupLocations.map(loc => (
            <div key={loc.id} className="order-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{loc.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{loc.address} {loc.phone && `· ${loc.phone}`}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => startEditPickup(loc)} className="btn btn-ghost btn-sm"><Icon name="Edit3" size={14} /></button>
                <button onClick={() => deletePickup(loc.id)} className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }}><Icon name="Trash2" size={14} /></button>
              </div>
            </div>
          ))}
          {pickupLocations.length === 0 && <div className="empty-state"><div className="icon">📍</div><div>No pickup locations configured.</div></div>}
        </div>
      </div>
    </div>
  );
});

// ===== OWNER ADMINS =====
const OwnerAdmins = memo(({ admins, refreshAdmins, showToast, t, categories }) => {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ name: "", password: "", role: "seller", categoryAccess: "", status: "active", telegramId: "", phone: "", pickupAddress: "", pickupPhone: "", vehicle: "", photoUrl: "" });
  const [savingId, setSavingId] = useState(null);

  function emptyForm() { return { name: "", password: "", role: "seller", categoryAccess: "", status: "active", telegramId: "", phone: "", pickupAddress: "", pickupPhone: "", vehicle: "", photoUrl: "" }; }
  function startAdd() { setEditId(null); setForm(emptyForm()); setShowAdd(true); }
  function startEdit(a) {
    setEditId(a.AdminID);
    setForm({
      name: a.Name || "", password: "", role: a.Role || "seller", categoryAccess: a.CategoryAccess || "",
      status: a.Status || "active", telegramId: a.TelegramID || "", phone: a.Phone || "",
      pickupAddress: a.PickupAddress || "", pickupPhone: a.PickupPhone || "", vehicle: a.Vehicle || "", photoUrl: a.PhotoUrl || ""
    });
    setShowAdd(true);
  }

  async function add() {
    if (!form.name.trim() || (!editId && !form.password.trim())) { showToast(editId ? "Name is required" : "Name and password are required", "warning"); return; }
    try {
      if (editId) {
        const updates = { ...form };
        if (!updates.password) delete updates.password;
        await apiPost("updateAdmin", { id: editId, updates });
        showToast("Admin updated");
      } else {
        await apiPost("addAdmin", { admin: form });
        showToast("Admin added");
      }
      refreshAdmins(); setShowAdd(false); setEditId(null);
      setForm(emptyForm());
    } catch(e) { showToast("Failed", "error"); }
  }

  async function del(id) {
    if (!confirm("Delete this admin?")) return;
    try { await apiPost("deleteAdmin", { id }); refreshAdmins(); showToast("Deleted"); }
    catch(e) { showToast("Failed", "error"); }
  }

  // Only flips this admin's Status field — never navigates anywhere.
  async function toggleStatus(a) {
    const id = a.AdminID;
    const isActive = a.Status === "active";
    setSavingId(id);
    try {
      await apiPost("updateAdmin", { id, updates: { status: isActive ? "inactive" : "active" } });
      await refreshAdmins();
      showToast(isActive ? "Admin deactivated" : "Admin activated");
    } catch(e) { showToast("Failed to update", "error"); }
    setSavingId(null);
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button onClick={startAdd} className="btn btn-primary btn-sm" style={{ marginBottom: 12 }}><Icon name="Plus" size={14} /> Add Admin</button>
      {showAdd && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h4 className="font-display" style={{ marginBottom: 12 }}>{editId ? "Edit Admin" : "Add Admin"}</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            <div><label className="text-sm font-semibold text-secondary">Name</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Abebe Kebede" className="input" /></div>
            <div><label className="text-sm font-semibold text-secondary">Password</label><input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder={editId ? "Leave blank to keep current password" : "Login password"} className="input" /></div>
            <div>
              <label className="text-sm font-semibold text-secondary">Role</label>
              <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} className="input">
                <option value="owner">Owner</option>
                <option value="seller">Seller</option>
                <option value="delivery">Delivery</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label className="text-sm font-semibold text-secondary">Status</label>
              <button type="button" onClick={() => setForm(f => ({ ...f, status: f.status === "active" ? "inactive" : "active" }))} className={`toggle-switch ${form.status === "active" ? "active" : ""}`} />
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{form.status === "active" ? "Active" : "Inactive"}</span>
            </div>
            <div><label className="text-sm font-semibold text-secondary">Phone</label><input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="09xxxxxxxx" className="input" /></div>
            <div><label className="text-sm font-semibold text-secondary">Telegram ID</label><input value={form.telegramId} onChange={e => setForm(f => ({ ...f, telegramId: e.target.value }))} placeholder="Numeric Telegram chat ID" className="input" /></div>
            {form.role === "seller" && (
              <>
                <div><label className="text-sm font-semibold text-secondary">Pickup Address</label><input value={form.pickupAddress} onChange={e => setForm(f => ({ ...f, pickupAddress: e.target.value }))} placeholder="e.g. Piassa, near the bus stop" className="input" /></div>
                <div><label className="text-sm font-semibold text-secondary">Pickup Phone</label><input value={form.pickupPhone} onChange={e => setForm(f => ({ ...f, pickupPhone: e.target.value }))} placeholder="09xxxxxxxx" className="input" /></div>
              </>
            )}
            {form.role === "delivery" && (
              <div><label className="text-sm font-semibold text-secondary">Vehicle</label><input value={form.vehicle} onChange={e => setForm(f => ({ ...f, vehicle: e.target.value }))} placeholder="e.g. Motorbike, Bajaj" className="input" /></div>
            )}
            <div><label className="text-sm font-semibold text-secondary">Photo URL</label><input value={form.photoUrl} onChange={e => setForm(f => ({ ...f, photoUrl: e.target.value }))} placeholder="Optional photo link" className="input" /></div>
          </div>
          {form.role === "seller" && (
            <div style={{ marginTop: 10 }}>
              <label className="text-sm font-semibold text-secondary" style={{ display: "block", marginBottom: 6 }}>
                Category Access — which categories this seller manages
              </label>
              <div style={{ border: "1.5px solid var(--border)", borderRadius: 10, padding: 10, maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {flattenCategoryOptions(categories, "").map(opt => {
                  const selected = form.categoryAccess.split(",").map(x => x.trim()).filter(Boolean);
                  const checked = selected.includes(opt.id);
                  return (
                    <label key={opt.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked ? selected.filter(id => id !== opt.id) : [...selected, opt.id];
                          setForm(f => ({ ...f, categoryAccess: next.join(",") }));
                        }}
                        style={{ width: 16, height: 16, flexShrink: 0 }}
                      />
                      {opt.label}
                    </label>
                  );
                })}
                {categories.length === 0 && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No categories yet.</div>}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 }}>
                Leave everything unchecked to let this seller receive orders from any category with no assigned seller.
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={add} className="btn btn-primary btn-sm">{editId ? "Save Changes" : "Add"}</button>
            <button onClick={() => { setShowAdd(false); setEditId(null); }} className="btn btn-secondary btn-sm">Cancel</button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {admins.map(a => (
          <div key={a.AdminID} className="order-card" style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--brand-green-soft)", color: "var(--brand-green)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 16, flexShrink: 0 }}>{a.Name?.[0] || "?"}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{a.Name}</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{a.Role} {a.Phone && `· ${a.Phone}`}</div>
              {a.Role === "seller" && a.CategoryAccess && (
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                  Categories: {a.CategoryAccess.split(",").map(id => categories.find(c => c.id === id.trim())?.name || id.trim()).join(", ")}
                </div>
              )}
            </div>
            <span className={`badge ${a.Status === "active" ? "badge-green" : "badge-gray"}`}>{a.Status === "active" ? "Active" : "Inactive"}</span>
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleStatus(a); }}
              disabled={savingId === a.AdminID}
              className={`toggle-switch ${a.Status === "active" ? "active" : ""}`}
              aria-label="Toggle admin active"
              title={a.Status === "active" ? "Active — tap to deactivate" : "Inactive — tap to activate"}
            />
            <button onClick={() => startEdit(a)} className="btn btn-ghost btn-sm" style={{ padding: "6px 10px" }}><Icon name="Edit3" size={14} /></button>
            <button onClick={() => del(a.AdminID)} className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", padding: "6px 10px" }}><Icon name="Trash2" size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
});

// ===== OWNER ZONES =====
const OwnerZones = memo(({ deliveryZones, refreshDeliveryZones, showToast, t }) => {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ id: "", name: "", fee: "", eta: "" });

  async function add() {
    try {
      await apiPost("addDeliveryZone", { zone: { ...form, id: form.id || "zone-" + Math.random().toString(36).slice(2, 6), fee: Number(form.fee) } });
      refreshDeliveryZones(); setShowAdd(false); showToast("Zone added");
    } catch(e) { showToast("Failed", "error"); }
  }

  async function del(id) {
    if (!confirm("Delete this zone?")) return;
    try { await apiPost("deleteDeliveryZone", { id }); refreshDeliveryZones(); showToast("Deleted"); }
    catch(e) { showToast("Failed", "error"); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button onClick={() => setShowAdd(true)} className="btn btn-primary btn-sm" style={{ marginBottom: 12 }}><Icon name="Plus" size={14} /> Add Zone</button>
      {showAdd && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h4 className="font-display" style={{ marginBottom: 12 }}>Add Delivery Zone</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <div><label className="text-sm font-semibold text-secondary">ID</label><input value={form.id} onChange={e => setForm(f => ({ ...f, id: e.target.value }))} className="input" placeholder="e.g. piassa" /></div>
            <div><label className="text-sm font-semibold text-secondary">Name</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" /></div>
            <div><label className="text-sm font-semibold text-secondary">Fee (ETB)</label><input type="number" value={form.fee} onChange={e => setForm(f => ({ ...f, fee: e.target.value }))} className="input" /></div>
            <div><label className="text-sm font-semibold text-secondary">ETA</label><input value={form.eta} onChange={e => setForm(f => ({ ...f, eta: e.target.value }))} className="input" placeholder="15 min – 1 hr" /></div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={add} className="btn btn-primary btn-sm">Add</button>
            <button onClick={() => setShowAdd(false)} className="btn btn-secondary btn-sm">Cancel</button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {deliveryZones.map(z => (
          <div key={z.id} className="order-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{z.name}</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{etb(z.fee)} · {z.eta}</div>
            </div>
            <button onClick={() => del(z.id)} className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", padding: "6px 10px" }}><Icon name="Trash2" size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
});

// ===== RENDER =====
ReactDOM.createRoot(document.getElementById("root")).render(
  <ToastProvider><DessieShop /></ToastProvider>
);
