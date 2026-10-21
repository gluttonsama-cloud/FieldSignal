import test from 'node:test';
import assert from 'node:assert/strict';
import { parseObservationInput, observationImportSummary } from '../src/observation-import.ts';
import { esc } from '../src/display.ts';
import { harness, deferred } from './helpers/ui-harness.mjs';

// Run the production change/input/submit handlers. These DOM stubs cover async
// ownership and disabled-fieldset FormData semantics, not browser/visual QA.
const original = '{"source_record_id":"original","features":{"ndvi":0.2}}';
const firstJson = '{"source_record_id":"first","features":{"ndvi":0.3}}';
const secondJson = '{"source_record_id":"second","features":{"ndvi":0.4}}';

function observationUi() {
  const ui = harness(), calls = [];
  ui.context.esc=esc;
  const modalQuery = ui.modal.querySelector.bind(ui.modal);
  ui.modal.querySelector = selector => ui.modal.form?.querySelector(selector) || modalQuery(selector);
  ui.context.FormData = class {
    constructor(form) {
      // Native FormData snapshots successful controls; descendants of a
      // disabled fieldset are excluded even when their own disabled is false.
      this.values = form.observationFields?.disabled ? {} : { ...form.values };
    }
    get(key) { return this.values[key] ?? null; }
  };
  ui.context.post = async (path, body) => { calls.push({ path, body }); return { id: 'observation-1' }; };
  return { ...ui, calls };
}

function openForm(ui, json = original) {
  ui.run('observationModal()');
  const form = ui.modal.form, query = form.querySelector.bind(form);
  form.values.json = json;
  form.observationFields = ui.modal.innerHTML.includes('id="observation-fields"') ? { disabled: false } : null;
  form.fileStatus = { textContent: '', set innerHTML(_) { assert.fail('file status must never render HTML'); } };
  form.textarea = {
    name: 'json',
    get value() { return form.values.json; },
    set value(value) { form.values.json = value; },
    closest: selector => selector === '#observation-form' ? form : null,
  };
  form.choices = { hidden: true, innerHTML: '' };
  form.preview = { textContent: '', set innerHTML(_) { assert.fail('preview must render literal text'); } };
  form.recordSelect = { id: 'observation-record', value: '', closest: () => form };
  form.fileInput = {
    id: 'observation-file', files: [],
    closest: selector => selector === '#observation-form' ? form : null,
  };
  form.querySelector = selector => selector === 'textarea[name="json"]' ? form.textarea
    : selector === '#observation-file-status' ? form.fileStatus
    : selector === '#observation-fields' ? form.observationFields
    : selector === '#observation-choices' ? form.choices
    : selector === '#observation-preview' ? form.preview : query(selector);
  return form;
}

const file = (name, text, size = 100) => ({ name, size, text: () => Promise.resolve(text) });
const choose = (ui, form, selected) => {
  form.fileInput.files = selected ? [selected] : [];
  return ui.modal.listeners.change({ target: form.fileInput });
};
const edit = (ui, form, value) => {
  form.textarea.value = value;
  ui.modal.listeners.input({ target: form.textarea });
};

