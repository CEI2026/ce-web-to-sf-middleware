'use strict';
// ce-web-to-sf-middleware - routes/saf.js
// POST /submit - Solar Assessment Form. Handler code ported VERBATIM from
// ce-solar-middleware v7.6 server.js.
module.exports = function registerSaf(app, { getSFToken, sfPost, sfPatch, generateSubmissionId,
    findOrCreateContact, findExistingBuilding, uploadFilesToSF, config }) {
  const { DEMO_MODE } = config;

// ── POST /submit ──────────────────────────────────────────────
//  For each building in the payload:
//    Existing building  →  PATCH  Buildings__c
//    Manually added     →  duplicate check → POST or PATCH Buildings__c
//  Contact info written to Contact object; Building_Contact__c linked.
app.post('/submit', async (req, res) => {
  const payload = req.body;

  // DEMO MODE — simulate ONLY demo-account submissions; real accounts still write normally.
  if (DEMO_MODE && String(payload.sf_account_id || '').startsWith('DEMOACCT')) {
    const demoSub = generateSubmissionId();
    const recs = (payload.buildings || []).map(bld => ({ building: bld.building_name, action: 'demo', buildingId: 'DEMOBLD' }));
    console.log(`\u26a0 DEMO MODE: simulated submission ${demoSub} for ${payload.sf_account_id} (no SF write)`);
    return res.json({ success: true, submissionId: demoSub, records: recs, demo: true });
  }

  try {
    const { access_token, instance_url } = await getSFToken();

    const submissionId = generateSubmissionId();
    const timestamp    = payload.timestamp || new Date().toISOString();
    const contact      = payload.contact   || {};
    const accountId    = payload.sf_account_id || '';

    console.log(`[${submissionId}] Submit received: account=${accountId}, buildings=${(payload.buildings||[]).length}`);

    // ── Step 1: Find or create the Contact once for the whole submission
    const contactId = await findOrCreateContact(instance_url, access_token, accountId, contact);
    console.log(`[${submissionId}] Contact ID: ${contactId || 'none'}`);

    const results = [];

    for (const bld of payload.buildings || []) {

      // Defensive logging — helps diagnose duplicate and routing issues
      console.log(`[${submissionId}] Building: "${bld.building_name}" | sf_building_id=${bld.sf_building_id} | manually_added=${bld.manually_added}`);

      const buildingFields = {
        Submission_ID__c:             submissionId,
        Submission_Timestamp__c:      timestamp,
        Building_Type__c:             bld.building_type || '',
        Full_Address__c:              bld.building_address || '',
        Roof_Life_Under_15yr__c:      bld.q1  || '',
        Roof_Replace_Plans__c:        bld.q2  || 'N/A',
        Roof_Areas_No_Replace__c:     bld.roof || '',
        Capital_Contribution__c:      parseFloat(bld.budget) || 0,
        Bill_Count__c:                parseInt(bld.bill_count) || 0,
        Bill_Filenames__c:            bld.bill_filenames || '',
        Ground_Mount_Interest__c:     bld.gm_answer || '',
        Location_for_Ground_Mount__c: bld.gm_desc   || '',
        Submission_Notes__c:          (payload.contact && payload.contact.notes) ? payload.contact.notes : '',
        // v6: Link to Contact instead of writing flat contact fields
        ...(contactId ? { Building_Contact__c: contactId } : {}),
      };

      let buildingId, action;

      if (bld.manually_added || bld.sf_building_id === 'NEW') {
        // ── Duplicate guard: check before creating ──
        const existingId = await findExistingBuilding(
          instance_url, access_token, accountId, bld.building_name
        );

        if (existingId) {
          // Building already exists — patch it instead of creating a duplicate
          await sfPatch(instance_url, access_token, 'Buildings__c', existingId, buildingFields);
          buildingId = existingId;
          action     = 'patched-existing';
          console.log(`[${submissionId}] Duplicate guard triggered for "${bld.building_name}" — patched ${existingId}`);
        } else {
          // Truly new building — create it
          const newRecord = await sfPost(instance_url, access_token, 'Buildings__c', {
            Name:                       bld.building_name,
            Account__c:                 accountId,
            Manually_Added_Building__c: true,
            QA_Status__c:               'PENDING',
            Data_Source__c:             'Manual_Form_Submission',
            ...buildingFields,
          });
          buildingId = newRecord.id;
          action     = 'created';
          console.log(`[${submissionId}] Created new building ${buildingId} for "${bld.building_name}"`);
        }

      } else {
        // Existing building selected from SF list — patch it
        await sfPatch(instance_url, access_token, 'Buildings__c', bld.sf_building_id, buildingFields);
        buildingId = bld.sf_building_id;
        action     = 'updated';
        console.log(`[${submissionId}] Updated building ${buildingId}`);
      }

      results.push({ building: bld.building_name, action, buildingId });

      // Upload electric bill files
      if (bld.bill_files && bld.bill_files.length > 0) {
        await uploadFilesToSF(instance_url, access_token, buildingId, bld.bill_files);
      }
    }

    console.log(`[${submissionId}] Complete:`, results.map(r => `${r.building}→${r.action}`).join(', '));
    res.json({ success: true, submissionId, records: results });

  } catch (err) {
    console.error('/submit error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
};
