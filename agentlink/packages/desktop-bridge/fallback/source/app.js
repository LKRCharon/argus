'use strict';
const $ = id => document.getElementById(id);
let token = '', enabled = false, state = null, streamOpen = false, streamAbort = null, queue = Promise.resolve(), toastTimer;
const keyCodes = {KeyA:0,KeyS:1,KeyD:2,KeyF:3,KeyH:4,KeyG:5,KeyZ:6,KeyX:7,KeyC:8,KeyV:9,KeyB:11,KeyQ:12,KeyW:13,KeyE:14,KeyR:15,KeyY:16,KeyT:17,Digit1:18,Digit2:19,Digit3:20,Digit4:21,Digit6:22,Digit5:23,Equal:24,Digit9:25,Digit7:26,Minus:27,Digit8:28,Digit0:29,BracketRight:30,KeyO:31,KeyU:32,BracketLeft:33,KeyI:34,KeyP:35,Enter:36,KeyL:37,KeyJ:38,Quote:39,KeyK:40,Semicolon:41,Backslash:42,Comma:43,Slash:44,KeyN:45,KeyM:46,Period:47,Tab:48,Space:49,Backquote:50,Backspace:51,Escape:53,Home:115,PageUp:116,Delete:117,End:119,PageDown:121,ArrowLeft:123,ArrowRight:124,ArrowDown:125,ArrowUp:126};
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
async function get(path){const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw Error('Mac 连接暂不可用');return r.json();}
async function post(path,data,retry=true){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Argus-Token':token},body:JSON.stringify(data)});if(r.status===403&&retry){token=(await get('/api/session')).token;return post(path,data,false);}const raw=await r.text();let body;try{body=JSON.parse(raw);}catch{throw Error('连接验证失败，请刷新网页后重试');}if(!r.ok||body.ok===false)throw Error(body.error||'操作未完成');return body;}
function action(path,data){queue=queue.then(()=>post(path,data)).catch(e=>toast(e.message));return queue;}
function input(data){if(!enabled)return;return action('/api/input',data);}
function modifiers(e){return {command:e.ctrlKey||e.metaKey,shift:e.shiftKey,alt:e.altKey};}
function point(e){const r=$('screen').getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
function setEnabled(value){enabled=value;$('keyboard').classList.toggle('active',enabled);$('keyboard').setAttribute('aria-pressed',String(enabled));$('keyboard').textContent=enabled?'键鼠已启用':'启用键鼠';$('stage').classList.toggle('controlling',enabled);$('insert').disabled=$('enter').disabled=!(enabled&&state?.screenRecording&&state?.accessibility&&state?.appRunning);if(enabled)$('stage').focus({preventScroll:true});}
async function listWindows(){const data=await get('/api/windows');const select=$('windows');const previous=select.value;select.replaceChildren();for(const item of data.windows||[]){const option=document.createElement('option');option.value=item.id;option.textContent=(item.title||'ChatGPT')+' · '+Math.round(item.width)+' × '+Math.round(item.height);select.append(option);}if(!select.options.length){const option=document.createElement('option');option.value='';option.textContent='等待 Mac 窗口';select.append(option);}else if([...select.options].some(x=>x.value===previous)){select.value=previous;}else if(state?.selectedWindowId){select.value=state.selectedWindowId;}}
function stopStream(){if(streamAbort)streamAbort.abort();streamAbort=null;streamOpen=false;}
async function showFrame(bytes,signal){
    const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('画面解码失败'));reader.readAsDataURL(new Blob([bytes],{type:'image/jpeg'}));});
    if(!signal.aborted)$('screen').src=url;
}
async function startStream(){
    if(streamOpen||document.hidden)return;
    streamOpen=true;
    const controller=new AbortController();streamAbort=controller;
    const signal=controller.signal;
    let reader;
    try{
        // ScreenCaptureKit emits frames when the window changes. Show its
        // latest still immediately, including when a new viewer joins a static window.
        const still=await fetch('/frame.jpg',{cache:'no-store',signal});
        if(still.ok)await showFrame(await still.arrayBuffer(),signal);
        const response=await fetch('/stream',{cache:'no-store',signal});
        if(!response.ok||!response.body)throw Error('等待 Mac 画面');
        reader=response.body.getReader();
        let buffer=new Uint8Array(0),length=null;
        const decoder=new TextDecoder();
        while(!signal.aborted){
            const part=await reader.read();if(part.done)break;
            const combined=new Uint8Array(buffer.length+part.value.length);combined.set(buffer);combined.set(part.value,buffer.length);buffer=combined;
            if(buffer.length>16*1024*1024)throw Error('画面数据超出限制');
            while(true){
                if(length===null){
                    let split=-1;
                    for(let i=0;i+3<buffer.length;i++){if(buffer[i]===13&&buffer[i+1]===10&&buffer[i+2]===13&&buffer[i+3]===10){split=i;break;}}
                    if(split<0)break;
                    const match=/Content-Length:\s*(\d+)/i.exec(decoder.decode(buffer.subarray(0,split)));
                    if(!match)throw Error('画面格式无效');
                    length=Number(match[1]);if(length<1||length>8*1024*1024)throw Error('画面大小无效');
                    buffer=buffer.slice(split+4);
                }
                if(buffer.length<length)break;
                const frame=buffer.slice(0,length);buffer=buffer.slice(length);length=null;
                await showFrame(frame,signal);
            }
        }
    }catch(error){if(!signal.aborted){$('empty-title').textContent='正在重新连接画面';$('empty-text').textContent=error.message;}}
    finally{if(reader)await reader.cancel().catch(()=>{});if(streamAbort===controller){streamAbort=null;streamOpen=false;}}
}
async function poll(){try{state=await get('/api/status');const ready=state.screenRecording&&state.appRunning;$('connection').textContent=ready?'已连接 Mac':state.screenRecording?'等待 App 窗口':'Mac 已连接 · 等待授权';$('dot').className=ready?'ready':'';$('permissions').hidden=state.screenRecording&&state.accessibility;$('screen-permission').disabled=state.screenRecording;$('accessibility-permission').disabled=state.accessibility;$('keyboard').disabled=!(ready&&state.accessibility);$('insert').disabled=!(ready&&state.accessibility&&enabled);$('enter').disabled=!(ready&&state.accessibility&&enabled);$('focus').disabled=!state.appRunning;if(!state.accessibility&&enabled)setEnabled(false);if(!state.screenRecording){$('empty-title').textContent='先在 Mac 允许屏幕录制';$('empty-text').textContent='组件已连接。请用下方按钮在 Mac 打开授权页面，允许 Argus App View 访问屏幕。';}else if(!state.appRunning){$('empty-title').textContent='等待 ChatGPT / Codex 窗口';$('empty-text').textContent='请在 Mac 打开原来的 App，你的现有会话会保留。';}else if(state.error){$('empty-title').textContent='等待 App 画面';$('empty-text').textContent=state.error;}if(ready&&!streamOpen&&!document.hidden){void startStream();await listWindows();}if(ready&&state.frameCount){$('details').textContent='SSH 加密连接 · myten · '+state.frameWidth+' × '+state.frameHeight+' · 仅 App 窗口';}if(!ready&&streamOpen){stopStream();$('screen').removeAttribute('src');$('screen').hidden=true;$('empty').hidden=false;}}catch(e){$('connection').textContent='Mac 连接已断开';$('dot').className='offline';if(enabled)setEnabled(false);$('empty-title').textContent='暂时无法连接 Mac';$('empty-text').textContent='连接正在自动重试；也可重新运行“打开 Mac 窗口”。';}setTimeout(poll,1800);}
$('screen').addEventListener('load',()=>{$('screen').hidden=false;$('empty').hidden=true;});
$('screen').addEventListener('error',()=>{stopStream();$('screen').hidden=true;$('empty').hidden=false;});
$('keyboard').onclick=()=>setEnabled(!enabled);
$('focus').onclick=()=>action('/api/focus',{});
$('refresh').onclick=()=>listWindows().catch(e=>toast(e.message));
$('windows').onchange=()=>action('/api/select',{windowId:Number($('windows').value)});
$('fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen();else $('stage').requestFullscreen().catch(e=>toast(e.message));};
$('screen-permission').onclick=()=>action('/api/permission',{kind:'screen'});
$('accessibility-permission').onclick=()=>action('/api/permission',{kind:'accessibility'});
$('insert').onclick=()=>{if(!enabled)return;const text=$('text').value;if(text)input({kind:'text',text});};
$('enter').onclick=()=>input({kind:'key',keyCode:36});
let dragging=false,lastDrag=0;
$('screen').addEventListener('pointerdown',e=>{if(!enabled)return;e.preventDefault();$('stage').focus({preventScroll:true});$('screen').setPointerCapture(e.pointerId);dragging=true;input({kind:'mouse',phase:'down',button:e.button,clickCount:e.detail||1,...point(e),...modifiers(e)});});
$('screen').addEventListener('pointerup',e=>{if(!dragging)return;e.preventDefault();dragging=false;input({kind:'mouse',phase:'up',button:e.button,...point(e),...modifiers(e)});});
$('screen').addEventListener('pointercancel',e=>{if(dragging){dragging=false;input({kind:'mouse',phase:'up',button:0,...point(e)});}});
$('screen').addEventListener('pointermove',e=>{if(dragging&&performance.now()-lastDrag>70){lastDrag=performance.now();input({kind:'mouse',phase:'drag',button:e.buttons===2?2:0,...point(e),...modifiers(e)});}});
$('screen').addEventListener('contextmenu',e=>{if(enabled)e.preventDefault();});
$('screen').addEventListener('wheel',e=>{if(!enabled)return;e.preventDefault();input({kind:'scroll',dx:e.deltaX,dy:e.deltaY,...point(e),...modifiers(e)});},{passive:false});
$('stage').addEventListener('keydown',e=>{if(!enabled||e.isComposing)return;if(['Shift','Control','Alt','Meta'].includes(e.key))return;if((e.ctrlKey||e.metaKey||e.altKey)&&keyCodes[e.code]!==undefined){e.preventDefault();input({kind:'key',keyCode:keyCodes[e.code],...modifiers(e)});}else if(e.key.length===1){e.preventDefault();input({kind:'text',text:e.key});}else if(keyCodes[e.code]!==undefined){e.preventDefault();input({kind:'key',keyCode:keyCodes[e.code],...modifiers(e)});}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){setEnabled(false);stopStream();}});
(async()=>{try{token=(await get('/api/session')).token;await poll();}catch(e){toast(e.message);setTimeout(()=>location.reload(),2500);}})();
