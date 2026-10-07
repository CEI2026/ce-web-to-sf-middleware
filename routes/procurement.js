'use strict';
// ce-web-to-sf-middleware - routes/procurement.js
// STUB. Procurement assessments are planned but not built. The routes exist so the
// Energy Assessment Resource Center page can show "Procurement (coming soon)" and so
// the endpoint name is reserved. Nothing is saved anywhere.
//
// Intended later (not implemented): POST /procurement-request will take the same
// institution and building lookup result as the other assessments, plus the bills
// already filed on the building in Salesforce, and queue a procurement assessment.
const express = require('express');
const cors = require('cors');

const MESSAGE = 'Procurement assessments are not available yet. Catholic Energies will announce them when they are ready.';

function createProcurementRouter() {
  const router = express.Router();
  router.use(['/procurement', '/procurement-request'], cors());
  router.get('/procurement', (req, res) => res.json({ available: false, status: 'coming_soon', message: MESSAGE }));
  router.post('/procurement-request', express.json({ limit: '32kb' }), (req, res) =>
    res.status(501).json({ ok: false, status: 'coming_soon', message: MESSAGE }));
  return router;
}

module.exports = { createProcurementRouter, MESSAGE };
