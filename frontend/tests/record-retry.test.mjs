import test from 'node:test';
import assert from 'node:assert/strict';
import { post } from '../src/api.ts';
import { harness, deferred, turn } from './helpers/ui-harness.mjs';

// Production main.ts handlers and api.ts transport, with only DOM/fetch mocked.
// These tests do not replace backend transaction tests or browser acceptance.
const polygon = { type: 'Polygon', coordinates: [[[112, 30], [112.01, 30], [112.01, 30.01], [112, 30]]] };
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const ambiguous = /原记录可能已经保存/;
const lostResponse = () => { throw new TypeError('Response lost after server commit'); };

function transport(t, respond = lostResponse, options) {
  const ui = harness(options), calls = [];
  ui.context.post = post;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    const call = { path, method: options.method, body: options.body, headers: new Headers(options.headers) };
    calls.push(call);
    return respond(call, calls.length);
  });
  return { ui, calls };
}

function openForm(ui, type) {
  ui.run(type === 'parcel' ? 'parcelModal()' : 'eventModal()');
  const form = ui.modal.form;
  Object.assign(form.values, type === 'parcel'
    ? { name: 'Original parcel', region: 'shayang', season: '2026-2027', geometry: JSON.stringify(polygon), sowing_date: '', cultivar: '' }
    : { occurred_on: '2026-10-18', kind: 'drainage', note: 'Original event' });
  return form;
}
const key = call => call.headers.get('Idempotency-Key');

