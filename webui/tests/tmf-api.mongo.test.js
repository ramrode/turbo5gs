/*
 * TMF API against a REAL MongoDB, through the production mongooseRepos().
 *
 * Opt-in: runs only when CHF_TMF_MONGO_URI is set, e.g.
 *   CHF_TMF_MONGO_URI=mongodb://127.0.0.1:27999 npx jest tmf-api.mongo
 * It creates, and drops, its own uniquely named database.
 *
 * The in-memory suite proves the HTTP layer and the rules.  This one proves
 * what only the real driver can: that the conditional top-up write actually
 * matches a stored BSON Date and a missing periodStart, that unique indexes
 * reject duplicates, that Mongoose 5 update results are read correctly, and
 * that two concurrent requests with one Idempotency-Key credit once.
 */
'use strict';

const URI = process.env.CHF_TMF_MONGO_URI;
const maybe = URI ? describe : describe.skip;

const GB = 1073741824;
const MONTH = 2592000;

maybe('TMF API on real MongoDB', () => {
  const express = require('express');
  const mongoose = require('mongoose');
  const { createTmfRouter, mongooseRepos } = require('../server/tmf');

  let server, base, dbName;
  const Sub = () => mongoose.model('ChfSubscriber');

  beforeAll(async () => {
    dbName = `chf_tmf_it_${process.pid}_${Date.now()}`;
    await mongoose.connect(`${URI}/${dbName}`, {
      useNewUrlParser: true, useUnifiedTopology: true });

    const repos = mongooseRepos();
    /* Indexes build asynchronously; unique-key behaviour needs them first. */
    await Promise.all(['ChfSubscriber', 'TmfIndividual', 'TmfBillingAccount',
      'TmfTopupBalance'].map(n => mongoose.model(n).init()));

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { roles: ['admin'] }; next(); });
    app.use('/api/tmf-api', createTmfRouter(repos));
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/tmf-api`;
  }, 30000);

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r));
    if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  });

  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, { method,
      headers: Object.assign(body === undefined ? {}
        : { 'Content-Type': 'application/json' }, headers),
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const BK = '/prepayBalanceManagement/v4/bucket';
  const T = '/prepayBalanceManagement/v4/topupBalance';
  const provision = n => call('POST', BK, {
    logicalResource: [{ id: `imsi-99970000000${String(n).padStart(4, '0')}` }],
    allowance: { amount: 10, units: 'GB' }, validitySeconds: MONTH });
  const supi = n => `imsi-99970000000${String(n).padStart(4, '0')}`;

  test('M1. provisioning stores the shape the CHF reads; duplicate SUPI is 409', async () => {
    expect((await provision(1)).status).toBe(201);
    const doc = await Sub().findOne({ supi: supi(1) }).lean();
    expect(doc.quota).toMatchObject({ totalQuotaBytes: 10 * GB,
      validitySeconds: MONTH, autoRenew: true });
    expect((await provision(1)).status).toBe(409);
  });

  test('M2. top-up on a never-used bucket: null filter matches a MISSING periodStart', async () => {
    await provision(2);
    const res = await call('POST', T, { bucket: { id: supi(2) },
      amount: { amount: 1, units: 'GB' } });
    expect(res.status).toBe(201);
    expect(res.body.reactivated).toBe(true);
    const doc = await Sub().findOne({ supi: supi(2) }).lean();
    expect(doc.usage.topupBytes).toBe(GB);
    expect(doc.usage.periodStart instanceof Date).toBe(true);
  });

  test('M3. top-up on an active cycle: conditional write matches the stored BSON Date', async () => {
    await provision(3);
    /* Write the cycle as the CHF does: a BSON date and a counter. */
    await Sub().updateOne({ supi: supi(3) }, { $set: {
      'usage.periodStart': new Date(Date.now() - 3600 * 1000),
      'usage.consumedBytes': 4 * GB, 'usage.topupBytes': 0 } });

    const res = await call('POST', T, { bucket: { id: supi(3) },
      amount: { amount: 2, units: 'GB' } });
    /* 'conflict' here would mean the Date equality never matches in real Mongo. */
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'completed', reactivated: false });

    const doc = await Sub().findOne({ supi: supi(3) }).lean();
    expect(doc.usage.consumedBytes).toBe(4 * GB);
    expect(doc.usage.topupBytes).toBe(2 * GB);
    const got = await call('GET', `${BK}/${supi(3)}`);
    expect(got.body.remainingValue.amount).toBe(8 * GB);
  });

  test('M4. PATCH leaves the CHF counter exactly as it was', async () => {
    await provision(4);
    const periodStart = new Date(Date.now() - 7200 * 1000);
    await Sub().updateOne({ supi: supi(4) }, { $set: {
      'usage.periodStart': periodStart, 'usage.consumedBytes': 3 * GB,
      'usage.topupBytes': GB } });
    const before = (await Sub().findOne({ supi: supi(4) }).lean()).usage;

    const res = await call('PATCH', `${BK}/${supi(4)}`, {
      allowance: { amount: 20, units: 'GB' }, finalUnitAction: 'REDIRECT' });
    expect(res.status).toBe(200);
    const after = (await Sub().findOne({ supi: supi(4) }).lean()).usage;
    expect(after).toEqual(before);
  });

  test('M5. concurrent requests with one Idempotency-Key credit ONCE', async () => {
    await provision(5);
    await Sub().updateOne({ supi: supi(5) }, { $set: {
      'usage.periodStart': new Date(Date.now() - 60 * 1000),
      'usage.consumedBytes': 0, 'usage.topupBytes': 0 } });

    const h = { 'Idempotency-Key': `it-${Date.now()}` };
    const body = { bucket: { id: supi(5) }, amount: { amount: 1, units: 'GB' } };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call('POST', T, body, h)));

    const ids = new Set(results.map(r => r.body.id));
    expect(ids.size).toBe(1);
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    const doc = await Sub().findOne({ supi: supi(5) }).lean();
    expect(doc.usage.topupBytes).toBe(GB);
  });

  test('M6. party/account PATCH (findOneAndReplace) and the array delete guard', async () => {
    const a = (await call('POST', '/partyManagement/v4/individual', { givenName: 'A' })).body;
    const b = (await call('POST', '/partyManagement/v4/individual', { givenName: 'B' })).body;
    const acct = await call('POST', '/accountManagement/v4/billingAccount',
      { name: 'Shared', relatedParty: [{ id: a.id }, { id: b.id }] });
    expect(acct.status).toBe(201);

    const renamed = await call('PATCH',
      `/accountManagement/v4/billingAccount/${acct.body.id}`, { name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Renamed');
    expect(renamed.body.relatedParty.map(p => p.id)).toEqual([a.id, b.id]);

    /* b is the SECOND element of relatedParty. */
    expect((await call('DELETE', `/partyManagement/v4/individual/${b.id}`)).status)
      .toBe(409);
  });
});