for (const lateFailure of [false, true]) {
  test(`newer file success survives an older ${lateFailure ? 'failure' : 'success'}`, async () => {
    const ui = observationUi(), form = openForm(ui), first = deferred(), second = deferred();
    const firstDone = choose(ui, form, file('first.json', first.promise));
    const secondDone = choose(ui, form, file('second.json', second.promise));
    second.resolve(secondJson);
    await secondDone;
    const status = form.fileStatus.textContent;
    if (lateFailure) first.reject(new Error('Old read failed'));
    else first.resolve(firstJson);
    await firstDone;
    assert.equal(form.values.json, secondJson);
    assert.equal(form.fileStatus.textContent, status);
    assert.match(status, /second\.json/);
    assert.equal(form.submit.disabled, false);
    assert.equal(ui.modal.error.hidden, true);
    assert.equal(ui.toast.textContent, '');
    assert.equal(ui.calls.length, 0);
  });

  test(`older ${lateFailure ? 'failure' : 'success'} cannot unlock a newer pending file`, async () => {
    const ui = observationUi(), form = openForm(ui), first = deferred(), second = deferred();
    const firstDone = choose(ui, form, file('first.json', first.promise));
    const secondDone = choose(ui, form, file('second.json', second.promise));
    if (lateFailure) first.reject(new Error('Old read failed'));
    else first.resolve(firstJson);
    await firstDone;
    assert.equal(form.values.json, original);
    assert.equal(form.submit.disabled, true);
    assert.equal(ui.modal.error.hidden, true);
    await ui.submit(form);
    assert.equal(ui.calls.length, 0);
    second.resolve(secondJson);
    await secondDone;
    assert.equal(form.values.json, secondJson);
    assert.equal(form.submit.disabled, false);
    assert.equal(ui.modal.error.hidden, true);
  });

  test(`manual edits supersede a pending file's late ${lateFailure ? 'failure' : 'success'}`, async () => {
    const ui = observationUi(), form = openForm(ui), pending = deferred();
    const done = choose(ui, form, file('old.json', pending.promise));
    edit(ui, form, secondJson);
    const status = form.fileStatus.textContent;
    assert.equal(form.submit.disabled, false);
    if (lateFailure) pending.reject(new Error('Old read failed'));
    else pending.resolve(firstJson);
    await done;
    assert.equal(form.values.json, secondJson);
    assert.equal(form.fileStatus.textContent, status);
    assert.equal(ui.modal.error.hidden, true);
    assert.equal(ui.calls.length, 0);
  });
}

for (const [name, selected, expectedError] of [
  ['cleared', undefined, null],
  ['malformed', file('bad.json', '{not valid json'), /JSON/],
  ['array', file('array.json', '[{"source":"manual"}]'), /单条观测 JSON 对象/],
  ['null', file('null.json', 'null'), /单条观测 JSON 对象/],
  ['oversized', { name: 'large.json', size: 1024 * 1024 + 1, text() { assert.fail('oversize file must not be read'); } }, /1 MB/],
]) {
  test(`${name} selection supersedes pending success and preserves existing JSON`, async () => {
    const ui = observationUi(), form = openForm(ui), pending = deferred();
    const oldDone = choose(ui, form, file('old.json', pending.promise));
    await choose(ui, form, selected);
    const status = form.fileStatus.textContent, error = ui.modal.error.textContent;
    assert.equal(form.values.json, original);
    assert.equal(form.submit.disabled, false);
    if (expectedError) assert.match(error, expectedError);
    else assert.equal(ui.modal.error.hidden, true);
    pending.resolve(firstJson);
    await oldDone;
    assert.equal(form.values.json, original);
    assert.equal(form.fileStatus.textContent, status);
    assert.equal(ui.modal.error.textContent, error);
    assert.equal(form.submit.disabled, false);
    assert.equal(ui.calls.length, 0);
  });
}

for (const invalid of ['42', 'true', '"object-like text"']) {
  test(`primitive ${invalid} is rejected without replacing the textarea`, async () => {
    const ui = observationUi(), form = openForm(ui);
    await choose(ui, form, file('primitive.json', invalid));
    assert.equal(form.values.json, original);
    assert.match(ui.modal.error.textContent, /单条观测 JSON 对象/);
    assert.equal(form.submit.disabled, false);
    assert.equal(ui.calls.length, 0);
  });
}

test('read rejection preserves JSON and a later valid selection clears the error', async () => {
  const ui = observationUi(), form = openForm(ui);
  await choose(ui, form, { name: 'unreadable.json', size: 10, text: async () => { throw new Error('Cannot read file'); } });
  assert.equal(form.values.json, original);
  assert.match(ui.modal.error.textContent, /Cannot read file/);
  assert.equal(form.submit.disabled, false);
  await choose(ui, form, file('good.json', secondJson));
  assert.equal(form.values.json, secondJson);
  assert.equal(ui.modal.error.hidden, true);
  assert.equal(ui.calls.length, 0);
});

