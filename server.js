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

// Sample product catalog
const CATALOG = {
  'nike-am90-black-10': {
    sku: 'nike-am90-black-10',
    name: 'Handcrafted Clay Bowl',
    price: 49.99,
    currency: 'USD',
    image: 'https://via.placeholder.com/300x200?text=Clay+Bowl',
  },
  'sony-wh1000xm5': {
    sku: 'sony-wh1000xm5',
    name: 'Terracotta Flower Vase',
    price: 89.99,
    currency: 'USD',
    image: 'https://via.placeholder.com/300x200?text=Flower+Vase',
  },
  'dyson-v15': {
    sku: 'dyson-v15',
    name: 'Ceramic Tea Set (6-piece)',
    price: 149.99,
    currency: 'USD',
    image: 'https://via.placeholder.com/300x200?text=Tea+Set',
  },
};

const SHIPPING_OPTIONS = [
  { id: 'standard', name: 'Standard Shipping', price: 5.99, estimatedDays: '5-7 business days' },
  { id: 'express', name: 'Express Shipping', price: 12.99, estimatedDays: '2-3 business days' },
  { id: 'overnight', name: 'Overnight Shipping', price: 24.99, estimatedDays: '1 business day' },
];

const TAX_RATE = 0.0875; // 8.75% example tax rate

// ---------------------------------------------------------------------------
// Helper: calculate totals
// ---------------------------------------------------------------------------
function calculateTotals(items, shippingId) {
  const subtotal = items.reduce((sum, item) => {
    const product = CATALOG[item.sku];
    return sum + (product ? product.price * item.quantity : 0);
  }, 0);

  const shipping = SHIPPING_OPTIONS.find(s => s.id === shippingId) || SHIPPING_OPTIONS[0];
  const tax = +(subtotal * TAX_RATE).toFixed(2);
  const total = +(subtotal + shipping.price + tax).toFixed(2);

  return { subtotal: +subtotal.toFixed(2), shipping: shipping.price, tax, total, shippingMethod: shipping };
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
  const { items, shipping_address, shipping_method } = req.body;

  if (!items || !items.length) {
    return res.status(400).json({ error: 'items is required and must be non-empty' });
  }

  // Validate items exist in catalog
  for (const item of items) {
    if (!CATALOG[item.sku]) {
      return res.status(400).json({ error: `Unknown product SKU: ${item.sku}` });
    }
  }

  const sessionId = uuidv4();
  const shippingId = shipping_method || 'standard';
  const totals = calculateTotals(items, shippingId);

  const session = {
    id: sessionId,
    status: 'created',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    items: items.map(item => ({
      ...item,
      product: CATALOG[item.sku],
      line_total: +(CATALOG[item.sku].price * item.quantity).toFixed(2),
    })),
    shipping_address: shipping_address || null,
    shipping_method: totals.shippingMethod,
    available_shipping_options: SHIPPING_OPTIONS,
    totals: {
      subtotal: totals.subtotal,
      shipping: totals.shipping,
      tax: totals.tax,
      total: totals.total,
      currency: 'USD',
    },
    payment: null,
    merchant: {
      name: process.env.GOOGLE_PAY_MERCHANT_NAME,
      return_policy_url: `${process.env.BASE_URL}/return-policy`,
      privacy_policy_url: `${process.env.BASE_URL}/privacy-policy`,
    },
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

  if (session.status === 'completed' || session.status === 'cancelled') {
    return res.status(409).json({ error: `Cannot update a ${session.status} session` });
  }

  const { shipping_address, shipping_method, promo_code } = req.body;

  if (shipping_address) {
    session.shipping_address = shipping_address;
  }

  if (shipping_method) {
    const totals = calculateTotals(
      session.items.map(i => ({ sku: i.product.sku || i.sku, quantity: i.quantity })),
      shipping_method
    );
    session.shipping_method = totals.shippingMethod;
    session.totals = {
      subtotal: totals.subtotal,
      shipping: totals.shipping,
      tax: totals.tax,
      total: totals.total,
      currency: 'USD',
    };
  }

  if (promo_code === 'DEMO20') {
    const discount = +(session.totals.subtotal * 0.20).toFixed(2);
    session.totals.discount = discount;
    session.totals.total = +(session.totals.total - discount).toFixed(2);
    session.promo_code = promo_code;
  }

  session.status = 'updated';
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
  if (session.status === 'cancelled') {
    return res.status(409).json({ error: 'Session was cancelled' });
  }

  const { paymentData } = req.body;
  if (!paymentData) {
    return res.status(400).json({ error: 'paymentData is required' });
  }

  // -------------------------------------------------------------------------
  // In production: forward the encrypted Google Pay token to MPGS
  //
  // const mpgsResult = await mpgsClient.pay({
  //   orderId: session.id,
  //   transactionId: uuidv4(),
  //   amount: session.totals.total,
  //   currency: session.totals.currency,
  //   sourceOfFunds: {
  //     type: 'CARD',
  //     provided: {
  //       card: {
  //         devicePayment: {
  //           paymentToken: paymentData.paymentMethodData.tokenizationData.token
  //         }
  //       }
  //     }
  //   }
  // });
  // -------------------------------------------------------------------------

  // DEMO MODE: Simulate successful MPGS payment
  const orderId = `ORD-${Date.now()}`;
  const mpgsSimulated = {
    result: 'SUCCESS',
    gatewayCode: 'APPROVED',
    authorizationCode: `AUTH${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
    transactionId: `TXN-${uuidv4().slice(0, 8)}`,
  };

  session.status = 'completed';
  session.updated_at = new Date().toISOString();
  session.payment = {
    method: 'google_pay',
    gateway: 'mpgs',
    status: mpgsSimulated.result,
    authorization_code: mpgsSimulated.authorizationCode,
    transaction_id: mpgsSimulated.transactionId,
    gateway_response: mpgsSimulated,
  };

  const order = {
    id: orderId,
    session_id: session.id,
    status: 'confirmed',
    items: session.items,
    shipping_address: session.shipping_address,
    shipping_method: session.shipping_method,
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

  session.status = 'cancelled';
  session.updated_at = new Date().toISOString();
  sessions.set(session.id, session);

  console.log(`[UCP] Session cancelled: ${session.id}`);
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
