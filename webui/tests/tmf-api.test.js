/*
 * TM Forum API (TMF632 / TMF666 / TMF654) — exercised over real HTTP against
 * in-memory repositories.  No MongoDB needed.
 *
 * The money invariants get the most attention: a Bucket PATCH must never
 * touch the CHF's usage counter, the published balance must equal what the
 * CHF would grant, and a top-up must land exactly once.
 */
'use strict';

const express = require('express');
const { createTmfRouter } = require('../server/tmf');
const { memoryRepo } = require('../server/tmf/repo');
const B = require('../server/tmf/bucket-map');

const GB = 1073741824;
const MONTH = 2592000;
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const DAY_MS = 86400 * 1000;
const ISO = ms => new Date(ms).toISOString();

let server, base, repos, role;

function makeRepos() {
  return {
    individual: memoryRepo('id'),
    billingAccount: memoryRepo('id'),
    bucket: memoryRepo('bucketId'),
    topupBalance: memoryRepo('id'),
    notification: memoryRepo('id'),
  };
}

beforeEach(async () => {
  repos = makeRepos();
  role = 'admin';
  const app = express();
  app.use(express.json());
  /* Stand-in for passport-jwt: the router only reads req.user.roles. */
  app.use((req, res, next) => { req.user = { roles: [role] }; next(); });
  app.use('/api/tmf-api', createTmfRouter(repos, () => NOW));
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/tmf-api`;
});

afterEach(() => new Promise(r => server.close(r)));

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: Object.assign(
      body === undefined ? {} : { 'Content-Type': 'application/json' }, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers,
           body: text ? JSON.parse(text) : null };
}

const P = '/partyManagement/v4/individual';
const A = '/accountManagement/v4/billingAccount';
const BK = '/prepayBalanceManagement/v4/bucket';
const T = '/prepayBalanceManagement/v4/topupBalance';

const supi = n => `imsi-99970000000000${n}`;

async function seedBucket(n, quota, usage) {
  const doc = { supi: supi(n), bucketId: supi(n), quota: Object.assign({
    totalQuotaBytes: 10 * GB, validityPeriod: 'monthly',
    validitySeconds: MONTH, autoRenew: true, finalUnitAction: 'TERMINATE',
  }, quota) };
  if (usage) doc.usage = usage;
  await repos.bucket.create(doc);
  return repos.bucket.docs.find(d => d.supi === supi(n));
}

/* ================================================================== */
describe('TMF630 conventions', () => {
  test('1. list paging: headers, and 206 for a partial page', async () => {
    for (let i = 0; i < 3; i++)
      await call('POST', P, { givenName: `u${i}` });
    const page = await call('GET', `${P}?offset=0&limit=2`);
    expect(page.status).toBe(206);
    expect(page.headers.get('x-total-count')).toBe('3');
    expect(page.headers.get('x-result-count')).toBe('2');
    const all = await call('GET', `${P}?limit=10`);
    expect(all.status).toBe(200);
  });

  test('2. ?fields= projection keeps id, href and @type', async () => {
    const { body } = await call('POST', P, { givenName: 'Ada', familyName: 'L' });
    const got = await call('GET', `${P}/${body.id}?fields=givenName`);
    expect(Object.keys(got.body).sort())
      .toEqual(['@type', 'givenName', 'href', 'id']);
  });

  test('3. filters are whitelisted - no operator injection', async () => {
    expect((await call('GET', `${P}?%24where=1`)).status).toBe(400);
    expect((await call('GET', `${P}?password=x`)).status).toBe(400);
    const nested = await call('GET', `${P}?givenName[%24ne]=x`);
    expect(nested.status).toBe(400);
  });

  test('4. errors use the TMF Error shape', async () => {
    const { status, body } = await call('GET', `${P}/nope`);
    expect(status).toBe(404);
    expect(body).toMatchObject({ '@type': 'Error', code: '404',
      status: '404', reason: 'Not Found' });
  });

  test('5. non-admin may read but not write', async () => {
    role = 'user';
    expect((await call('GET', P)).status).toBe(200);
    expect((await call('POST', P, { givenName: 'x' })).status).toBe(403);
  });

  test('6. PATCH accepts application/merge-patch+json', async () => {
    const { body } = await call('POST', P, { givenName: 'A', familyName: 'B' });
    const res = await call('PATCH', `${P}/${body.id}`, { familyName: 'C' },
        { 'Content-Type': 'application/merge-patch+json' });
    expect(res.status).toBe(200);
    expect(res.body.familyName).toBe('C');
  });

  test('7. unknown TMF path is a TMF 404', async () => {
    const { status, body } = await call('GET', '/nonesuch/v4/thing');
    expect(status).toBe(404);
    expect(body['@type']).toBe('Error');
  });
});

/* ================================================================== */
describe('TMF632 Individual', () => {
  test('8. create returns 201, Location and a server id', async () => {
    const res = await call('POST', P, { givenName: 'Grace', familyName: 'Hopper' });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('location')).toBe(res.body.href);
    expect(res.body.status).toBe('initialized');
  });

  test('9. validation: a name is required; id is read-only', async () => {
    expect((await call('POST', P, { status: 'validated' })).status).toBe(400);
    expect((await call('POST', P, { id: 'mine', givenName: 'x' })).status).toBe(400);
    expect((await call('POST', P, { givenName: 'x', status: 'bogus' })).status)
      .toBe(400);
  });

  test('10. merge patch: null removes a member', async () => {
    const { body } = await call('POST', P,
        { givenName: 'A', familyName: 'B', title: 'Dr' });
    const res = await call('PATCH', `${P}/${body.id}`, { title: null });
    expect(res.body).not.toHaveProperty('title');
    expect(res.body.givenName).toBe('A');
  });

  test('11. delete is refused while a billing account references it', async () => {
    /* The target is the SECOND owner of a shared account: the reference sits
     * inside an array, not at its head, which is what exercises MongoDB's
     * any-element matching of 'relatedParty.id'. */
    const first = (await call('POST', P, { givenName: 'First' })).body;
    const p = (await call('POST', P, { givenName: 'Owner' })).body;
    await call('POST', A, { name: 'Shared',
      relatedParty: [{ id: first.id }, { id: p.id }] });
    expect((await call('DELETE', `${P}/${p.id}`)).status).toBe(409);

    const free = (await call('POST', P, { givenName: 'Free' })).body;
    expect((await call('DELETE', `${P}/${free.id}`)).status).toBe(204);
  });
});

/* ================================================================== */
describe('TMF666 BillingAccount', () => {
  test('12. relatedParty must reference an existing Individual', async () => {
    const res = await call('POST', A, { name: 'X', relatedParty: [{ id: 'ghost' }] });
    expect(res.status).toBe(400);
  });

  test('13. create links the party with a derived href', async () => {
    const p = (await call('POST', P, { givenName: 'Owner' })).body;
    const res = await call('POST', A, { name: 'Acme', relatedParty: [{ id: p.id }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: 'active', accountType: 'prepaid' });
    expect(res.body.relatedParty[0].href)
      .toBe(`${base}/partyManagement/v4/individual/${p.id}`);
  });

  test('14. delete is refused while buckets are charged to it', async () => {
    const a = (await call('POST', A, { name: 'Acme' })).body;
    await call('POST', BK, { logicalResource: [{ id: supi(1) }],
      allowance: { amount: 1, units: 'GB' }, partyAccount: { id: a.id } });
    expect((await call('DELETE', `${A}/${a.id}`)).status).toBe(409);
  });
});

/* ================================================================== */
describe('TMF654 Bucket scope', () => {
  test('S1. a bucket with no scope is the catch-all, addressed by SUPI', async () => {
    const res = await call('POST', BK, {
      logicalResource: [{ id: supi(1) }], allowance: { amount: 10, units: 'GB' } });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(supi(1));
    expect(res.body.scope).toEqual({});
    expect(res.body.priority).toBe(0);

    /* Only one catch-all per subscriber. */
    const dup = await call('POST', BK, {
      logicalResource: [{ id: supi(1) }], allowance: { amount: 1, units: 'GB' } });
    expect(dup.status).toBe(409);
  });

  test('S2. a scoped bucket gets its own id and keeps its scope', async () => {
    await call('POST', BK, {
      logicalResource: [{ id: supi(2) }], allowance: { amount: 10, units: 'GB' } });

    const res = await call('POST', BK, {
      logicalResource: [{ id: supi(2) }],
      allowance: { amount: 2, units: 'GB' },
      scope: { sNSSAI: { sst: 1, sd: 'AABBCC' }, dnn: 'ims',
               hPlmnId: { mcc: '999', mnc: '70' }, roaming: 'outBound' },
      priority: 50 });

    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(supi(2));
    expect(res.body.id.startsWith(supi(2))).toBe(true);
    expect(res.body.scope).toEqual({
      sNSSAI: { sst: 1, sd: 'aabbcc' }, dnn: 'ims',
      hPlmnId: { mcc: '999', mnc: '70' }, roaming: 'outBound' });
    expect(res.body.priority).toBe(50);
    expect(res.body.name).toContain('slice 1/aabbcc');

    /* Both buckets belong to the subscriber and are listed by SUPI. */
    const mine = await call('GET', `${BK}?logicalResource.id=${supi(2)}`);
    expect(mine.body).toHaveLength(2);
  });

  test('S3. scope is validated', async () => {
    const bad = [
      { sNSSAI: { sst: 300 } },
      { sNSSAI: { sd: 'aabbcc' } },
      { sNSSAI: { sst: 1, sd: 'nothex' } },
      { hPlmnId: { mcc: '99', mnc: '70' } },
      { roaming: 'sometimes' },
      { unknownDimension: 'x' },
    ];
    for (const scope of bad) {
      const res = await call('POST', BK, {
        logicalResource: [{ id: supi(3) }],
        allowance: { amount: 1, units: 'GB' }, scope });
      expect(res.status).toBe(400);
    }
    const priority = await call('POST', BK, {
      logicalResource: [{ id: supi(3) }],
      allowance: { amount: 1, units: 'GB' }, priority: 1.5 });
    expect(priority.status).toBe(400);
  });

  test('S4. PATCH changes scope and priority, and can reopen a dimension', async () => {
    const created = await call('POST', BK, {
      logicalResource: [{ id: supi(4) }], allowance: { amount: 5, units: 'GB' },
      scope: { dnn: 'ims' }, priority: 10 });
    const id = created.body.id;

    const moved = await call('PATCH', `${BK}/${id}`, {
      scope: { sNSSAI: { sst: 2 } }, priority: 20 });
    expect(moved.status).toBe(200);
    expect(moved.body.scope).toEqual({ sNSSAI: { sst: 2 } });
    expect(moved.body.priority).toBe(20);

    /* An empty scope makes it cover everything the subscriber does. */
    const opened = await call('PATCH', `${BK}/${id}`, { scope: {} });
    expect(opened.body.scope).toEqual({});
  });

  test('S5. a top-up targets one bucket, leaving the others alone', async () => {
    await call('POST', BK, {
      logicalResource: [{ id: supi(5) }], allowance: { amount: 10, units: 'GB' } });
    const scoped = await call('POST', BK, {
      logicalResource: [{ id: supi(5) }], allowance: { amount: 1, units: 'GB' },
      scope: { dnn: 'ims' }, priority: 10 });

    const top = await call('POST', T, { bucket: { id: scoped.body.id },
      amount: { amount: 500, units: 'MB' } });
    expect(top.status).toBe(201);

    const after = await call('GET', `${BK}/${scoped.body.id}`);
    expect(after.body.topupValue.amount).toBe(500 * 1024 * 1024);
    const other = await call('GET', `${BK}/${supi(5)}`);
    expect(other.body.topupValue.amount).toBe(0);
  });

  test('S6. a document written before buckets existed still works, and gains an id', async () => {
    /* No bucketId: the shape the CHF and the WebUI wrote before buckets. */
    await repos.bucket.create({ supi: supi(6), quota: {
      totalQuotaBytes: 10 * GB, validityPeriod: 'monthly',
      validitySeconds: MONTH, autoRenew: true } });

    const got = await call('GET', `${BK}/${supi(6)}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(supi(6));
    expect(got.body.scope).toEqual({});

    /* Touching it writes the id, so later reads and writes use one field. */
    expect(repos.bucket.docs.find(d => d.supi === supi(6)).bucketId)
        .toBe(supi(6));

    const top = await call('POST', T, { bucket: { id: supi(6) },
      amount: { amount: 1, units: 'GB' } });
    expect(top.status).toBe(201);
    const after = await call('GET', `${BK}/${supi(6)}`);
    expect(after.body.topupValue.amount).toBe(GB);
  });
});

