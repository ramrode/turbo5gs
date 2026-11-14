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
    simSwap: memoryRepo('id', [], ['idempotencyKey', 'locks']),
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

/* ================================================================== */
/*
 * A SIM swap moves balances, so the invariants are the money ones again:
 * everything the old SIM had arrives on the new one, nothing is copied or
 * left behind, and a swap that cannot finish moves nothing.
 */
describe('SIM swap', () => {
  const W = '/prepayBalanceManagement/v4/simSwap';
  /* 15 digits, from a range the other tests do not use. */
  const sim = n => `imsi-9995000000000${String(n).padStart(2, '0')}`;
  const swap = (a, b, extra = {}, headers = {}) => call('POST', W, Object.assign({
    logicalResource: { id: sim(a) },
    receiverLogicalResource: { id: sim(b) } }, extra), headers);
  const provision = (n, extra = {}) => call('POST', BK, Object.assign({
    logicalResource: [{ id: sim(n) }],
    allowance: { amount: 10, units: 'GB' } }, extra));
  const scoped = (n, dnn = 'enterprise') => call('POST', BK, {
    logicalResource: [{ id: sim(n) }], allowance: { amount: 2, units: 'GB' },
    scope: { sNSSAI: { sst: 1, sd: '000001' }, dnn }, priority: 50 });
  const owned = s => repos.bucket.docs.filter(d => d.supi === s)
    .map(d => d.bucketId).sort();
  const stored = id => repos.bucket.docs.find(d => d.bucketId === id);
  const copy = v => JSON.parse(JSON.stringify(v));
  const records = () => repos.simSwap.docs;

  test('W1. every bucket moves to the new SIM, and nothing in it changes', async () => {
    const acct = (await call('POST', A, { name: 'Household' })).body;
    await provision(1, { partyAccount: { id: acct.id } });
    const extra = (await scoped(1)).body;
    stored(sim(1)).usage = { periodStart: ISO(NOW - DAY_MS),
      consumedBytes: 3 * GB, topupBytes: GB };
    const before = [copy(stored(sim(1))), copy(stored(extra.id))];

    const res = await swap(1, 2, { reason: 'lost SIM' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ '@type': 'SimSwap', status: 'completed',
      reason: 'lost SIM',
      logicalResource: { id: sim(1) },
      receiverLogicalResource: { id: sim(2) } });
    expect(res.headers.get('location')).toBe(res.body.href);
    expect(res.body.href.endsWith(`${W}/${res.body.id}`)).toBe(true);

    /* A scoped bucket keeps its suffix, so its new id can be worked out. */
    const suffix = extra.id.slice(sim(1).length);
    expect(res.body.bucket.map(b => [b.formerId, b.id]).sort()).toEqual([
      [sim(1), sim(2)], [extra.id, sim(2) + suffix]].sort());
    expect(res.body.bucket.every(b => b.href.endsWith(`${BK}/${b.id}`)))
      .toBe(true);

    expect(owned(sim(1))).toEqual([]);
    expect(owned(sim(2))).toEqual([sim(2), sim(2) + suffix].sort());

    /* Moved, not rebuilt: only the two identifying fields differ. */
    const after = [copy(stored(sim(2))), copy(stored(sim(2) + suffix))];
    after.forEach((doc, i) => {
      expect(doc).toEqual(Object.assign({}, before[i],
        { supi: doc.supi, bucketId: doc.bucketId }));
      expect(doc.supi).toBe(sim(2));
    });
    expect(after[0].billingAccountId).toBe(acct.id);
    expect(after[0].usage.consumedBytes).toBe(3 * GB);
    expect(after[1].scope).toEqual({ snssai: { sst: 1, sd: '000001' },
      dnn: 'enterprise' });
  });

  test('W2. the new SIM has exactly the balance the old one had', async () => {
    await provision(3);
    stored(sim(3)).usage = { periodStart: ISO(NOW - DAY_MS),
      consumedBytes: 3 * GB, topupBytes: GB };
    const before = (await call('GET', `${BK}/${sim(3)}`)).body;
    expect(before.remainingValue.amount).toBe(8 * GB);

    expect((await swap(3, 4)).status).toBe(201);

    const after = (await call('GET', `${BK}/${sim(4)}`)).body;
    ['remainingValue', 'consumedValue', 'topupValue', 'allowance', 'status',
      'validFor'].forEach(k => expect(after[k]).toEqual(before[k]));
    expect(after.logicalResource[0].id).toBe(sim(4));
    expect((await call('GET', `${BK}/${sim(3)}`)).status).toBe(404);
  });

  test('W3. validation: both SIMs must be SUPIs, and different', async () => {
    const bad = [
      { logicalResource: { id: 'imsi-123' },
        receiverLogicalResource: { id: sim(6) } },
      { logicalResource: { id: sim(5) } },
      { logicalResource: [{ id: sim(5) }],
        receiverLogicalResource: { id: sim(6) } },
      { logicalResource: { id: sim(5) },
        receiverLogicalResource: { id: sim(5) } },
      { logicalResource: { id: sim(5) },
        receiverLogicalResource: { id: sim(6) }, status: 'completed' },
      { logicalResource: { id: sim(5) },
        receiverLogicalResource: { id: sim(6) }, reason: 7 },
    ];
    for (const body of bad)
      expect((await call('POST', W, body)).status).toBe(400);
    expect((await swap(5, 6, {}, { 'Idempotency-Key': 'has a space' })).status)
      .toBe(400);
    /* A request that was never well-formed is not an attempt. */
    expect(records()).toHaveLength(0);
  });

  test('W4. nothing to move is 404; a new SIM that has a bucket is 409', async () => {
    const none = await swap(7, 8);
    expect(none.status).toBe(404);

    await provision(9);
    await provision(10);
    const taken = await swap(9, 10);
    expect(taken.status).toBe(409);
    expect(owned(sim(9))).toEqual([sim(9)]);
    expect(owned(sim(10))).toEqual([sim(10)]);

    /* Both were attempts, so both are on record, and neither holds a lock. */
    expect(records().map(r => r.status)).toEqual(['failed', 'failed']);
    expect(records().every(r => r.statusReason && r.locks === undefined))
      .toBe(true);
  });

  test('W5. Idempotency-Key: a retried POST moves once and gets the original', async () => {
    await provision(11);
    const h = { 'Idempotency-Key': 'swap-0001' };

    const first = await swap(11, 12, {}, h);
    const again = await swap(11, 12, {}, h);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.status).toBe('completed');
    expect(records()).toHaveLength(1);
    expect(owned(sim(12))).toEqual([sim(12)]);

    /* Without the key a repeat is not mistaken for a new swap either:
     * the old SIM has nothing left. */
    expect((await swap(11, 12)).status).toBe(404);

    /* The key stands for the request, whatever came of it.  A failed swap
     * replayed with its key returns the failed record, and is not tried
     * again even once the cause is gone: a new attempt needs a new key. */
    const k = { 'Idempotency-Key': 'swap-0002' };
    expect((await swap(90, 91, {}, k)).status).toBe(404);
    await provision(90);
    const replay = await swap(90, 91, {}, k);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('failed');
    expect(owned(sim(90))).toEqual([sim(90)]);
  });

  test('W6. a move that fails part-way puts back what was moved', async () => {
    await provision(13);
    const extra = (await scoped(13)).body;
    const real = repos.bucket.update;
    let moves = 0;
    /* The second bucket vanishes between the plan and its move. */
    repos.bucket.update = async (filter, update) =>
      (update.$set && update.$set.supi === sim(14) && ++moves === 2)
        ? 0 : real(filter, update);

    const res = await swap(13, 14);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/nothing was moved/);
    expect(owned(sim(13))).toEqual([sim(13), extra.id].sort());
    expect(owned(sim(14))).toEqual([]);
    expect(records()[0]).toMatchObject({ status: 'failed' });
    expect(records()[0].locks).toBeUndefined();
    /* Nobody's session is told to stop for a swap that did not happen. */
    expect(repos.notification.docs).toHaveLength(0);
  });

  test('W7. a bucket given to the new SIM mid-swap is a conflict, and is undone', async () => {
    await provision(15);
    const extra = (await scoped(15)).body;
    const real = repos.bucket.update;
    let moves = 0;
    repos.bucket.update = async (filter, update) => {
      if (update.$set && update.$set.supi === sim(16) && ++moves === 2) {
        const err = new Error('E11000 duplicate key');
        err.code = 11000;
        throw err;
      }
      return real(filter, update);
    };

    const res = await swap(15, 16);
    expect(res.status).toBe(409);
    expect(owned(sim(15))).toEqual([sim(15), extra.id].sort());
    expect(owned(sim(16))).toEqual([]);
    expect(records()[0].statusReason).toMatch(/was given a bucket/);
  });

  test('W8. two swaps that share a SIM cannot run at once', async () => {
    await provision(17);
    await repos.simSwap.create({ id: 'running', status: 'inProgress',
      requestedDate: ISO(NOW - 1000),
      logicalResource: { id: sim(17) },
      receiverLogicalResource: { id: sim(90) },
      bucket: [], locks: [sim(17), sim(90)] });

    /* As the old SIM of another swap, and as its new SIM. */
    expect((await swap(17, 18)).status).toBe(409);
    await provision(19);
    expect((await swap(19, 90)).status).toBe(409);
    expect(owned(sim(17))).toEqual([sim(17)]);
    expect(owned(sim(19))).toEqual([sim(19)]);
    expect(records()).toHaveLength(1);
  });

  test('W9. an interrupted swap is undone before the next one starts', async () => {
    await provision(20);
    const extra = (await scoped(20)).body;
    const suffix = extra.id.slice(sim(20).length);
    /* The server stopped after moving the first of two buckets to 21. */
    Object.assign(stored(sim(20)), { supi: sim(21), bucketId: sim(21) });
    await repos.simSwap.create({ id: 'stopped', status: 'inProgress',
      requestedDate: ISO(NOW - 5 * 60 * 1000),
      logicalResource: { id: sim(20) },
      receiverLogicalResource: { id: sim(21) },
      bucket: [{ id: sim(21), formerId: sim(20) },
               { id: sim(21) + suffix, formerId: extra.id }],
      locks: [sim(20), sim(21)] });

    const res = await swap(20, 22);
    expect(res.status).toBe(201);
    expect(owned(sim(20))).toEqual([]);
    expect(owned(sim(21))).toEqual([]);
    expect(owned(sim(22))).toEqual([sim(22), sim(22) + suffix].sort());

    const stopped = records().find(r => r.id === 'stopped');
    expect(stopped.status).toBe('failed');
    expect(stopped.statusReason).toMatch(/Interrupted/);
    expect(stopped.locks).toBeUndefined();
  });

  test('W10. the old SIM is told to stop, and the new one to re-authorise', async () => {
    await provision(23);
    await scoped(23);
    expect((await swap(23, 24)).status).toBe(201);

    const queued = repos.notification.docs;
    expect(queued.map(q => [q.supi, q.type, q.reason])).toEqual([
      [sim(23), 'ABORT_CHARGING', 'sim-swap'],
      [sim(24), 'REAUTHORIZATION', 'sim-swap']]);
    /* No bucket is named: every session of that SIM is meant. */
    expect(queued.every(q => q.bucketId === undefined)).toBe(true);
  });

  test('W11. a queue failure does not fail the swap', async () => {
    await provision(25);
    repos.notification.create = async () => { throw new Error('mongo down'); };
    expect((await swap(25, 26)).status).toBe(201);
    expect(owned(sim(26))).toEqual([sim(26)]);
  });

  test('W12. swap records are listed, filterable and immutable', async () => {
    await provision(27);
    await provision(29);
    const one = (await swap(27, 28)).body;
    await swap(29, 30);

    const mine = await call('GET', `${W}?logicalResource.id=${sim(27)}`);
    expect(mine.status).toBe(200);
    expect(mine.body.map(r => r.id)).toEqual([one.id]);
    expect((await call('GET', `${W}?receiverLogicalResource.id=${sim(30)}`))
      .body).toHaveLength(1);
    expect((await call('GET', `${W}?status=completed`)).body).toHaveLength(2);
    expect((await call('GET', `${W}?locks=${sim(27)}`)).status).toBe(400);

    const got = await call('GET', `${W}/${one.id}`);
    expect(got.body).toEqual(one);
    expect(got.body.locks).toBeUndefined();
    expect(got.body.idempotencyKey).toBeUndefined();
    expect((await call('GET', `${W}/nope`)).status).toBe(404);

    for (const method of ['PATCH', 'DELETE', 'PUT']) {
      const res = await call(method, `${W}/${one.id}`,
          method === 'DELETE' ? undefined : { status: 'failed' });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
    }
  });

  test('W13. a document written before buckets existed moves too', async () => {
    repos.bucket.docs.push({ supi: sim(31),
      quota: { totalQuotaBytes: 5 * GB, validitySeconds: MONTH } });

    const res = await swap(31, 32);
    expect(res.status).toBe(201);
    expect(res.body.bucket.map(b => [b.formerId, b.id]))
      .toEqual([[sim(31), sim(32)]]);
    const doc = repos.bucket.docs.find(d => d.supi === sim(32));
    expect(doc.bucketId).toBe(sim(32));
    expect(doc.quota.totalQuotaBytes).toBe(5 * GB);
  });

  test('W14. an id written by hand gets a new one that still works', async () => {
    await repos.bucket.create({ supi: sim(33), bucketId: 'plan-A',
      scope: { dnn: 'internet' }, priority: 5,
      quota: { totalQuotaBytes: GB, validitySeconds: MONTH,
               validityPeriod: 'monthly', autoRenew: true } });

    const res = await swap(33, 34);
    expect(res.status).toBe(201);
    const id = res.body.bucket[0].id;
    expect(res.body.bucket[0].formerId).toBe('plan-A');
    expect(id).toMatch(new RegExp(`^${sim(34)}-[0-9a-f]{12}$`));

    const top = await call('POST', T, { bucket: { id },
      amount: { amount: 100, units: 'MB' } });
    expect(top.status).toBe(201);
  });

  test('W15. after the swap a top-up reaches the new id, and the old id is gone', async () => {
    await provision(35);
    expect((await swap(35, 36)).status).toBe(201);

    const top = await call('POST', T, { bucket: { id: sim(36) },
      amount: { amount: 1, units: 'GB' } });
    expect(top.status).toBe(201);
    expect(stored(sim(36)).usage.topupBytes).toBe(GB);
    expect((await call('POST', T, { bucket: { id: sim(35) },
      amount: { amount: 1, units: 'GB' } })).status).toBe(404);
  });

  test('W16. a swap needs the admin role', async () => {
    await provision(37);
    role = 'user';
    expect((await swap(37, 38)).status).toBe(403);
    expect(owned(sim(37))).toEqual([sim(37)]);
    expect(records()).toHaveLength(0);
    /* Reading the audit trail does not. */
    expect((await call('GET', W)).status).toBe(200);
  });

  /* The server stopped after moving the first of two buckets from a to b. */
  async function interrupted(a, b, id, key) {
    await provision(a);
    const extra = (await scoped(a)).body;
    const suffix = extra.id.slice(sim(a).length);
    Object.assign(stored(sim(a)), { supi: sim(b), bucketId: sim(b) });
    const at = ISO(NOW - 5 * 60 * 1000);
    await repos.simSwap.create({ id, status: 'inProgress',
      requestedDate: at, lockedAt: at, idempotencyKey: key,
      logicalResource: { id: sim(a) },
      receiverLogicalResource: { id: sim(b) },
      bucket: [{ id: sim(b), formerId: sim(a) },
               { id: sim(b) + suffix, formerId: extra.id }],
      locks: [sim(a), sim(b)] });
    return extra.id;
  }

  test('W17. a retry with the key of an interrupted swap undoes it', async () => {
    const h = { 'Idempotency-Key': 'swap-0017' };
    const extra = await interrupted(40, 41, 'cut-short', 'swap-0017');
    const record = records().find(r => r.id === 'cut-short');

    /* Within the minute it cannot be told from a swap that is running. */
    record.lockedAt = ISO(NOW - 30 * 1000);
    const early = await swap(40, 41, {}, h);
    expect(early.status).toBe(200);
    expect(early.body.status).toBe('inProgress');
    expect(owned(sim(41))).toEqual([sim(41)]);

    record.lockedAt = ISO(NOW - 5 * 60 * 1000);
    const late = await swap(40, 41, {}, h);
    expect(late.status).toBe(200);
    expect(late.body.id).toBe('cut-short');
    expect(late.body.status).toBe('failed');
    expect(late.body.statusReason).toMatch(/put back/);
    expect(late.body.lockedAt).toBeUndefined();
    expect(owned(sim(40))).toEqual([sim(40), extra].sort());
    expect(owned(sim(41))).toEqual([]);
    expect(record.locks).toBeUndefined();
    /* It did not happen, so nobody's session is told anything. */
    expect(repos.notification.docs).toHaveLength(0);

    /* The same swap, asked for again under a new key, now goes through. */
    expect((await swap(40, 41, {}, { 'Idempotency-Key': 'swap-0017b' }))
      .status).toBe(201);
    expect(owned(sim(40))).toEqual([]);
  });

  test('W18. an interrupted swap is undone by one request only', async () => {
    const h = { 'Idempotency-Key': 'swap-0018' };
    const extra = await interrupted(42, 43, 'cut-short', 'swap-0018');
    const suffix = extra.slice(sim(42).length);
    /*
     * Two requests find the interrupted swap at the same moment: the keyed
     * retry, and the same swap asked for again without the key.  The second
     * gets its claim in first, undoes the old swap and completes its own.
     * The retry must then leave the buckets alone.  Its put-back would
     * match what the second has just moved to 43, and take it back from a
     * swap that was reported as done.
     */
    const real = repos.simSwap.update;
    let second = null;
    repos.simSwap.update = async (filter, update) => {
      if (!second && update.$set && update.$set.lockedAt) {
        second = swap(42, 43);
        second = await second;
      }
      return real(filter, update);
    };

    const retry = await swap(42, 43, {}, h);
    expect(second.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe('cut-short');
    expect(retry.body.status).toBe('failed');
    expect(owned(sim(42))).toEqual([]);
    expect(owned(sim(43))).toEqual([sim(43), sim(43) + suffix].sort());
  });

  test('W19. while an interrupted swap is being undone, its SIMs stay locked', async () => {
    const h = { 'Idempotency-Key': 'swap-0019' };
    const extra = await interrupted(44, 45, 'cut-short', 'swap-0019');
    /* A swap that arrives in the middle of the put-back. */
    const real = repos.bucket.update;
    let second = null;
    repos.bucket.update = async (filter, update) => {
      if (!second) {
        second = swap(44, 46);
        second = await second;
      }
      return real(filter, update);
    };

    const retry = await swap(44, 45, {}, h);
    expect(second.status).toBe(409);
    expect(retry.body.status).toBe('failed');
    expect(owned(sim(44))).toEqual([sim(44), extra].sort());
    expect(owned(sim(45))).toEqual([]);
    expect(owned(sim(46))).toEqual([]);
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
