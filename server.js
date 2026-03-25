require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/docs', express.static(path.join(__dirname, 'docs')));

// ---------------------------------------------------------------------------
// In-memory store (replace with DB in production)
// ---------------------------------------------------------------------------
const sessions = new Map();
const orders = new Map();

// Sample product catalog — keyed by product ID (matches Merchant Center feed)
const CATALOG = {
  'clay_bowl_001': {
    id: 'clay_bowl_001',
    title: 'Handcrafted Clay Bowl',
    price: 4999,
    currency: 'USD',
    image_url: 'https://via.placeholder.com/300x200?text=Clay+Bowl',
  },
  'flower_vase_002': {
    id: 'flower_vase_002',
    title: 'Terracotta Flower Vase',
    price: 8999,
    currency: 'USD',
    image_url: 'https://via.placeholder.com/300x200?text=Flower+Vase',
  },
  'tea_set_003': {
    id: 'tea_set_003',
    title: 'Ceramic Tea Set (6-piece)',
    price: 14999,
    currency: 'USD',
    image_url: 'https://via.placeholder.com/300x200?text=Tea+Set',
  },
};

const SHIPPING_OPTIONS = [
  { id: 'ship_standard', title: 'Standard Shipping (5-7 days)', total: 599 },
  { id: 'ship_express', title: 'Express Shipping (2-3 days)', total: 1299 },
  { id: 'ship_overnight', title: 'Overnight Shipping (1 day)', total: 2499 },
];

const TAX_RATE = 0.0875; // 8.75% example tax rate

// ---------------------------------------------------------------------------
// Helper: calculate totals (all amounts in integer cents)
// ---------------------------------------------------------------------------
function calculateTotals(lineItems, shippingId) {
  const subtotal = lineItems.reduce((sum, li) => {
    const product = CATALOG[li.item.id];
    return sum + (product ? product.price * li.quantity : 0);
  }, 0);

  const shipping = SHIPPING_OPTIONS.find(s => s.id === shippingId) || SHIPPING_OPTIONS[0];
  const tax = Math.round(subtotal * TAX_RATE);
  const total = subtotal + shipping.total + tax;

  return { subtotal, shipping: shipping.total, tax, total, shippingOption: shipping };
}

