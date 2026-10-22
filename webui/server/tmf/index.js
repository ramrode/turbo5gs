/*
 * TM Forum Open APIs for CHF subscriber management.
 *
 * Mounted at {serverRoot}/tmf-api (serverRoot = /api), behind the WebUI's
 * JWT bearer authentication:
 *
 *   /tmf-api/partyManagement/v4/individual           TMF632  users
 *   /tmf-api/accountManagement/v4/billingAccount     TMF666  accounts
 *   /tmf-api/prepayBalanceManagement/v4/bucket       TMF654  data balances
 *   /tmf-api/prepayBalanceManagement/v4/topupBalance TMF654  top-ups
 *
 * Reads need any authenticated account; writes need the admin role.
 *
 * Copyright (C) 2026 by Rami Mohamed <ramrode@gmail.com>
 */

'use strict';

const express = require('express');
const C = require('./common');
const { createPartyRouter } = require('./party');
const { createAccountRouter } = require('./account');
const { createBalanceRouter } = require('./balance');

function createTmfRouter(repos, clock) {
  const router = express.Router();

  router.use(C.jsonBody);
  router.use(C.requireAdminForWrites);

  router.use('/partyManagement/v4', createPartyRouter(repos));
  router.use('/accountManagement/v4', createAccountRouter(repos));
  router.use('/prepayBalanceManagement/v4', createBalanceRouter(repos, clock));

  router.use((req, res) =>
    C.sendError(res, 404, 'Not Found', 'No such TMF resource'));

  /* Malformed JSON and oversized bodies from the TMF body parser. */
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 400 && status < 500)
      return C.sendError(res, status, 'Bad Request', err.message);
    // eslint-disable-next-line no-console
    console.error('[tmf]', err && err.stack ? err.stack : err);
    return C.sendError(res, 500, 'Internal Server Error');
  });

  return router;
}

/* Production wiring: the Mongoose-backed repositories. */
function mongooseRepos() {
  const { mongooseRepo } = require('./repo');
  return {
    individual: mongooseRepo(require('../models/tmf-individual'), 'id'),
    billingAccount: mongooseRepo(require('../models/tmf-billing-account'), 'id'),
    /* Keyed by bucketId, not supi: a subscriber holds several buckets and
     * only the catch-all's id is its SUPI.  getBucket() in balance.js
     * falls back to a supi lookup for a document written before buckets
     * existed, and gives it a bucketId as it goes. */
    bucket: mongooseRepo(require('../models/chf-subscriber'), 'bucketId'),
    topupBalance: mongooseRepo(require('../models/tmf-topup-balance'), 'id'),
    notification: mongooseRepo(require('../models/chf-notification'), 'id'),
  };
}

module.exports = { createTmfRouter, mongooseRepos };
