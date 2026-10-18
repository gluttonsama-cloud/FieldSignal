import { esc } from './display.ts';
import type { Verification } from './types';

const photoPath = (id: string) => `/api/v1/photos/${encodeURIComponent(id)}`;

function readStatus() {
  return '<span class="photo-read-status" data-photo-status role="status">等待读取照片</span><button type="button" class="text-button" data-action="retry-record-photo" hidden>重试读取</button>';
}

export function recordPhotoStrip(record: Verification) {
  return `<div class="record-photos">${record.photo_ids.map((id,index)=>`<figure class="record-photo" data-record-photo><button type="button" class="record-photo-open" data-action="view-record-photo" data-record="${esc(record.id)}" data-photo="${esc(id)}" aria-label="查看第 ${index+1} / ${record.photo_ids.length} 张核查照片"><img data-record-image src="${photoPath(id)}" alt="第 ${index+1} 张现场照片" loading="lazy"><span>查看第 ${index+1} 张</span></button><figcaption>${readStatus()}</figcaption></figure>`).join('')}</div>`;
}

export function recordPhotoViewer(record: Verification, photoId: string) {
  const index=record.photo_ids.indexOf(photoId);
  return `<figure class="record-photo-viewer" data-record-photo><div class="photo-viewer-surface" tabindex="0" role="region" aria-label="核查照片，可滚动查看原尺寸"><img data-record-image src="${photoPath(photoId)}" alt="第 ${index+1} / ${record.photo_ids.length} 张现场照片"></div><figcaption>${readStatus()}<button type="button" class="button secondary" data-action="zoom-record-photo" aria-pressed="false" disabled>原尺寸查看</button><a class="text-link" href="${photoPath(photoId)}" target="_blank" rel="noopener">在新标签页打开照片 ↗</a></figcaption></figure>`;
}

function photoFigure(element: HTMLElement, root: HTMLElement) {
  const figure=element.closest<HTMLElement>('[data-record-photo]');
  return figure&&root.contains(figure)?figure:undefined;
}

function setReadState(figure: HTMLElement, image: HTMLImageElement, state: 'loading'|'ready'|'error') {
  figure.dataset.photoState=state;
  image.hidden=state==='error';
  const status=figure.querySelector<HTMLElement>('[data-photo-status]');
  if(status)status.textContent=state==='ready'?'照片已读取':state==='loading'?'正在读取照片…':'照片读取失败，原因尚未确认。请检查本地服务后手动重试。';
  const retry=figure.querySelector<HTMLButtonElement>('[data-action="retry-record-photo"]');
  if(retry){retry.hidden=state!=='error';retry.disabled=state==='loading';}
  const zoom=figure.querySelector<HTMLButtonElement>('[data-action="zoom-record-photo"]');
  if(zoom){zoom.disabled=state!=='ready';if(state!=='ready'){figure.classList.remove('zoomed');zoom.setAttribute('aria-pressed','false');zoom.textContent='原尺寸查看';}}
}

export function bindRecordPhotoEvents(root: HTMLElement) {
  for(const type of ['load','error'])root.addEventListener(type,event=>{
    const image=event.target as HTMLImageElement|null;
    if(image?.tagName!=='IMG'||!image.hasAttribute('data-record-image')||!root.contains(image))return;
    const figure=photoFigure(image,root);
    if(figure&&figure.querySelector('[data-record-image]')===image)setReadState(figure,image,type==='load'?'ready':'error');
  },true); // Image load/error do not bubble; observe them in capture phase.
}

export function retryRecordPhoto(button: HTMLElement, root: HTMLElement) {
  const figure=photoFigure(button,root),image=figure?.querySelector<HTMLImageElement>('[data-record-image]');
  if(!figure||!image||figure.dataset.photoState!=='error')return;
  // A new element isolates late events from the failed request. Retry only on
  // this explicit action; keep the same same-origin resource and record identity.
  const replacement=image.cloneNode(false) as HTMLImageElement;
  replacement.loading='eager';
  setReadState(figure,replacement,'loading');
  image.replaceWith(replacement);
}

export function zoomRecordPhoto(button: HTMLElement, root: HTMLElement) {
  const figure=photoFigure(button,root);
  if(!figure||figure.dataset.photoState!=='ready')return;
  const zoomed=figure.classList.toggle('zoomed');
  button.setAttribute('aria-pressed',String(zoomed));
  button.textContent=zoomed?'适应窗口':'原尺寸查看';
}