for (const lateFailure of [false, true]) {
  test(`closed file read's late ${lateFailure ? 'failure' : 'success'} leaves a reopened form alone`, async () => {
    const ui = observationUi(), old = openForm(ui), pending = deferred(), current = deferred();
    const oldDone = choose(ui, old, file('old.json', pending.promise));
    await ui.click('close-dialog');
    const replacement = openForm(ui, secondJson);
    const currentDone = choose(ui, replacement, file('current.json', current.promise));
    const status = replacement.fileStatus.textContent;
    ui.modal.error.textContent = 'Keep the current error';
    ui.modal.error.hidden = false;
    if (lateFailure) pending.reject(new Error('Old read failed'));
    else pending.resolve(firstJson);
    await oldDone;
    assert.equal(ui.modal.open, true);
    assert.equal(ui.modal.form, replacement);
    assert.equal(replacement.values.json, secondJson);
    assert.equal(replacement.submit.disabled, true);
    assert.equal(replacement.fileStatus.textContent, status);
    assert.equal(ui.modal.error.textContent, 'Keep the current error');
    assert.equal(ui.modal.error.hidden, false);
    assert.equal(ui.toast.textContent, '');
    current.resolve(secondJson);
    await currentDone;
    assert.equal(replacement.submit.disabled, false);
    assert.equal(ui.calls.length, 0);
  });

  test(`session invalidation ignores late ${lateFailure ? 'failure' : 'success'} even on the same form`, async () => {
    const ui = observationUi(), form = openForm(ui), pending = deferred();
    const done = choose(ui, form, file('old.json', pending.promise));
    // Native cancel invalidates the dialog session synchronously, before the
    // browser subsequently closes it. Leave it open to isolate this guard.
    ui.modal.listeners.cancel({ preventDefault() {} });
    const status = form.fileStatus.textContent;
    if (lateFailure) pending.reject(new Error('Old read failed'));
    else pending.resolve(firstJson);
    await done;
    assert.equal(form.values.json, original);
    assert.equal(form.fileStatus.textContent, status);
    assert.equal(ui.modal.error.hidden, true);
    assert.equal(ui.toast.textContent, '');
    assert.equal(ui.calls.length, 0);
  });
}

test('pending read blocks button and synthetic submit without any automatic POST', async () => {
  const ui = observationUi(), form = openForm(ui), pending = deferred();
  const done = choose(ui, form, file('selected.json', pending.promise));
  const disabledWhileReading = form.submit.disabled;
  assert.equal(ui.calls.length, 0);
  await ui.submit(form);
  assert.equal(ui.calls.length, 0, 'stale original JSON must not be submitted');
  assert.equal(disabledWhileReading, true);
  assert.match(ui.modal.error.textContent, /仍在读取/);
  pending.resolve(secondJson);
  await done;
  assert.equal(ui.calls.length, 0, 'finishing a read only fills the textarea');
  assert.equal(form.submit.disabled, false);
  assert.equal(ui.modal.error.hidden, true);
});

test('explicit submit captures selected JSON before locking fields and uses the opening parcel', async () => {
  const ui = observationUi(), form = openForm(ui), pending = deferred();
  await choose(ui, form, file('selected.json', secondJson));
  ui.run("selectedId='p2'");
  ui.context.post = (path, body) => { ui.calls.push({ path, body }); return pending.promise; };
  const done = ui.submit(form);
  assert.equal(ui.calls.length, 1, 'fieldset must remain enabled until FormData has captured its JSON');
  assert.equal(ui.calls[0].path, '/parcels/p1/observations');
  assert.equal(JSON.stringify(ui.calls[0].body), secondJson);
  assert.equal(form.observationFields?.disabled, true);
  assert.equal(form.submit.disabled, true);
  await ui.submit(form);
  assert.equal(ui.calls.length, 1);
  pending.resolve({ id: 'selected-observation' });
  await done;
  assert.equal(ui.modal.open, false);
  assert.equal(form.observationFields.disabled, false);
  assert.equal(form.submit.disabled, false);
  assert.equal(form.dataset.submitting, undefined);
});