describe('TMF654 Bucket', () => {
  test('15. provision: 201, not started, remaining = allowance in octets', async () => {
    const res = await call('POST', BK, {
      logicalResource: [{ id: supi(1) }], allowance: { amount: 10, units: 'GB' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: supi(1), '@type': 'ChfDataBucket', '@baseType': 'Bucket',
      status: 'notStarted', autoRenew: true, finalUnitAction: 'TERMINATE',
      remainingValue: { amount: 10 * GB, units: 'octet' },
    });
    expect(res.body).not.toHaveProperty('validFor');
    /* Stored in the exact shape the CHF reads. */
    expect(repos.bucket.docs[0].quota).toMatchObject({
      totalQuotaBytes: 10 * GB, validitySeconds: MONTH });
  });

  test('16. duplicate SUPI is 409; malformed SUPI is 400', async () => {
    const body = { logicalResource: [{ id: supi(1) }],
                   allowance: { amount: 1, units: 'GB' } };
    expect((await call('POST', BK, body)).status).toBe(201);
    expect((await call('POST', BK, body)).status).toBe(409);
    expect((await call('POST', BK, { logicalResource: [{ id: 'imsi-12' }],
      allowance: { amount: 1, units: 'GB' } })).status).toBe(400);
  });

  test('17. active: remaining = allowance + top-ups - consumed', async () => {
    await seedBucket(1, {}, { periodStart: ISO(NOW - DAY_MS),
      consumedBytes: 3 * GB, topupBytes: 1 * GB });
    const { body } = await call('GET', `${BK}/${supi(1)}`);
    expect(body.status).toBe('active');
    expect(body.remainingValue.amount).toBe(8 * GB);
    expect(body.consumedValue.amount).toBe(3 * GB);
    expect(body.topupValue.amount).toBe(1 * GB);
    expect(body.validFor.endDateTime).toBe(ISO(NOW - DAY_MS + MONTH * 1000));
  });

  test('18. expired + autoRenew: remaining is the fresh allowance', async () => {
    await seedBucket(1, { autoRenew: true }, {
      periodStart: ISO(NOW - (MONTH + 1) * 1000), consumedBytes: 10 * GB });
    const { body } = await call('GET', `${BK}/${supi(1)}`);
    expect(body.status).toBe('expired');
    expect(body.remainingValue.amount).toBe(10 * GB);
  });

  test('19. expired, autoRenew ABSENT: remaining 0, as the CHF treats it', async () => {
    const doc = await seedBucket(1, {}, {
      periodStart: ISO(NOW - (MONTH + 1) * 1000), consumedBytes: 1 * GB });
    delete doc.quota.autoRenew;
    const { body } = await call('GET', `${BK}/${supi(1)}`);
    expect(body.remainingValue.amount).toBe(0);
    expect(body.autoRenew).toBe(false);
  });

  test('20. PATCH never touches the CHF usage counter', async () => {
    const usage = { periodStart: ISO(NOW - DAY_MS),
                    consumedBytes: 4 * GB, topupBytes: 2 * GB };
    await seedBucket(1, {}, usage);
    const res = await call('PATCH', `${BK}/${supi(1)}`, {
      allowance: { amount: 20, units: 'GB' }, finalUnitAction: 'REDIRECT' });
    expect(res.status).toBe(200);
    expect(repos.bucket.docs[0].usage).toEqual(usage);
    expect(repos.bucket.docs[0].quota.totalQuotaBytes).toBe(20 * GB);
    expect(res.body.remainingValue.amount).toBe(18 * GB);
  });

  test('21. PATCH writes only what it names (no default autoRenew)', async () => {
    const doc = await seedBucket(1, {});
    delete doc.quota.autoRenew;
    await call('PATCH', `${BK}/${supi(1)}`, { finalUnitAction: 'REDIRECT' });
    expect(repos.bucket.docs[0].quota).not.toHaveProperty('autoRenew');
  });

  test('22. PATCH rejects read-only and unknown attributes', async () => {
    await seedBucket(1, {});
    expect((await call('PATCH', `${BK}/${supi(1)}`,
        { remainingValue: { amount: 1 } })).status).toBe(400);
    expect((await call('PATCH', `${BK}/${supi(1)}`,
        { consumedValue: { amount: 0 } })).status).toBe(400);
    expect((await call('PATCH', `${BK}/${supi(1)}`,
        { allowence: { amount: 1 } })).status).toBe(400);
  });

  test('23. partyAccount: link, then null unlinks', async () => {
    const a = (await call('POST', A, { name: 'Acme' })).body;
    await seedBucket(1, {});
    const linked = await call('PATCH', `${BK}/${supi(1)}`, { partyAccount: { id: a.id } });
    expect(linked.body.partyAccount.id).toBe(a.id);
    const byAcct = await call('GET', `${BK}?partyAccount.id=${a.id}`);
    expect(byAcct.body.map(b => b.id)).toEqual([supi(1)]);
    const unlinked = await call('PATCH', `${BK}/${supi(1)}`, { partyAccount: null });
    expect(unlinked.body).not.toHaveProperty('partyAccount');
  });

  test('24. custom validity requires validitySeconds; presets override it', async () => {
    expect((await call('POST', BK, { logicalResource: [{ id: supi(1) }],
      allowance: { amount: 1, units: 'GB' }, validityPeriod: 'custom' })).status)
      .toBe(400);
    const ok = await call('POST', BK, { logicalResource: [{ id: supi(2) }],
      allowance: { amount: 1, units: 'GB' }, validityPeriod: 'weekly',
      validitySeconds: 5 });
    expect(ok.body.validitySeconds).toBe(604800);
  });
});

/* ================================================================== */
describe('TMF654 TopupBalance', () => {
  const topup = (n, amount, extra, headers) => call('POST', T,
      Object.assign({ bucket: { id: supi(n) }, amount }, extra), headers);

  test('25. active cycle: adds to topupBytes only, consumed untouched', async () => {
    await seedBucket(1, {}, { periodStart: ISO(NOW - DAY_MS),
      consumedBytes: 9 * GB, topupBytes: 0 });
    const res = await topup(1, { amount: 2, units: 'GB' }, { reason: 'bolt-on' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'completed', reactivated: false,
      amount: { amount: 2 * GB, units: 'octet' }, reason: 'bolt-on' });
    expect(repos.bucket.docs[0].usage).toMatchObject({
      consumedBytes: 9 * GB, topupBytes: 2 * GB });
    const { body } = await call('GET', `${BK}/${supi(1)}`);
    expect(body.remainingValue.amount).toBe(3 * GB);
  });

  test('26. not started: opens the cycle with the top-up in it', async () => {
    await seedBucket(1, {});
    const res = await topup(1, { amount: 1, units: 'GB' });
    expect(res.body.reactivated).toBe(true);
    expect(repos.bucket.docs[0].usage).toMatchObject({
      consumedBytes: 0, topupBytes: 1 * GB, periodStart: ISO(NOW) });
  });

  test('27. expired non-renewing plan: a top-up reactivates it', async () => {
    await seedBucket(1, { autoRenew: false }, {
      periodStart: ISO(NOW - (MONTH + 1) * 1000), consumedBytes: 10 * GB });
    expect((await call('GET', `${BK}/${supi(1)}`)).body.remainingValue.amount)
      .toBe(0);
    const res = await topup(1, { amount: 500, units: 'MB' });
    expect(res.body.reactivated).toBe(true);
    const { body } = await call('GET', `${BK}/${supi(1)}`);
    expect(body.status).toBe('active');
    expect(body.remainingValue.amount).toBe(10 * GB + 500 * 1048576);
  });

  test('28. validation: unknown bucket 404, zero or negative amount 400', async () => {
    expect((await topup(1, { amount: 1, units: 'GB' })).status).toBe(404);
    await seedBucket(1, {});
    expect((await topup(1, { amount: 0, units: 'GB' })).status).toBe(400);
    expect((await topup(1, { amount: -5, units: 'GB' })).status).toBe(400);
    expect((await topup(1, { amount: 1, units: 'parsec' })).status).toBe(400);
  });

  test('29. Idempotency-Key: a retried POST credits exactly once', async () => {
    await seedBucket(1, {}, { periodStart: ISO(NOW - DAY_MS), consumedBytes: 0 });
    const h = { 'Idempotency-Key': 'order-7781' };
    const first = await topup(1, { amount: 1, units: 'GB' }, {}, h);
    const again = await topup(1, { amount: 1, units: 'GB' }, {}, h);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(repos.bucket.docs[0].usage.topupBytes).toBe(1 * GB);
    expect(repos.topupBalance.docs).toHaveLength(1);
  });

  test('30. every attempt is audited and filterable by bucket', async () => {
    await seedBucket(1, {}, { periodStart: ISO(NOW - DAY_MS) });
    await seedBucket(2, {}, { periodStart: ISO(NOW - DAY_MS) });
    await topup(1, { amount: 1, units: 'GB' });
    await topup(2, { amount: 1, units: 'GB' });
    await topup(1, { amount: 2, units: 'GB' });
    const list = await call('GET', `${T}?bucket.id=${supi(1)}`);
    expect(list.body).toHaveLength(2);
    expect(list.body.every(t => t.status === 'completed')).toBe(true);
  });

  test('31. top-up records are immutable (405)', async () => {
    await seedBucket(1, {}, { periodStart: ISO(NOW - DAY_MS) });
    const { body } = await topup(1, { amount: 1, units: 'GB' });
    const patched = await call('PATCH', `${T}/${body.id}`, { status: 'failed' });
    expect(patched.status).toBe(405);
    expect(patched.headers.get('allow')).toBe('GET');
    expect((await call('DELETE', `${T}/${body.id}`)).status).toBe(405);
  });
});

/* ================================================================== */
/*
 * ChargingNotify queue (chf.notifications).
 *
 * A balance change that only lands in MongoDB reaches a live session at
 * its next usage report - up to five minutes with the shipped grant caps,
 * and the full five when the session is idle.  The TMF layer queues a row
 * so the CHF can reach the session now; these check that it queues the
 * right thing, and that a queue failure never fails the request that
 * actually moved the balance.
 */
describe('ChargingNotify queue', () => {
  const queued = () => repos.notification.docs;
  /* 15 digits, like supi() above, from a range the other tests do not use. */
  const who = n => `imsi-9996000000000${n}`;

  const provision = (n, gb = 1) => call('POST', BK, {
    logicalResource: [{ id: who(n) }], allowance: { amount: gb, units: 'GB' } });

  it('a top-up asks for re-authorisation', async () => {
    await provision(20);

    const top = await call('POST', T, { bucket: { id: who(20) },
      amount: { amount: 500, units: 'MB' } });
    expect(top.status).toBe(201);

    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({
      supi: who(20), type: 'REAUTHORIZATION', reason: 'topup' });
    /* The catch-all bucket's id is the SUPI, so there is nothing to
     * narrow by: every session of this subscriber draws from it. */
    expect(queued()[0].bucketId).toBeUndefined();
  });

  it('a top-up on a scoped bucket names that bucket', async () => {
    await provision(21, 10);
    const scoped = await call('POST', BK, {
      logicalResource: [{ id: who(21) }], allowance: { amount: 1, units: 'GB' },
      scope: { dnn: 'ims' }, priority: 10 });

    await call('POST', T, { bucket: { id: scoped.body.id },
      amount: { amount: 100, units: 'MB' } });

    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({
      supi: who(21), bucketId: scoped.body.id, type: 'REAUTHORIZATION' });
  });

  it('a changed plan asks for re-authorisation', async () => {
    await provision(22);

    const res = await call('PATCH', `${BK}/${who(22)}`,
        { allowance: { amount: 5, units: 'GB' } });
    expect(res.status).toBe(200);

    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({
      supi: who(22), type: 'REAUTHORIZATION', reason: 'plan-change' });
  });

  it('deprovisioning aborts charging', async () => {
    await provision(23);

    const res = await call('DELETE', `${BK}/${who(23)}`);
    expect(res.status).toBe(204);

    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({
      supi: who(23), type: 'ABORT_CHARGING', reason: 'deprovisioned' });
  });

  it('nothing is queued for a request that changed nothing', async () => {
    const res = await call('DELETE', `${BK}/${who(24)}`);
    expect(res.status).toBe(404);
    expect(queued()).toHaveLength(0);
  });

  it('a queue failure does not fail the top-up', async () => {
    await provision(25);
    repos.notification.create = async () => { throw new Error('mongo down'); };

    const top = await call('POST', T, { bucket: { id: who(25) },
      amount: { amount: 250, units: 'MB' } });

    /* The balance moved, which is what counts; only the immediacy is lost,
     * and the session picks the top-up up at its next report. */
    expect(top.status).toBe(201);
    const after = await call('GET', `${BK}/${who(25)}`);
    expect(after.body.topupValue.amount).toBe(250 * 1024 * 1024);
  });

  it('works when the queue is not wired at all', async () => {
    delete repos.notification;
    await provision(26);

    const top = await call('POST', T, { bucket: { id: who(26) },
      amount: { amount: 1, units: 'GB' } });
    expect(top.status).toBe(201);
  });
});

describe('applyTopup concurrency with the CHF', () => {
  /* Simulate the CHF acting between applyTopup's read and its write. */
  function raceOnFirstUpdate(repo, chfWrites) {
    const realUpdate = repo.update.bind(repo);
    let raced = false;
    repo.update = async (filter, update) => {
      if (!raced) { raced = true; Object.assign(repo.docs[0].usage, chfWrites); }
      return realUpdate(filter, update);
    };
  }

  test('32. read EXPIRED, CHF renews and counts usage: that usage survives', async () => {
    /* The dangerous direction.  applyTopup reads an expired cycle and plans
     * to open a new one with consumedBytes 0.  Meanwhile the CHF renews the
     * cycle AND records 3 GB on it.  An unconditional write would wipe that
     * 3 GB - free data.  The periodStart condition must make it retry and
     * add the top-up to the renewed cycle instead. */
    const repo = memoryRepo('bucketId');
    await repo.create({ supi: supi(1), bucketId: supi(1),
      quota: { totalQuotaBytes: 10 * GB, validitySeconds: MONTH, autoRenew: true },
      usage: { periodStart: ISO(NOW - (MONTH + 1) * 1000),
               consumedBytes: 10 * GB, topupBytes: 0 } });

    raceOnFirstUpdate(repo, { periodStart: ISO(NOW - 1000),
                              consumedBytes: 3 * GB, topupBytes: 0 });

    const r = await B.applyTopup(repo, supi(1), 1 * GB, NOW);
    expect(r).toEqual({ outcome: 'applied', reactivated: false });
    expect(repo.docs[0].usage).toMatchObject({
      periodStart: ISO(NOW - 1000), consumedBytes: 3 * GB, topupBytes: 1 * GB });
  });

  test('32b. read ACTIVE, CHF renews: the credit lands in the new cycle', async () => {
    const repo = memoryRepo('bucketId');
    await repo.create({ supi: supi(1), bucketId: supi(1),
      quota: { totalQuotaBytes: 10 * GB, validitySeconds: MONTH, autoRenew: true },
      usage: { periodStart: ISO(NOW - DAY_MS), consumedBytes: 5 * GB, topupBytes: 0 } });

    raceOnFirstUpdate(repo, { periodStart: ISO(NOW), consumedBytes: 0, topupBytes: 0 });

    const r = await B.applyTopup(repo, supi(1), 1 * GB, NOW + 1000);
    expect(r).toEqual({ outcome: 'applied', reactivated: false });
    expect(repo.docs[0].usage).toMatchObject({
      periodStart: ISO(NOW), consumedBytes: 0, topupBytes: 1 * GB });
  });

  test('33. a cycle that never settles gives up with conflict', async () => {
    const repo = memoryRepo('supi');
    await repo.create({ supi: supi(1), quota: { validitySeconds: MONTH },
      usage: { periodStart: ISO(NOW - DAY_MS) } });
    repo.update = async () => 0;
    expect(await B.applyTopup(repo, supi(1), GB, NOW))
      .toEqual({ outcome: 'conflict' });
  });
});
