import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deferred } from './helpers/ui-harness.mjs';

// Run the production change/input/submit handlers. These DOM stubs cover async
// ownership and disabled-fieldset FormData semantics, not browser/visual QA.
const original = '{"source_record_id":"original","features":{"ndvi":0.2}}';
const firstJson = '{"source_record_id":"first","features":{"ndvi":0.3}}';
const secondJson = '{"source_record_id":"second","features":{"ndvi":0.4}}';

function observationUi() {
  const ui = harness(), calls = [];
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
  form.fileInput = {
    id: 'observation-file', files: [],
    closest: selector => selector === '#observation-form' ? form : null,
  };
  form.querySelector = selector => selector === 'textarea[name="json"]' ? form.textarea
    : selector === '#observation-file-status' ? form.fileStatus
    : selector === '#observation-fields' ? form.observationFields : query(selector);
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