for (const type of ['parcel', 'event']) {
  const field = type === 'parcel' ? 'name' : 'note';

  test(`${type}: lost response retry sends the same key and body, then accepts the original result`, async t => {
    const records = new Map();
    const { ui, calls } = transport(t, (call, attempt) => {
      const identity = key(call) || `unkeyed-${attempt}`;
      if (!records.has(identity)) records.set(identity, { id: `saved-${type}-${records.size + 1}` });
      if (attempt === 1) return lostResponse();
      return Response.json(records.get(identity), { status: 201 });
    });
    const form = openForm(ui, type), values = { ...form.values };
    await ui.submit(form);
    assert.equal(ui.modal.open, true);
    assert.equal(ui.modal.form, form);
    assert.deepEqual(form.values, values);
    assert.equal(form.submit.disabled, false);
    assert.match(ui.modal.error.textContent, ambiguous);
    assert.match(key(calls[0]), uuid);
    await ui.submit(form);
    assert.equal(calls.length, 2);
    assert.equal(key(calls[1]), key(calls[0]));
    assert.equal(calls[1].body, calls[0].body);
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].headers.get('Content-Type'), 'application/json');
    assert.equal(records.size, 1);
    assert.equal(ui.modal.open, false);
    if (type === 'parcel') assert.equal(ui.run('selectedId'), 'saved-parcel-1');
  });

  test(`${type}: changed content gets a new key and A/B/A edits reuse the original key`, async t => {
    const { ui, calls } = transport(t);
    const form = openForm(ui, type), original = form.values[field];
    await ui.submit(form);
    form.values[field] = `${original} changed`;
    await ui.submit(form);
    form.values[field] = original;
    await ui.submit(form);
    form.values[field] = `  ${original} \n`;
    await ui.submit(form);
    assert.equal(calls.length, 4);
    calls.forEach(call => assert.match(key(call), uuid));
    assert.notEqual(key(calls[0]), key(calls[1]));
    assert.equal(key(calls[0]), key(calls[2]));
    assert.equal(key(calls[0]), key(calls[3]));
    assert.notEqual(calls[0].body, calls[1].body);
    assert.equal(calls[0].body, calls[2].body);
    assert.equal(calls[0].body, calls[3].body);
  });

  test(`${type}: duplicate submits stay gated while a request is pending`, async t => {
    const pending = deferred();
    const { ui, calls } = transport(t, (_, count) => count === 1 ? pending.promise : lostResponse());
    const form = openForm(ui, type);
    const first = ui.submit(form);
    assert.equal(form.submit.disabled, true);
    await ui.submit(form);
    assert.equal(calls.length, 1);
    pending.reject(new TypeError('Connection lost'));
    await first;
    assert.equal(form.submit.disabled, false);
    await ui.submit(form);
    assert.equal(calls.length, 2);
    assert.equal(key(calls[0]), key(calls[1]));
  });

  test(`${type}: late success cannot close or select over a replacement form`, async t => {
    const pending = deferred();
    const { ui, calls } = transport(t, () => pending.promise);
    const old = openForm(ui, type), done = ui.submit(old);
    await ui.click('close-dialog');
    const replacement = openForm(ui, type);
    replacement.values[field] = 'Keep these unsaved edits';
    ui.run("selectedId='p2'");
    pending.resolve(Response.json({ id: 'old-result' }, { status: 201 }));
    await done;
    assert.equal(calls.length, 1);
    assert.equal(ui.modal.open, true);
    assert.equal(ui.modal.form, replacement);
    assert.equal(replacement.values[field], 'Keep these unsaved edits');
    assert.equal(replacement.submit.disabled, false);
    assert.equal(ui.modal.error.hidden, true);
    assert.equal(ui.run('selectedId'), 'p2');
  });

  test(`${type}: late failure stays out of a newer form and leaves its pending submit gated`, async t => {
    const oldRequest = deferred(), newRequest = deferred();
    const { ui, calls } = transport(t, (_, count) => count === 1 ? oldRequest.promise : newRequest.promise);
    const old = openForm(ui, type), oldDone = ui.submit(old);
    await ui.click('close-dialog');
    const replacement = openForm(ui, type), newDone = ui.submit(replacement);
    oldRequest.reject(new TypeError('Old connection lost'));
    await oldDone;
    assert.equal(ui.modal.form, replacement);
    assert.equal(ui.modal.open, true);
    assert.equal(ui.modal.error.hidden, true);
    assert.equal(replacement.submit.disabled, true);
    assert.match(ui.toast.textContent, /先前表单保存未确认/);
    assert.match(ui.toast.textContent, ambiguous);
    assert.notEqual(key(calls[0]), key(calls[1]));
    newRequest.resolve(Response.json({ id: 'new-result' }, { status: 201 }));
    await newDone;
    assert.equal(ui.modal.open, false);
    if (type === 'parcel') assert.equal(ui.run('selectedId'), 'new-result');
  });

  test(`${type}: known validation errors keep field details without an ambiguous-save claim`, async t => {
    const { ui, calls } = transport(t, () => Response.json({ error: {
      message: '输入不符合约定', details: [{ field: `body.${field}`, message: '字段不符合要求' }],
    } }, { status: 422 }));
    const form = openForm(ui, type);
    await ui.submit(form);
    assert.equal(calls.length, 1);
    assert.match(ui.modal.error.textContent, new RegExp(`body\\.${field}：字段不符合要求`));
    assert.doesNotMatch(ui.modal.error.textContent, ambiguous);
    assert.equal(ui.modal.open, true);
    assert.equal(form.submit.disabled, false);
  });

  test(`${type}: server failures explain that the prior save may already exist`, async t => {
    const { ui } = transport(t, () => Response.json({ error: { message: '服务暂不可用' } }, { status: 503 }));
    const form = openForm(ui, type);
    await ui.submit(form);
    assert.match(ui.modal.error.textContent, /服务暂不可用/);
    assert.match(ui.modal.error.textContent, ambiguous);
    assert.match(ui.modal.error.textContent, /改内容或重开表单前请先检查列表/);
    assert.equal(ui.modal.open, true);
    assert.equal(form.submit.disabled, false);
  });
}

test('parcel: equivalent JSON key order, whitespace, and Feature wrapper retain the request key', async t => {
  const { ui, calls } = transport(t);
  const form = openForm(ui, 'parcel');
  await ui.submit(form);
  form.values.geometry = JSON.stringify({ coordinates: polygon.coordinates, type: 'Polygon' }, null, 2);
  await ui.submit(form);
  form.values.geometry = JSON.stringify({ type: 'Feature', properties: { ignored: 'not sent' }, geometry: polygon }, null, 2);
  await ui.submit(form);
  assert.equal(calls.length, 3);
  calls.forEach(call => assert.equal(key(call), key(calls[0])));
  calls.forEach(call => assert.deepEqual(JSON.parse(call.body), JSON.parse(calls[0].body)));
  const changed = structuredClone(polygon);
  changed.coordinates[0][1][0] = 112.02;
  form.values.geometry = JSON.stringify(changed);
  await ui.submit(form);
  assert.notEqual(key(calls[3]), key(calls[0]));
});

