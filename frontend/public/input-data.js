import {site} from './routes.js';
const panels = new Map();
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hex = value => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const number = value => Number(value).toLocaleString('en-US');
export const inputSize = value => hex(value) ? `${number((value.length-2)/2)} bytes · ${number((value.length-2)*4)} bits` : 'Unavailable';
export function formatInputText(raw, view, decoded) {
  if (view === 'utf8') {
    const bytes = Uint8Array.from(raw.slice(2).match(/../g) || [],byte=>parseInt(byte,16));
    let text;
    try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {throw new Error('These bytes are not valid UTF-8 text. Use Default view, Original hex or Decode input data.');}
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
  }
  if (view === 'default' && decoded?.status === 'decoded') return `Function: ${decoded.functionSignature}\nMethod ID: ${decoded.selector}\n\n${raw}`;
  return raw;
}
function parameterValue(param) {
  const value = String(param.value ?? '');
  if (param.type === 'address' && /^0x[0-9a-fA-F]{40}$/.test(value)) return `<a class="mono" href="${site.href({page:'explorer',kind:'address',id:value})}">${esc(value)}</a>`;
  if (value.length > 130) return `<details class="decoded-bytes"><summary>${hex(value) ? inputSize(value) : number(value.length)+' characters'} · show full value</summary><code>${esc(value)}</code></details>`;
  return `<code>${esc(value)}</code>${param.type === 'bytes' && value === '0x' ? ' <span class="subtle">(empty bytes)</span>' : ''}`;
}
// Keep each fully qualified parameter at the same left edge, including array/tuple fields.
function parameterList(parameters) {
  return `<dl class="decoded-parameters">${flatParameters(parameters).map((param,index)=>`<div class="decoded-parameter"><dt><span class="parameter-index">${index}</span><code class="parameter-name">${esc(param.name)}</code><code class="parameter-type">${esc(param.type)}</code></dt><dd>${parameterValue(param)}</dd></div>`).join('')}</dl>`;
}
function flatParameters(parameters,prefix='') {
  return parameters.flatMap(param=>{
    const name=prefix+(param.name.startsWith('[')?'':prefix?'.':'')+param.name;
    return param.children?.length?flatParameters(param.children,name):[{...param,name,...(param.children?{children:undefined,value:'[]'}:{})}];
  });
}
function decodedContent(decoded) {
  if (decoded?.status !== 'decoded') return `<p class="inline-notice" role="status">${esc(decoded?.message || 'No ABI is available to decode this input. The original bytes remain available.')}</p>`;
  let extra = '';
  if (decoded.trailingData && decoded.trailingData !== '0x') extra = `<div class="trailing-data"><strong>Additional trailing data <span class="subtle">${inputSize(decoded.trailingData)}</span></strong><p>Extra bytes outside the function’s ABI arguments. Their meaning depends on the account contract; the complete bytes are preserved here.</p><code>${esc(decoded.trailingData)}</code></div>`;
  if (decoded.message) extra += `<p class="inline-notice">${esc(decoded.message)}</p>`;
  return `<div class="decoded-function"><span class="field-label">FUNCTION</span><code>${esc(decoded.functionSignature)}</code><small>${esc(decoded.abiSource)}${decoded.abiSource?.includes('template') ? ' · contract source not verified by this view' : ''}</small></div>${parameterList(decoded.parameters)}${extra}`;
}
export function clearInputPanels() {panels.clear();}
export function renderInputPanel({id,title,value,description,error,selector=false,creation=false,decoded,embedded=false}) {
  const valid=hex(value),interactive=selector&&valid;
  const initialView=embedded&&decoded?.status==='decoded'?'decoded':interactive?'default':'original';
  panels.set(id,{raw:value,decoded,view:initialView,title});
  const method=selector&&valid&&value.length>=10&&!creation ? `<span>Method selector <code>${esc(value.slice(0,10))}</code></span>` : '';
  return `<section id="${id}Panel" class="panel input-panel${embedded?' embedded-input':''}" aria-labelledby="${id}Title"><div class="panel-heading"><h3 id="${id}Title">${esc(title)}</h3><span class="data-size">${inputSize(value)}</span></div><div class="input-panel-body"><p class="input-description">${esc(description)}</p>${valid ? `
    <div id="${id}Text"${initialView==='decoded'?' hidden':''}><label class="sr-only" for="${id}">${esc(title)} content</label><textarea id="${id}" class="hex-data" readonly spellcheck="false" rows="${value.length>1026?7:4}">${esc(formatInputText(value,interactive?'default':'original',decoded))}</textarea></div>
    <div id="${id}Decoded" class="decoded-input"${initialView==='decoded'?'':' hidden'}>${interactive?decodedContent(decoded):''}</div>
    <p id="${id}FormatNotice" class="inline-notice" role="status" hidden></p>
    <div class="input-toolbar"><div class="input-format-tools">${interactive ? `<label class="input-view-label" for="${id}View">View input as<select id="${id}View" data-input-view="${id}"${initialView==='decoded'?' disabled':''} aria-label="View ${esc(title)} as"><option value="default">Default view</option><option value="utf8">UTF-8</option><option value="original">Original hex</option></select></label><button class="button button-outline input-action" type="button" data-decode-input="${id}" aria-controls="${id}Decoded" aria-expanded="${initialView==='decoded'}">${initialView==='decoded'?'Switch back':'Decode input data'}</button><button class="button button-outline input-action" type="button" data-export-input="${id}">Export JSON</button>` : '<span class="subtle">Hex · complete data</span>'}</div><button class="button button-outline copy-data" type="button" data-copy-data="${id}">Copy hex</button></div>
    <div class="input-meta">${method}${value==='0x'?'<span class="subtle">No input bytes (0x)</span>':''}</div><p id="${id}Status" class="copy-status" role="status"></p>` : `<p class="inline-notice" role="status">${esc(error || 'These bytes are unavailable for this record.')}</p>`}</div></section>`;
}
const byId = id => document.getElementById(id);
function showView(id,view) {
  const panel=panels.get(id);if (!panel) return;
  panel.view=view;
  const decode=byId(id+'Panel').querySelector('[data-decode-input]');
  const decoded=view==='decoded';
  byId(id+'Text').hidden=decoded;byId(id+'Decoded').hidden=!decoded;byId(id+'FormatNotice').hidden=true;
  if (decode) {decode.textContent=decoded?'Switch back':'Decode input data';decode.setAttribute('aria-expanded',String(decoded));}
  const select=byId(id+'View');if (select) {select.disabled=decoded;if(!decoded)select.value=view;}
  if (!decoded) {
    try {byId(id).value=formatInputText(panel.raw,view,panel.decoded);}
    catch(error) {byId(id+'Text').hidden=true;byId(id+'FormatNotice').hidden=false;byId(id+'FormatNotice').textContent=error.message;}
  }
  byId(id+'Status').textContent='';
}
export function attachInputPanelEvents(container) {
  container.addEventListener('change',event=>{
    const select=event.target.closest('[data-input-view]');if(select)showView(select.dataset.inputView,select.value);
  });
  container.addEventListener('click',async event=>{
    const decode=event.target.closest('[data-decode-input]');
    if (decode) {const id=decode.dataset.decodeInput,panel=panels.get(id);if(panel)showView(id,panel.view==='decoded'?'default':'decoded');return;}
    const exportButton=event.target.closest('[data-export-input]');
    if (exportButton) {
      const id=exportButton.dataset.exportInput,panel=panels.get(id);if(!panel)return;
      const payload={title:panel.title,input:panel.raw,byteLength:(panel.raw.length-2)/2,bitLength:(panel.raw.length-2)*4,decoded:panel.decoded || null};
      const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
      const anchor=document.createElement('a');anchor.href=url;anchor.download=`daisugi-${id}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
    }
    const button=event.target.closest('[data-copy-data]');if(!button)return;
    const id=button.dataset.copyData,panel=panels.get(id);if(!panel)return;
    try {
      await navigator.clipboard.writeText(panel.raw);
      if(button.isConnected){byId(id+'Status').textContent='Complete original hex data copied.';button.textContent='Copied';}
    } catch {
      if(!button.isConnected)return;
      showView(id,'original');byId(id).focus();byId(id).select();
      byId(id+'Status').textContent='Clipboard access unavailable. The full original hex is selected; use Ctrl+C or your device’s Copy action.';
    }
  });
}
