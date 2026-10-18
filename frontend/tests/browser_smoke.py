"""Optional local Chromium E2E. Starts its own isolated API and uses the production build.
Requires backend dependencies, Python Playwright and Chromium. This suite was blocked
before browser launch in the delivery sandbox; it is not claimed as passing.
"""
from pathlib import Path
import os, subprocess, tempfile, time, urllib.request, atexit, socket
from io import BytesIO
from PIL import Image
from playwright.sync_api import sync_playwright

with socket.socket() as port_probe:
    port_probe.bind(('127.0.0.1',0))
    PORT=port_probe.getsockname()[1]
BASE = f'http://127.0.0.1:{PORT}'
ROOT = Path(__file__).resolve().parents[2]
tmp = tempfile.TemporaryDirectory(prefix='fieldsignal-browser-')
env = os.environ | {'FIELDSIGNAL_DB': str(Path(tmp.name)/'browser.sqlite3'), 'FIELDSIGNAL_ENABLE_FIXTURES':'1', 'PYTHONPATH':str(ROOT/'backend')}
server = subprocess.Popen(['python','-m','uvicorn','app.main:app','--host','127.0.0.1','--port',str(PORT)],cwd=ROOT/'backend',env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
atexit.register(lambda: server.terminate())
for _ in range(100):
    try:
        if server.poll() is not None: raise RuntimeError('Isolated API exited before readiness')
        urllib.request.urlopen(BASE+'/api/v1/health',timeout=1)
        break
    except Exception: time.sleep(.1)
else: raise RuntimeError('API did not start')
OUT = Path(__file__).resolve().parents[1] / 'screenshots'
OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN','/usr/bin/chromium'), headless=True, chromium_sandbox=True,env=os.environ|{'HOME':tmp.name})
    context = browser.new_context(viewport={'width':1440,'height':1080}, device_scale_factor=1)
    page = context.new_page()
    errors=[]
    remote=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('request',lambda req:remote.append(req.url) if not req.url.startswith((BASE,'data:','blob:')) else None)
    page.goto(BASE+'/admin')
    page.get_by_text('本地服务已连接',exact=True).wait_for()
    page.get_by_role('heading',name='油菜地块监测').wait_for()
    page.screenshot(path=str(OUT/'admin-empty.png'),full_page=True)
    assert page.locator('.stat strong').first.inner_text().strip().startswith('0'), 'Use an empty isolated database for this test'
    page.get_by_role('button',name='录入地块',exact=True).last.click()
    page.get_by_label('地块名称').fill('浏览器测试地块')
    page.get_by_label('种植季',exact=True).fill('2026–2027')
    page.get_by_label('地块边界 · GeoJSON Polygon').fill('invalid json')
    page.get_by_role('button',name='保存地块',exact=True).click()
    page.get_by_text('JSON 格式不正确，请检查括号、引号与逗号。',exact=True).wait_for()
    page.get_by_role('button',name='取消',exact=True).click()
    assert not page.locator('dialog').is_visible()
    # Open / cancel repeatedly and Escape; no stuck modal or navigation state.
    for _ in range(2):
        page.get_by_role('button',name='＋ 录入地块',exact=True).click()
        page.keyboard.press('Escape')
        assert not page.locator('dialog').is_visible()
    page.get_by_role('button',name='加载开发模拟数据 ↗',exact=True).click()
    page.get_by_role('button',name='确认加载模拟数据',exact=True).click()
    page.locator('.detail-heading').wait_for()
    page.get_by_role('button',name='运行统计分析',exact=True).click()
    page.get_by_role('button',name='安排田间核查',exact=False).first.wait_for()
    page.screenshot(path=str(OUT/'admin-fixture.png'),full_page=True)
    page.get_by_role('button',name='安排田间核查',exact=False).first.click()
    page.get_by_label('执行人（选填）').fill('本地界面测试')
    page.get_by_role('button',name='创建巡田任务',exact=True).click()
    page.get_by_text('已安排巡田任务',exact=True).wait_for()
    mobile = browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=1)
    phone=mobile.new_page()
    phone.on('pageerror',lambda e:errors.append(str(e)))
    phone.on('request',lambda req:remote.append(req.url) if not req.url.startswith((BASE,'data:','blob:')) else None)
    phone.goto(BASE+'/field')
    phone.get_by_role('button',name='开始现场核查',exact=False).wait_for()
    phone.screenshot(path=str(OUT/'field-pending.png'),full_page=True)
    phone.get_by_role('button',name='开始现场核查',exact=False).click()
    phone.get_by_label('田间积水',exact=True).check()
    phone.get_by_label('现场备注',exact=True).fill('模拟流程测试：离线草稿保留与恢复，不代表真实农情。')
    png=BytesIO(); Image.new('RGB',(40,40),'green').save(png,format='PNG')
    phone.locator('#photo-input').set_input_files({'name':'local-test.png','mimeType':'image/png','buffer':png.getvalue()})
    phone.get_by_text('已保存到本机',exact=False).wait_for()
    assert phone.locator('.draft-photo').count()==1
    # Cut API requests only: page is open, not claiming offline app shell capability.
    phone.route('**/api/v1/**',lambda route:route.abort('internetdisconnected'))
    phone.get_by_role('button',name='提交核查',exact=True).click()
    phone.get_by_text('草稿和照片未删除。',exact=False).wait_for()
    stored=phone.evaluate("""async () => await new Promise((resolve,reject)=>{const q=indexedDB.open('fieldsignal-local-drafts',2);q.onsuccess=()=>{const r=q.result.transaction('verifications').objectStore('verifications').getAll();r.onsuccess=()=>resolve(r.result.filter(x=>!x.removed).map(x=>({note:x.note,photos:x.photos.length,bytes:x.photos[0]?.blob.size,state:x.state,key:x.client_submission_id})));};q.onerror=reject;})""")
    assert len(stored)==1 and stored[0]['state']=='error' and stored[0]['photos']==1 and stored[0]['bytes']>0
    phone.screenshot(path=str(OUT/'field-offline-draft.png'),full_page=True)
    phone.get_by_role('button',name='保存并返回',exact=True).click()
    phone.reload()
    phone.get_by_role('button',name='上次提交未完成',exact=False).wait_for()
    phone.get_by_role('button',name='上次提交未完成',exact=False).click()
    assert phone.get_by_label('现场备注',exact=True).input_value()==stored[0]['note']
    assert phone.locator('.draft-photo').count()==1
    phone.unroute('**/api/v1/**')
    phone.get_by_role('button',name='重试提交核查',exact=True).click()
    phone.get_by_text('核查已保存，巡田任务已完成。',exact=True).wait_for()
    assert phone.locator('dialog').is_visible()==False
    phone.get_by_role('button',name='记录',exact=True).click()
    phone.get_by_text('用户报告 · 非确诊',exact=True).wait_for()
    assert phone.locator('.record-photos img').count()==1
    phone.screenshot(path=str(OUT/'field-completed.png'),full_page=True)
    phone.get_by_role('button',name='地块',exact=True).click()
    phone.get_by_role('button',name='＋ 记一笔农事',exact=True).click()
    phone.get_by_label('记录内容',exact=True).fill('模拟农事记录：测试排水登记。')
    phone.get_by_label('农事类型',exact=True).select_option('drainage')
    phone.get_by_role('button',name='保存农事记录',exact=True).click()
    phone.get_by_text('农事记录已保存。',exact=True).wait_for()
    phone.get_by_role('button',name='记录',exact=True).click()
    phone.get_by_text('模拟农事记录：测试排水登记。',exact=True).wait_for()
    assert phone.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not errors, errors
    assert not remote,remote
    print('PASS: empty state, invalid input, dialog cancel/Escape/reopen, fixture+analysis+visit, mobile offline IndexedDB draft/photo, reload recovery, manual retry completion, photo evidence, farm event, no horizontal overflow, no remote requests, no JS errors.')
    browser.close()