test('POST failure unlocks fields and preserves JSON for an explicit retry', async () => {
  const ui = observationUi(), form = openForm(ui), pending = deferred();
  await choose(ui, form, file('selected.json', secondJson));
  ui.context.post = (path, body) => { ui.calls.push({ path, body }); return pending.promise; };
  const done = ui.submit(form);
  assert.equal(form.observationFields?.disabled, true);
  assert.equal(form.submit.disabled, true);
  // Disabled controls cannot generate trusted user events. Defensive synthetic
  // change handling should likewise not start a read while the POST owns them.
  await choose(ui, form, { name: 'blocked.json', size: 100, text() { assert.fail('no file read during POST'); } });
  ui.modal.listeners.input({ target: form.textarea });
  assert.equal(form.submit.disabled, true);
  pending.reject(new Error('Import failed'));
  await done;
  assert.equal(ui.modal.open, true);
  assert.equal(form.values.json, secondJson);
  assert.equal(form.observationFields.disabled, false);
  assert.equal(form.submit.disabled, false);
  assert.equal(form.dataset.submitting, undefined);
  assert.match(ui.modal.error.textContent, /Import failed/);
  ui.context.post = async (path, body) => { ui.calls.push({ path, body }); return { id: 'retry-result' }; };
  await ui.submit(form);
  assert.equal(ui.calls.length, 2);
  assert.equal(JSON.stringify(ui.calls[1].body), secondJson);
  assert.equal(ui.modal.open, false);
});

for (const lateFailure of [false, true]) {
  test(`manual edit then POST stays locked when cancelled file ends with ${lateFailure ? 'failure' : 'success'}`, async () => {
    const ui = observationUi(), form = openForm(ui), reading = deferred(), posting = deferred();
    const readDone = choose(ui, form, file('cancelled.json', reading.promise));
    edit(ui, form, secondJson);
    ui.context.post = (path, body) => { ui.calls.push({ path, body }); return posting.promise; };
    const postDone = ui.submit(form);
    assert.equal(ui.calls.length, 1);
    if (lateFailure) reading.reject(new Error('Cancelled read failed'));
    else reading.resolve(firstJson);
    await readDone;
    assert.equal(form.submit.disabled, true);
    assert.equal(form.observationFields.disabled, true);
    assert.equal(form.values.json, secondJson);
    assert.equal(ui.modal.error.hidden, true);
    await ui.submit(form);
    assert.equal(ui.calls.length, 1);
    posting.reject(new Error('Import failed'));
    await postDone;
    assert.equal(form.submit.disabled, false);
    assert.equal(form.observationFields.disabled, false);
    assert.match(ui.modal.error.textContent, /Import failed/);
  });
}

test('selected filename is rendered only as literal status text', async () => {
  const ui = observationUi(), form = openForm(ui), name = '<img src=x onerror="alert(1)">.json';
  const markup = ui.modal.innerHTML;
  await choose(ui, form, file(name, secondJson));
  assert.ok(form.fileStatus.textContent.includes(name));
  assert.equal(ui.modal.innerHTML, markup);
  assert.equal(form.values.json, secondJson);
  assert.equal(ui.calls.length, 0);
});


// Synthetic contract-shaped records, never evidence about a real farm.
function normalizedBundle(count = 2) {
  return {
    schema_version: 1, bundle_id: 'synthetic-test-only', scope: 'parcel',
    bundle_sha256: 'a'.repeat(64), processing_version: 'local-bundle-v1-scl45-median',
    limitations: ['Synthetic test record; not farm truth'],
    observations: Array.from({length:count}, (_,i) => ({
      source: i ? 'weather' : 'sentinel2', source_record_id: `synthetic-${i}`,
      observed_at: '2026-10-01T00:00:00+00:00',
      features: i ? { temperature_min_c: null, precipitation_mm: 0 } : { ndvi: 0.4 },
      quality: { usable: !i, valid_fraction: i ? 2/3 : 0.8, flags: i ? ['coarse_grid_context_only','missing_parameters'] : ['scl45_only'] },
      provenance: {
        provider: 'Synthetic test provider', collection: 'test', item_id: `test-${i}`,
        processing_version: 'local-bundle-v1-scl45-median', retrieved_at: '2026-10-02T00:00:00Z',
        usage_scope: 'parcel', parcel_geometry_sha256: 'b'.repeat(64),
        ...(i ? {} : {parcel_mask_sha256:'c'.repeat(64)}),
        asset_checksums: {input:'c'.repeat(64)},
        spatial_support: {kind:i?'coarse_grid':'parcel'}, temporal_support:i?'daily_utc':'instantaneous',
      },
    })),
  };
}
const pickRecord = (ui, form, value) => { form.recordSelect.value=value; return ui.modal.listeners.change({target:form.recordSelect}); };

