import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deferred } from './helpers/ui-harness.mjs';
import { syntheticAnalysisReceipt } from './helpers/analysis-observation-receipts.mjs';
import { statuses } from '../src/display.ts';
const parcel = { id: 'p1', data_origin: 'user' };
function setup() {
  const ui = harness(), calls = [];
  Object.assign(ui.context, { statuses, refreshCount: 0, post: async (path, body) => { calls.push({ path, body }); return syntheticAnalysisReceipt(parcel); } });
  ui.run("refresh=async()=>{refreshCount++};analyses=[{id:'retained-analysis',parcel_id:'p1',status:'legacy-state'}];observations=[{id:'retained-observation',parcel_id:'p1'}];");
  return { ...ui, calls };
}

test('analysis rejects malformed or wrong-target/method/business receipts without changing the loaded analysis or refreshing', async () => {
  for (const corrupt of [() => ({}), () => ({ id: 'only-id' }), raw => ({ ...raw, parcel_id: 'p2' }),
    raw => ({ ...raw, method: 'isolation_forest' }), raw => ({ ...raw, status: 'candidate' }),
    raw => ({ ...raw, risk_id: 'foreign-risk' }), raw => ({ ...raw, monitoring_eligible: true }),
    raw => ({ ...raw, mode: 'fixture_demo', data_origin: 'fixture' })]) {
    const ui = setup(), before = ui.run('JSON.stringify({selectedId,analyses,observations})');
    ui.context.post = async (path, body) => { ui.calls.push({ path, body }); return corrupt(syntheticAnalysisReceipt(parcel)); };
    await ui.click('analyze');
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].path, '/parcels/p1/analyses');
    assert.match(ui.toast.textContent, /分析回执.*尚未确认/); assert.equal(ui.context.refreshCount, 0);
    assert.equal(ui.run('JSON.stringify({selectedId,analyses,observations})'), before);
  }
});

test('analysis request target and mode remain bound to the clicked parcel when selection changes during the request', async () => {
  const ui = setup(), pending = deferred();
  ui.context.post = async (path, body) => { ui.calls.push({ path, body }); return pending.promise; };
  const running = ui.click('analyze'); ui.run("selectedId='p2';dashboard.parcels[0].data_origin='fixture';");
  pending.resolve(syntheticAnalysisReceipt(parcel)); await running;
  assert.equal(ui.calls[0].path, '/parcels/p1/analyses'); assert.equal(ui.run('selectedId'), 'p2');
  assert.equal(ui.context.refreshCount, 1); assert.match(ui.toast.textContent, /预览|preview_only/);
  assert.equal(ui.run('analyses[0].id'), 'retained-analysis', 'acknowledgment is not optimistically inserted into the newly selected parcel');
});

test('disabled analysis action blocks repeated clicks while awaiting the same button request', async () => {
  const ui = setup(), pending = deferred(), button = new ui.context.HTMLButtonElement({ action: 'analyze' });
  ui.context.post = async (path, body) => { ui.calls.push({ path, body }); return pending.promise; };
  const click = () => ui.context.document.listeners.click({ target: { closest: () => button } });
  const running = click(); assert.equal(button.disabled, true); await click(); assert.equal(ui.calls.length, 1);
  pending.resolve({}); await running; assert.equal(button.disabled, false); assert.match(ui.toast.textContent, /尚未确认/);
});
