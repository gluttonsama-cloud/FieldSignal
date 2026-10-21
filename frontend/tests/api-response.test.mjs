import test from 'node:test';
import assert from 'node:assert/strict';
import { api, post, ApiError } from '../src/api.ts';
import { harness } from './helpers/ui-harness.mjs';

// The real transport and production form handler, with synthetic fetch/DOM only.
for (const [name, response] of [
  ['HTML',()=>new Response('<html>proxy fallback</html>',{status:200,headers:{'Content-Type':'text/html'}})],
  ['empty',()=>new Response('',{status:201})],
  ['truncated JSON',()=>new Response('{"id":',{status:201})],
  ['null JSON',()=>Response.json(null,{status:201})],
  ['primitive JSON',()=>Response.json('saved',{status:201})],
  ['unexpected no-content',()=>new Response(null,{status:204})],
]) {
  test(`unacknowledged ${name} mutation keeps the form, inputs and original manual retry identity`,async t=>{
    const ui=harness(),calls=[];
    ui.context.post=post;
    t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,body:options.body,key:new Headers(options.headers).get('Idempotency-Key')});return response();});
    ui.run('eventModal()');const form=ui.modal.form;
    Object.assign(form.values,{occurred_on:'2026-10-18',kind:'drainage',note:'Synthetic retained event'});
    const before=structuredClone(form.values);
    await ui.submit(form);
    assert.equal(ui.modal.open,true,'unknown result must not close the retry form');
    assert.equal(ui.modal.form,form);assert.deepEqual(form.values,before);
    assert.equal(form.submit.disabled,false);assert.match(ui.modal.error.textContent,/原记录可能已经保存/);
    assert.doesNotMatch(ui.toast.textContent,/已保存/);
    await ui.submit(form);assert.equal(calls.length,2);
    assert.equal(calls[0].key,calls[1].key);assert.equal(calls[0].body,calls[1].body);
  });
}

test('read responses reject malformed or primitive success instead of publishing empty/invalid state',async t=>{
  for(const make of [()=>new Response('',{status:200}),()=>Response.json(null),()=>Response.json(true),()=>Response.json(42),()=>Response.json('not a record')]){
    t.mock.method(globalThis,'fetch',async()=>make());
    await assert.rejects(api('/dashboard'));
    t.mock.restoreAll();
  }
});

test('expected no-content photo deletion remains valid, but a POST or GET 204 is never acknowledged',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:204}));
  await assert.doesNotReject(api('/visits/synthetic/photos/synthetic',{method:'DELETE'}));
  await assert.rejects(post('/visits',{}));await assert.rejects(api('/dashboard'));
});

test('valid JSON collections and objects pass, and malformed error bodies retain their HTTP rejection status',async t=>{
  for(const value of [[],[{id:'synthetic'}],{status:'ok'}]){
    t.mock.method(globalThis,'fetch',async()=>Response.json(value));
    assert.deepEqual(await api('/synthetic'),value);t.mock.restoreAll();
  }
  for(const status of [400,409,422,500]){
    t.mock.method(globalThis,'fetch',async()=>new Response('<html>failure</html>',{status}));
    await assert.rejects(api('/synthetic'),error=>error instanceof ApiError&&error.status===status);
    t.mock.restoreAll();
  }
});