test('event: request keys bind the exact target path, while selection changes keep the opened target', async t => {
  const { ui, calls } = transport(t);
  const form = openForm(ui, 'event');
  await ui.submit(form);
  ui.run("selectedId='p2'");
  await ui.submit(form);
  assert.equal(calls[0].path, '/api/v1/parcels/p1/events');
  assert.equal(calls[1].path, calls[0].path);
  assert.equal(key(calls[1]), key(calls[0]));
  // Mutate the same fake form to ensure the fingerprint includes the path.
  form.dataset.parcel = 'p2';
  await ui.submit(form);
  assert.equal(calls[2].path, '/api/v1/parcels/p2/events');
  assert.notEqual(key(calls[2]), key(calls[0]));
  form.dataset.parcel = 'p1';
  await ui.submit(form);
  assert.equal(key(calls[3]), key(calls[0]));
});

test('reopening or reloading deliberately creates a new form identity', async t => {
  const { ui, calls } = transport(t);
  const original = openForm(ui, 'event');
  await ui.submit(original);
  await ui.click('close-dialog');
  const reopened = openForm(ui, 'event');
  await ui.submit(reopened);
  const reloaded = harness();
  reloaded.context.post = post;
  await reloaded.submit(openForm(reloaded, 'event'));
  assert.notEqual(original, reopened);
  assert.equal(new Set(calls.map(key)).size, 3);
  calls.forEach(call => assert.match(key(call), uuid));
  calls.forEach(call => assert.equal(call.body, calls[0].body));
});

test('opening, editing, rendering, network events, and invalid forms never automatically POST', async t => {
  const { ui, calls } = transport(t, lostResponse, { pathname: '/field' });
  const parcel = openForm(ui, 'parcel');
  parcel.values.name = 'Edited without submitting';
  ui.modal.listeners.input({ target: { name: 'name', value: parcel.values.name, closest: () => null } });
  ui.run('render()');
  ui.window.listeners.offline();
  ui.window.listeners.online();
  await turn();
  assert.equal(calls.length, 0);
  parcel.reportValidity = () => false;
  await ui.submit(parcel);
  assert.equal(calls.length, 0);
  parcel.reportValidity = () => true;
  parcel.values.geometry = '{broken JSON';
  await ui.submit(parcel);
  assert.equal(calls.length, 0);
  assert.match(ui.modal.error.textContent, /JSON 格式不正确/);
  assert.doesNotMatch(ui.modal.error.textContent, ambiguous);
  const event = openForm(ui, 'event');
  event.values.note = 'Edited offline';
  ui.modal.listeners.input({ target: { name: 'note', value: event.values.note, closest: () => null } });
  ui.window.listeners.online();
  await turn();
  assert.equal(calls.length, 0);
});

test('only supported record creates carry idempotency headers; analysis and imports are unchanged', async t => {
  const { ui, calls } = transport(t, call => Response.json(call.path.endsWith('/analyses')
    ? { status: 'insufficient_data', message: 'No usable data' }
    : { id: 'ordinary-result', created: false, parcel_id: 'p1' }));
  ui.run('observationModal()');
  ui.modal.form.values.json = JSON.stringify({ source: 'manual' });
  await ui.submit();
  ui.run("risks=[{id:'r1',parcel_id:'p1',summary:'Check field'}]; visitModal('r1')");
  Object.assign(ui.modal.form.values, { due_date: '2026-10-18', assignee: '', note: '' });
  await ui.submit();
  ui.context.statuses = {};
  await ui.click('analyze');
  await ui.click('load-fixtures');
  assert.equal(calls.length, 3, 'opening the fixture confirmation must not create a fixture');
  await ui.click('confirm-fixtures');
  assert.deepEqual(calls.map(call => call.path), [
    '/api/v1/parcels/p1/observations', '/api/v1/visits', '/api/v1/parcels/p1/analyses', '/api/v1/dev/fixtures',
  ]);
  calls.forEach(call => {
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.has('Idempotency-Key'), call.path === '/api/v1/visits');
    assert.equal(call.headers.get('Content-Type'), 'application/json');
  });
});