test('normalized output requires an explicit choice then posts exactly that record to opening parcel', async () => {
  const ui=observationUi(), form=openForm(ui), bundle=normalizedBundle();
  await choose(ui,form,file('normalized.json',JSON.stringify(bundle)));
  assert.equal(form.choices.hidden,false);
  assert.equal(form.submit.disabled,true);
  assert.equal(form.values.json,original);
  await ui.submit(form);
  assert.equal(ui.calls.length,0);
  await pickRecord(ui,form,'1');
  assert.equal(form.submit.disabled,false);
  assert.equal(ui.modal.error.hidden,true);
  assert.deepEqual(JSON.parse(form.values.json),bundle.observations[1]);
  assert.match(form.preview.textContent,/有效参数比例 66.7%/);
  assert.match(form.preview.textContent,/temperature_min_c.*null/);
  assert.match(form.preview.textContent,/未独立核验/);
  ui.run("selectedId='p2'");
  assert.equal(ui.calls.length,0);
  await ui.submit(form);
  assert.equal(ui.calls.length,1);
  assert.equal(ui.calls[0].path,'/parcels/p1/observations');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0].body)),bundle.observations[1]);
});

test('one-row envelope also needs selection; blank and invalid choices never use old JSON', async () => {
  const ui=observationUi(),form=openForm(ui),bundle=normalizedBundle(1);
  await choose(ui,form,file('one.json',JSON.stringify(bundle)));
  await ui.submit(form);assert.equal(ui.calls.length,0);
  await pickRecord(ui,form,'0');
  assert.equal(form.submit.disabled,false);
  assert.match(form.preview.textContent,/地块掩膜 SHA-256：c{64}/);
  assert.deepEqual(JSON.parse(form.values.json).provenance.asset_checksums,{input:'c'.repeat(64)});
  for(const value of ['', '-1', '20','0.5']){
    await pickRecord(ui,form,value);await ui.submit(form);assert.equal(ui.calls.length,0);assert.equal(form.submit.disabled,true);
  }
});

test('malformed, empty, contradictory and public envelopes fail without losing original JSON', async () => {
  const variants=[
    b=>{b.observations=[];}, b=>{b.schema_version=2;}, b=>{delete b.observations;}, b=>{b.limitations={};},
    b=>{b.bundle_sha256='no';}, b=>{b.observations[1].provenance.parcel_geometry_sha256='d'.repeat(64);},
    b=>{b.observations[1].provenance.processing_version='other';}, b=>{b.observations[1].quality.usable='yes';},
    b=>{b.scope='public_sample';}, b=>{b.observations[1].provenance.usage_scope='public_sample';},
    b=>{b.observations[1].provenance.spatial_support.kind='public_window';},
    b=>{b.observations[1].quality.flags.push('no_crop_truth');},
  ];
  for(const mutate of variants){
    const ui=observationUi(),form=openForm(ui),bundle=normalizedBundle();mutate(bundle);
    await choose(ui,form,file('invalid.json',JSON.stringify(bundle)));
    assert.equal(form.values.json,original);assert.equal(form.choices.hidden,true);
    assert.equal(ui.modal.error.hidden,false);assert.equal(ui.calls.length,0);
    if(Array.isArray(bundle.observations)&&!bundle.observations.length)assert.match(ui.modal.error.textContent,/没有可选择/);
  }
});

test('single-record compatibility and every explicit public marker remain safe', () => {
  const record=normalizedBundle(1).observations[0];
  assert.deepEqual(parseObservationInput(JSON.stringify(record)),{kind:'single',record});
  for(const mutate of [r=>{r.data_origin='public_sample';},r=>{r.provenance.usage_scope='public_sample';},r=>{r.provenance.spatial_support.kind='public_window';},r=>{r.quality.flags.push('no_crop_truth');}]){
    const copy=structuredClone(record);mutate(copy);assert.throws(()=>parseObservationInput(JSON.stringify(copy)),/公开样本/);
  }
  assert.equal(parseObservationInput('{"source":"manual"}').kind,'single');
});

