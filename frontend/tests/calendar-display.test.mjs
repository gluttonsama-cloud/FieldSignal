import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const frontend=new URL('../',import.meta.url);
function inZone(zone,source) {
  return JSON.parse(execFileSync(process.execPath,['--input-type=module','--eval',source],{cwd:frontend,env:{...process.env,TZ:zone},encoding:'utf8'}));
}

test('calendar dates retain their entered day across negative, zero, positive and DST timezones',()=>{
  const dates=['2026-10-18','2026-01-01','2024-02-29','2026-03-08','2026-11-01'];
  for(const zone of ['America/Los_Angeles','Pacific/Honolulu','UTC','Asia/Shanghai','Pacific/Kiritimati']){
    const values=inZone(zone,`import {fmtDate} from './src/display.ts'; console.log(JSON.stringify(${JSON.stringify(dates)}.map(fmtDate)));`);
    assert.deepEqual(values,['2026/10/18','2026/01/01','2024/02/29','2026/03/08','2026/11/01'],zone);
  }
});

test('real timestamp instants keep device-local date rendering and invalid calendar dates do not roll over',()=>{
  for(const [zone,expected] of [['America/Los_Angeles',['2026/10/17','2026/10/18']],['Asia/Shanghai',['2026/10/18','2026/10/19']]]){
    const values=inZone(zone,`import {fmtDate} from './src/display.ts'; console.log(JSON.stringify(['2026-10-18T00:30:00Z','2026-10-18T23:30:00Z','2026-02-30','not-a-date',''].map(fmtDate)));`);
    assert.deepEqual(values,[...expected,'日期无效','日期无效','暂无']);
  }
});

test('task plan, farm history and parcel sowing date use unchanged calendar days on a negative-UTC device',()=>{
  const values=inZone('America/Los_Angeles',`
    import * as display from './src/display.ts'; import {harness} from './tests/helpers/ui-harness.mjs';
    const ui=harness({pathname:'/field'});Object.assign(ui.context,display);
    ui.run("dashboard.parcels=[{id:'p1',name:'Parcel',region:'other',season:'2026-2027',sowing_date:'2026-10-18',area_ha:1}];selectedId='p1';eventsState='ready';eventsParcelId='p1';events=[{parcel_id:'p1',occurred_on:'2026-10-18',kind:'sowing',note:'Planted'}]");
    console.log(JSON.stringify([ui.run("visitCard({id:'v1',parcel_id:'p1',due_date:'2026-10-18'})"),ui.run('fieldRecords()'),ui.run('parcelDetail(dashboard.parcels[0])')]));
  `);
  for(const html of values){assert.match(html,/2026\/10\/18/);assert.doesNotMatch(html,/2026\/10\/17/);}
});
