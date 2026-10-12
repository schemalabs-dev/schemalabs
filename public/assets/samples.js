/** SAMPLE data only: fictional purchase schemas, not customer data. */
export const baselineSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Sample Purchase',
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'paid', 'refunded'] },
    total: { type: 'number', minimum: 0 },
    currency: { type: 'string', enum: ['USD', 'VND'] },
  },
  required: ['id', 'total'],
};

export const candidateSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Sample Purchase',
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'paid'] },
    total: { type: 'integer', minimum: 1 },
    currency: { type: 'string', enum: ['USD', 'VND'] },
  },
  required: ['id', 'total', 'currency'],
};

export const samplePayload = {
  id: 'sample-purchase-001',
  status: 'refunded',
  total: 0.5,
};

/** SAMPLE data only: a simplified, fictional webhook event modelled on payment-event APIs, not an official Stripe schema. */
const webhookObject = (amountMinimum, currencies, required) => ({
  type: 'object',
  properties: {
    id: { type: 'string' },
    amount: { type: 'integer', minimum: amountMinimum },
    currency: { type: 'string', enum: currencies },
    status: { type: 'string', enum: ['succeeded', 'failed'] },
  },
  required,
});
const webhook = (eventTypes, amountMinimum, currencies, objectRequired, required) => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Sample Webhook Event',
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: eventTypes },
    created: { type: 'integer', minimum: 0 },
    livemode: { type: 'boolean' },
    data: { type: 'object', properties: { object: webhookObject(amountMinimum, currencies, objectRequired) }, required: ['object'] },
  },
  required,
});
const webhookBaseline = webhook(['payment_intent.succeeded', 'payment_intent.payment_failed', 'charge.refunded'], 0, ['usd', 'eur', 'vnd'], ['id', 'amount', 'currency'], ['id', 'type', 'created', 'data']);
const webhookCandidate = webhook(['payment_intent.succeeded', 'payment_intent.payment_failed'], 1, ['usd', 'eur'], ['id', 'amount', 'currency', 'status'], ['id', 'type', 'created', 'data', 'livemode']);

/** Playground samples: a baseline, a candidate revision and a payload valid against the baseline. */
export const samples = {
  order: { label: 'Order Checkout (Default)', baseline: baselineSchema, candidate: candidateSchema, payload: samplePayload },
  webhook: {
    label: 'Stripe Webhook Event (Draft-07)', baseline: webhookBaseline, candidate: webhookCandidate,
    payload: { id: 'evt_sample_001', type: 'charge.refunded', created: 1760000000, data: { object: { id: 'ch_sample_001', amount: 0, currency: 'vnd', status: 'succeeded' } } },
  },
};
