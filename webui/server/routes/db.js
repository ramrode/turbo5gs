const express = require('express');
const router = express.Router();

const restify = require('express-restify-mongoose')
const metrics = require('../metrics');

const Subscriber = require('../models/subscriber');
restify.serve(router, Subscriber, {
  prefix: '',
  version: '',
  idProperty: 'imsi'
});

const Eir = require('../models/eir');
restify.serve(router, Eir, { prefix: '', version: '' });

const Profile = require('../models/profile');
restify.serve(router, Profile, {
  prefix: '',
  version: ''
});

const Account = require('../models/account');
restify.serve(router, Account, {
  prefix: '',
  version: '',
  idProperty: 'username'
});

/*
 * Phase 6: CHF subscriber quota profiles — full CRUD.
 * REST endpoints: GET/POST/PUT/DELETE /db/ChfSubscriber[/:supi]
 * (express-restify-mongoose v6 mounts model.modelName verbatim — no plural.)
 * TS 23.255 §5.2 — CHF subscriber management
 */
const { chfSubscriberProtectUsage } = require('../chf-guards');

const ChfSubscriber = require('../models/chf-subscriber');
restify.serve(router, ChfSubscriber, {
  prefix: '',
  version: '',
  /*
   * A subscriber can hold several buckets - one per slice, DNN, home PLMN
   * or roaming state - so a document is addressed by its bucket id.  The
   * catch-all bucket's id is the SUPI, which is what every document had
   * before buckets existed.
   */
  idProperty: 'bucketId',
  preMiddleware: [chfSubscriberProtectUsage],
  /* Count provisioning ops (create/update/delete) for Prometheus. */
  postProcess: metrics.subscriberPostProcess,
  /*
   * Scale hardening (large provisioned-subscriber base):
   *  - totalCountHeader emits X-Total-Count so the WebUI can paginate and
   *    show "N of TOTAL" without downloading the whole collection.
   *  - limit is a hard server-side ceiling on documents per response; even
   *    a client that omits ?limit can never flood the browser with the
   *    entire chf.subscribers collection. The UI pages in smaller chunks
   *    (?limit=&skip=) and filters by SUPI (?query=) well under this cap.
   */
  totalCountHeader: true,
  limit: 1000
});

/*
 * Phase 6: CHF active sessions — read-only monitoring view.
 * REST endpoints: GET /db/ChfSession[/:chargingDataRef]
 * Sessions are written exclusively by the CHF NF; WebUI only reads them.
 * TS 23.255 §6 — active session monitoring
 *
 * NOTE: express-restify-mongoose has no allowedMethods option — all HTTP
 * verbs are always mounted.  Enforce read-only access by rejecting any
 * mutating verb via the pre-hooks before Mongoose is even consulted.
 */
const chfSessionReadOnly = (req, res, next) => {
  if (req.method !== 'GET') {
    return res.status(405).json({
      message: 'CHF session records are managed exclusively by the CHF NF',
    });
  }
  return next();
};

const ChfSession = require('../models/chf-session');
restify.serve(router, ChfSession, {
  prefix: '',
  version: '',
  idProperty: 'chargingDataRef',
  preMiddleware: [chfSessionReadOnly],
  /*
   * Scale hardening (potentially very large live-session set):
   *  - totalCountHeader emits X-Total-Count so the monitor can show
   *    "showing N of TOTAL active sessions".
   *  - limit caps documents per response; the monitor requests the most
   *    recent page (?sort=-startTime&limit=&skip=) rather than every
   *    active session, so a busy network never streams the full
   *    chf.sessions collection to the browser on each 10s poll.
   */
  totalCountHeader: true,
  limit: 1000
});

module.exports = router;