test('file labels and metadata are escaped; preview treats provenance and flags as literal text', async () => {
  const ui=observationUi(),form=openForm(ui),bundle=normalizedBundle(1),danger='<img src=x onerror=alert(1)>';
  bundle.bundle_id=danger;bundle.limitations=[danger];bundle.observations[0].source_record_id=danger;
  bundle.observations[0].provenance.provider=danger;bundle.observations[0].quality.flags=[danger];
  await choose(ui,form,file(danger,JSON.stringify(bundle)));await pickRecord(ui,form,'0');
  assert.equal(form.choices.innerHTML.includes('<img'),false);assert.match(form.choices.innerHTML,/&lt;img/);
  assert.ok(form.preview.textContent.includes(danger));assert.ok(form.fileStatus.textContent.includes('1 / 1'));
  assert.equal(ui.calls.length,0);
});

test('manual editing and replacement files invalidate a previous bundle choice', async () => {
  const ui=observationUi(),form=openForm(ui),bundle=normalizedBundle();
  await choose(ui,form,file('bundle.json',JSON.stringify(bundle)));await pickRecord(ui,form,'0');
  edit(ui,form,secondJson);assert.equal(form.choices.hidden,true);assert.equal(form.submit.disabled,false);
  await pickRecord(ui,form,'1');assert.equal(form.values.json,secondJson);
  const pending=deferred();const done=choose(ui,form,file('new.json',pending.promise));
  await ui.submit(form);assert.equal(ui.calls.length,0);
  pending.resolve(JSON.stringify(bundle));await done;
  assert.equal(form.submit.disabled,true);await ui.submit(form);assert.equal(ui.calls.length,0);
});

test('newer file and manual editing cannot be overwritten by a late envelope', async () => {
  for(const manual of [false,true]){
    const ui=observationUi(),form=openForm(ui),pending=deferred();
    const done=choose(ui,form,file('slow.json',pending.promise));
    if(manual)edit(ui,form,secondJson);else await choose(ui,form,file('single.json',secondJson));
    pending.resolve(JSON.stringify(normalizedBundle()));await done;
    assert.equal(form.values.json,secondJson);assert.equal(form.choices.hidden,true);assert.equal(form.submit.disabled,false);
  }
});

test('failed selected-record POST retains exact choice and locks changes until retry is possible', async () => {
  const ui=observationUi(),form=openForm(ui),bundle=normalizedBundle(),pending=deferred();
  await choose(ui,form,file('bundle.json',JSON.stringify(bundle)));await pickRecord(ui,form,'0');
  ui.context.post=async(path,body)=>{ui.calls.push({path,body});return pending.promise;};
  const posted=ui.submit(form);
  await pickRecord(ui,form,'1');
  await choose(ui,form,file('ignored.json',secondJson));
  assert.deepEqual(JSON.parse(form.values.json),bundle.observations[0]);
  pending.reject(new Error('test network loss'));await posted;
  assert.equal(form.submit.disabled,false);assert.equal(form.choices.hidden,false);
  assert.equal(ui.modal.open,true);assert.equal(ui.calls.length,1);
  ui.context.post=async(path,body)=>{ui.calls.push({path,body});return {id:'saved'};};
  await ui.submit(form);assert.equal(ui.calls.length,2);
  assert.deepEqual(JSON.stringify(ui.calls[0]),JSON.stringify(ui.calls[1]));
});

test('normalized selection supports more than 100 observations without fabricating missing values', () => {
  const bundle=normalizedBundle(101),parsed=parseObservationInput(JSON.stringify(bundle));
  assert.equal(parsed.bundle.observations.length,101);
  assert.equal(parsed.bundle.observations[1].features.temperature_min_c,null);
  assert.match(observationImportSummary(parsed.bundle.observations[1]),/daily_utc/);
});