// ---------------------------------------------------------------------------
// UCP Profile — GET /.well-known/ucp
// Spec: https://developers.google.com/merchant/ucp/guides/ucp-profile
// ---------------------------------------------------------------------------
app.get('/.well-known/ucp', (req, res) => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const ucpVersion = '2026-01-23';

  res.json({
    ucp: {
      version: ucpVersion,
      services: {
        'dev.ucp.shopping': {
          version: ucpVersion,
          spec: 'https://ucp.dev/specs/shopping',
          rest: {
            schema: 'https://ucp.dev/services/shopping/openapi.json',
            endpoint: baseUrl,
          },
        },
      },
      capabilities: [
        {
          name: 'dev.ucp.shopping.checkout',
          version: ucpVersion,
          spec: 'https://ucp.dev/specs/shopping/checkout',
          schema: 'https://ucp.dev/schemas/shopping/checkout.json',
        },
        {
          name: 'dev.ucp.shopping.fulfillment',
          version: ucpVersion,
          spec: 'https://ucp.dev/specs/shopping/fulfillment',
          schema: 'https://ucp.dev/schemas/shopping/fulfillment.json',
          extends: 'dev.ucp.shopping.checkout',
        },
        {
          name: 'dev.ucp.shopping.order',
          version: ucpVersion,
          spec: 'https://ucp.dev/specs/shopping/order',
          schema: 'https://ucp.dev/schemas/shopping/order.json',
        },
        {
          name: 'dev.ucp.shopping.discount',
          version: ucpVersion,
          spec: 'https://ucp.dev/specs/shopping/discount',
          schema: 'https://ucp.dev/schemas/shopping/discount.json',
          extends: 'dev.ucp.shopping.checkout',
        },
      ],
    },
    payment: {
      handlers: [
        {
          id: 'gpay_handler',
          name: 'com.google.pay',
          version: ucpVersion,
          spec: 'https://pay.google.com/gp/p/ucp/2026-01-23/',
          config_schema: 'https://pay.google.com/gp/p/ucp/2026-01-23/schemas/config.json',
          instrument_schemas: [
            'https://ucp.dev/schemas/shopping/types/card_payment_instrument.json',
          ],
          config: {
            allowed_payment_methods: [
              {
                type: 'CARD',
                parameters: {
                  allowed_auth_methods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
                  allowed_card_networks: ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'],
                },
                tokenization_specification: {
                  type: 'PAYMENT_GATEWAY',
                  parameters: {
                    gateway: process.env.MPGS_GATEWAY || 'mpgs',
                    gatewayMerchantId: process.env.MPGS_GATEWAY_MERCHANT_ID || 'TESTMIDtesting00',
                  },
                },
              },
            ],
          },
        },
      ],
    },
    signing_keys: [
      // TODO: Generate real EC P-256 keypair for production webhook verification
      // Use: openssl ecparam -genkey -name prime256v1 -noout -out private.pem
      //      openssl ec -in private.pem -pubout -out public.pem
      // Then convert public key to JWK format
      {
        kid: 'meenakshi_dev_2025',
        kty: 'EC',
        crv: 'P-256',
        x: 'WbbXwVYGdJoP4Xm3qCkGvBRcRvKtEfXDbWvPzpPS8LA',
        y: 'sP4jHHxYqC89HBo8TjrtVOAGHfJDflYxw7MFMxuFMPY',
        use: 'sig',
        alg: 'ES256',
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// Products API (for demo frontend)
// ---------------------------------------------------------------------------
app.get('/api/products', (req, res) => {
  res.json(Object.values(CATALOG));
});

// ---------------------------------------------------------------------------
// UCP Checkout Session Endpoints
// ---------------------------------------------------------------------------

// POST /checkout-sessions — Create a new checkout session
app.post('/checkout-sessions', (req, res) => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const ucpVersion = '2026-01-23';

  // Accept both UCP format (line_items[].item.id) and legacy (items[].sku)
  let lineItems = req.body.line_items;
  if (!lineItems && req.body.items) {
    // Legacy frontend format — convert items[].sku to line_items[].item.id
    lineItems = req.body.items.map(i => ({ item: { id: i.sku }, quantity: i.quantity }));
  }

  if (!lineItems || !lineItems.length) {
    return res.status(400).json({ error: 'line_items is required and must be non-empty' });
  }

  // Validate products exist in catalog
  for (const li of lineItems) {
    if (!CATALOG[li.item.id]) {
      return res.status(400).json({ error: `Unknown product ID: ${li.item.id}` });
    }
  }

  const sessionId = uuidv4();
  const shippingId = req.body.shipping_method || 'ship_standard';
  const totals = calculateTotals(lineItems, shippingId);

  const session = {
    ucp: {
      version: ucpVersion,
      capabilities: [
        { name: 'dev.ucp.shopping.checkout', version: ucpVersion },
        { name: 'dev.ucp.shopping.fulfillment', version: ucpVersion, extends: 'dev.ucp.shopping.checkout' },
      ],
    },
    id: sessionId,
    status: 'incomplete',
    currency: 'USD',
    line_items: lineItems.map((li, idx) => {
      const product = CATALOG[li.item.id];
      const lineTotal = product.price * li.quantity;
      return {
        id: `line_${idx + 1}`,
        item: {
          id: product.id,
          title: product.title,
          price: product.price,
          image_url: product.image_url,
        },
        quantity: li.quantity,
        totals: [
          { type: 'subtotal', amount: lineTotal },
          { type: 'total', amount: lineTotal },
        ],
      };
    }),
    totals: [
      { type: 'subtotal', amount: totals.subtotal },
      { type: 'fulfillment', display_text: totals.shippingOption.title, amount: totals.shipping },
      { type: 'tax', amount: totals.tax },
      { type: 'total', amount: totals.total },
    ],
    payment: {
      handlers: [
        {
          id: 'gpay_handler',
          name: 'com.google.pay',
          version: ucpVersion,
          spec: 'https://pay.google.com/gp/p/ucp/2026-01-23/',
          config_schema: 'https://pay.google.com/gp/p/ucp/2026-01-23/schemas/config.json',
          instrument_schemas: ['https://ucp.dev/schemas/shopping/types/card_payment_instrument.json'],
          config: {
            allowed_payment_methods: [{
              type: 'CARD',
              parameters: {
                allowed_auth_methods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
                allowed_card_networks: ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'],
              },
              tokenization_specification: {
                type: 'PAYMENT_GATEWAY',
                parameters: {
                  gateway: process.env.MPGS_GATEWAY || 'mpgs',
                  gatewayMerchantId: process.env.MPGS_GATEWAY_MERCHANT_ID || 'TESTMIDtesting00',
                },
              },
            }],
          },
        },
      ],
    },
    fulfillment: {
      methods: [{
        id: 'method_shipping',
        type: 'shipping',
        line_item_ids: lineItems.map((_, idx) => `line_${idx + 1}`),
        destinations: req.body.fulfillment?.methods?.[0]?.destinations || [],
        selected_destination_id: null,
        groups: [{
          id: 'group_1',
          line_item_ids: lineItems.map((_, idx) => `line_${idx + 1}`),
          options: SHIPPING_OPTIONS.map(s => ({
            id: s.id,
            title: s.title,
            totals: [{ type: 'total', amount: s.total }],
          })),
          selected_option_id: shippingId,
        }],
      }],
    },
    links: [
      { type: 'terms_of_service', url: `${baseUrl}/terms`, title: 'Terms of Service' },
      { type: 'privacy_policy', url: `${baseUrl}/privacy-policy`, title: 'Privacy Policy' },
    ],
    messages: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  sessions.set(sessionId, session);
  console.log(`[UCP] Session created: ${sessionId}`);
  res.status(201).json(session);
});

// GET /checkout-sessions/:id — Retrieve a checkout session
app.get('/checkout-sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// PUT /checkout-sessions/:id — Update a checkout session
app.put('/checkout-sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.status === 'completed' || session.status === 'canceled') {
    return res.status(409).json({ error: `Cannot update a ${session.status} session` });
  }

  // Update fulfillment destinations (shipping address)
  if (req.body.fulfillment?.methods?.[0]?.destinations) {
    session.fulfillment.methods[0].destinations = req.body.fulfillment.methods[0].destinations;
    if (req.body.fulfillment.methods[0].selected_destination_id) {
      session.fulfillment.methods[0].selected_destination_id = req.body.fulfillment.methods[0].selected_destination_id;
    }
  }

  // Legacy frontend: flat shipping_address
  if (req.body.shipping_address) {
    session.fulfillment.methods[0].destinations = [{
      id: 'addr_1',
      street_address: req.body.shipping_address.street,
      address_locality: req.body.shipping_address.city,
      address_region: req.body.shipping_address.state,
      postal_code: req.body.shipping_address.zip,
      address_country: req.body.shipping_address.country || 'US',
    }];
    session.fulfillment.methods[0].selected_destination_id = 'addr_1';
  }

  // Update selected shipping option
  const shippingId = req.body.fulfillment?.methods?.[0]?.groups?.[0]?.selected_option_id
    || req.body.shipping_method
    || session.fulfillment.methods[0].groups[0].selected_option_id;

  if (shippingId) {
    session.fulfillment.methods[0].groups[0].selected_option_id = shippingId;
  }

  // Recalculate totals
  const calcItems = session.line_items.map(li => ({ item: { id: li.item.id }, quantity: li.quantity }));
  const totals = calculateTotals(calcItems, shippingId);
  session.totals = [
    { type: 'subtotal', amount: totals.subtotal },
    { type: 'fulfillment', display_text: totals.shippingOption.title, amount: totals.shipping },
    { type: 'tax', amount: totals.tax },
    { type: 'total', amount: totals.total },
  ];

  // Promo code support (legacy + UCP discounts)
  const promoCode = req.body.promo_code || req.body.discounts?.codes?.[0];
  if (promoCode === 'DEMO20') {
    const discount = Math.round(totals.subtotal * 0.20);
    session.totals.splice(3, 0, { type: 'discount', display_text: '20% off (DEMO20)', amount: -discount });
    const totalEntry = session.totals.find(t => t.type === 'total');
    totalEntry.amount = totals.total - discount;
  }

  session.updated_at = new Date().toISOString();
  sessions.set(session.id, session);

  console.log(`[UCP] Session updated: ${session.id}`);
  res.json(session);
});

// POST /checkout-sessions/:id/complete — Complete checkout (process payment)
app.post('/checkout-sessions/:id/complete', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.status === 'completed') {
    return res.status(409).json({ error: 'Session already completed' });
  }
  if (session.status === 'canceled') {
    return res.status(409).json({ error: 'Session was canceled' });
  }

  // Accept both UCP format (payment_data) and legacy (paymentData)
  const paymentData = req.body.payment_data || req.body.paymentData;
  if (!paymentData) {
    return res.status(400).json({ error: 'payment_data is required' });
  }

  // DEMO MODE: Simulate successful MPGS payment
  // In production: forward the encrypted Google Pay token to MPGS
  const orderId = `ord_${uuidv4().slice(0, 12)}`;
  const transactionId = `TXN-${uuidv4().slice(0, 8)}`;
  const mpgsSimulated = {
    result: 'SUCCESS',
    gatewayCode: 'APPROVED',
    authorizationCode: `AUTH${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
    transactionId,
  };

  session.status = 'completed';
  session.updated_at = new Date().toISOString();
  session.payment.authorization_code = mpgsSimulated.authorizationCode;
  session.payment.transaction_id = transactionId;
  session.payment.status = mpgsSimulated.result;
  session.payment.gateway_response = mpgsSimulated;
  session.order_id = orderId;

  const order = {
    id: orderId,
    checkout_id: session.id,
    status: 'confirmed',
    line_items: session.line_items,
    fulfillment: session.fulfillment,
    totals: session.totals,
    payment: session.payment,
    created_at: new Date().toISOString(),
  };

  orders.set(orderId, order);
  sessions.set(session.id, session);

  console.log(`[UCP] Payment completed: ${session.id} → Order ${orderId}`);
  console.log(`[MPGS] Simulated auth: ${mpgsSimulated.authorizationCode}`);

  res.json({
    status: 'completed',
    order_id: orderId,
    session: session,
    order: order,
  });
});

// POST /checkout-sessions/:id/cancel — Cancel a checkout session
app.post('/checkout-sessions/:id/cancel', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.status === 'completed') {
    return res.status(409).json({ error: 'Cannot cancel a completed session' });
  }

  session.status = 'canceled';
  session.updated_at = new Date().toISOString();
  sessions.set(session.id, session);

  console.log(`[UCP] Session canceled: ${session.id}`);
  res.json(session);
});

// ---------------------------------------------------------------------------
// Order status endpoint (for webhook simulation)
// ---------------------------------------------------------------------------
app.get('/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// ---------------------------------------------------------------------------
// Static policy pages (required by UCP)
// ---------------------------------------------------------------------------
app.get('/return-policy', (req, res) => {
  res.send('<html><body><h1>Return Policy</h1><p>30-day free returns on all items.</p></body></html>');
});
app.get('/privacy-policy', (req, res) => {
  res.send('<html><body><h1>Privacy Policy</h1><p>We respect your privacy. Demo store.</p></body></html>');
});
app.get('/terms', (req, res) => {
  res.send('<html><body><h1>Terms of Service</h1><p>Demo terms of service.</p></body></html>');
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Vercel: export the app for serverless; locally: listen on PORT
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`\n🚀 UCP PoC Server running at http://localhost:${PORT}`);
    console.log(`📋 UCP Profile:    http://localhost:${PORT}/.well-known/ucp`);
    console.log(`🛍️  Products API:   http://localhost:${PORT}/api/products`);
    console.log(`💳 Google Pay env: ${process.env.GOOGLE_PAY_ENVIRONMENT || 'TEST'}`);
    console.log(`🏦 MPGS Gateway:   ${process.env.MPGS_GATEWAY || 'mpgs'} (merchant: ${process.env.MPGS_GATEWAY_MERCHANT_ID || 'not set'})`);
    console.log(`\n📊 Flow diagrams:  http://localhost:${PORT}/docs/payment-flow-diagrams.html\n`);
  });
}

module.exports = app;
