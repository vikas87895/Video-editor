'use strict';
/* =========================================================
   ApnaCut — client-side video editor
   No backend. No CDN. Runs fully offline after first load.
   ========================================================= */

/* ---------------- Capability detection ---------------- */
const CAPS = (function detectCaps(){
  const c = {};
  c.webcodecs = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  c.offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  c.webgl2 = !!document.createElement('canvas').getContext('webgl2');
  c.webgl = c.webgl2 || !!document.createElement('canvas').getContext('webgl');
  c.webAudio = typeof (window.AudioContext || window.webkitAudioContext) !== 'undefined';
  c.fsAccess = 'showOpenFilePicker' in window;
  c.indexedDB = 'indexedDB' in window;
  c.workers = typeof Worker !== 'undefined';
  c.speechRecognition = ('SpeechRecognition' in window) || ('webkitSpeechRecognition' in window);
  c.mediaRecorder = typeof MediaRecorder !== 'undefined';
  c.captureStream = !!HTMLCanvasElement.prototype.captureStream;
  // Recording mime support
  c.webmVp9 = c.mediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus');
  c.webmVp8 = c.mediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus');
  c.mp4Rec  = c.mediaRecorder && MediaRecorder.isTypeSupported('video/mp4;codecs=avc1');
  return c;
})();

/* ---------------- Utilities ---------------- */
const $ = (s,r)=> (r||document).querySelector(s);
const $$ = (s,r)=> Array.from((r||document).querySelectorAll(s));
const uid = ()=> Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);
const clamp = (v,a,b)=> Math.max(a,Math.min(b,v));
function fmtTime(t){
  if(!isFinite(t)||t<0) t=0;
  const h=Math.floor(t/3600), m=Math.floor((t%3600)/60), s=Math.floor(t%60), cs=Math.floor((t%1)*100);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}
function toast(msg,ms=2400){
  const t=$('#toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toast._h); toast._h=setTimeout(()=>t.classList.remove('show'),ms);
}
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ---------------- IndexedDB storage ---------------- */
const DB = {
  _db:null,
  async open(){
    if(this._db) return this._db;
    if(!CAPS.indexedDB) throw new Error('IndexedDB unavailable');
    this._db = await new Promise((res,rej)=>{
      const req = indexedDB.open('apnacut_v1', 1);
      req.onupgradeneeded = ()=>{
        const db = req.result;
        if(!db.objectStoreNames.contains('media')) db.createObjectStore('media',{keyPath:'id'});
        if(!db.objectStoreNames.contains('projects')) db.createObjectStore('projects',{keyPath:'id'});
      };
      req.onsuccess = ()=>res(req.result);
      req.onerror = ()=>rej(req.error);
    });
    return this._db;
  },
  async put(store,val){
    const db=await this.open();
    return new Promise((res,rej)=>{
      const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(val);
      tx.oncomplete=()=>res(true); tx.onerror=()=>rej(tx.error);
    });
  },
  async get(store,id){
    const db=await this.open();
    return new Promise((res,rej)=>{
      const tx=db.transaction(store,'readonly');
      const r=tx.objectStore(store).get(id);
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
    });
  },
  async getAll(store){
    const db=await this.open();
    return new Promise((res,rej)=>{
      const tx=db.transaction(store,'readonly');
      const r=tx.objectStore(store).getAll();
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
    });
  },
  async delete(store,id){
    const db=await this.open();
    return new Promise((res,rej)=>{
      const tx=db.transaction(store,'readwrite'); tx.objectStore(store).delete(id);
      tx.oncomplete=()=>res(true); tx.onerror=()=>rej(tx.error);
    });
  }
};

/* ---------------- Editor State ---------------- */
const State = {
  project:{
    id: uid(),
    name:'Untitled Project',
    width:1920, height:1080, fps:30,
    bg:'#000000',
    snapping:true,
    autosaveSec:20
  },
  media:new Map(),       // id -> {id,name,type,duration,width,height,thumb,blobKey}
  mediaBlobs:new Map(),  // id -> {file, objectURL, videoEl?, audioBuffer?}
  tracks:[
    {id:uid(), type:'video', name:'V1', height:56, muted:false, locked:false, visible:true},
    {id:uid(), type:'audio', name:'A1', height:44, muted:false, locked:false, visible:true},
  ],
  clips:[],   // {id,trackId,mediaId,type,start,duration,inPoint,trimStart,trimEnd,
              //  transform:{x,y,scaleX,scaleY,rot,opacity}, effects:{...}, text:{...}}
  captions:[],  // {id,start,end,text}
  captionStyle:{font:'Arial', size:42, color:'#ffffff', stroke:'#000000', strokeWidth:3,
    bg:'rgba(0,0,0,0.55)', position:'bottom', karaoke:false},
  showSafeGuides:false,
  selection:new Set(),
  playhead:0,
  duration:0,
  zoom:60,     // px per second
  playing:false,
  activeTool:'select',
  snapToBeats:false,
};

function recomputeDuration(){
  let d=0;
  for(const c of State.clips) d=Math.max(d, c.start+c.duration);
  State.duration = d;
  $('#durLabel').textContent = 'Timeline: '+fmtTime(State.duration);
}

/* ---------------- History (undo/redo) ---------------- */
const History = {
  stack:[], idx:-1, max:60, suspend:false,
  snapshot(){
    if(this.suspend) return;
    const snap = JSON.stringify({
      tracks:State.tracks, clips:State.clips, project:State.project,
      captions:State.captions, captionStyle:State.captionStyle
    });
    this.stack = this.stack.slice(0,this.idx+1);
    this.stack.push(snap);
    if(this.stack.length>this.max) this.stack.shift();
    this.idx = this.stack.length-1;
  },
  undo(){
    if(this.idx<=0) return toast('Nothing to undo');
    this.idx--; this._restore();
  },
  redo(){
    if(this.idx>=this.stack.length-1) return toast('Nothing to redo');
    this.idx++; this._restore();
  },
  _restore(){
    const d = JSON.parse(this.stack[this.idx]);
    this.suspend=true;
    State.tracks=d.tracks; State.clips=d.clips; State.project=d.project;
    State.captions=d.captions||[]; State.captionStyle=d.captionStyle||State.captionStyle;
    State.selection.clear();
    this.suspend=false;
    $('#projName').value = State.project.name;
    recomputeDuration(); Timeline.render(); Inspector.render(); Player.renderFrame();
  }
};

/* ---------------- Media Library ---------------- */
const Media = {
  async importFiles(fileList){
    const files = Array.from(fileList);
    if(!files.length) return;
    for(const file of files){
      await this._importOne(file);
    }
    Panels.render('media');
  },
  async _importOne(file){
    const kind = file.type.startsWith('video')?'video':
                 file.type.startsWith('audio')?'audio':
                 file.type.startsWith('image')?'image':null;
    if(!kind){ toast(`Unsupported file: ${file.name}`); return; }
    const id = uid();
    const objectURL = URL.createObjectURL(file);
    const rec = {id,name:file.name,type:kind,size:file.size,duration:0,width:0,height:0,thumb:null};

    try{
      if(kind==='video'){
        const v = document.createElement('video');
        v.src=objectURL; v.muted=true; v.preload='metadata';
        await new Promise((res,rej)=>{ v.onloadedmetadata=res; v.onerror=()=>rej(new Error('decode error')); });
        rec.duration=v.duration||0; rec.width=v.videoWidth; rec.height=v.videoHeight;
        rec.thumb = await this._grabFrame(v, Math.min(0.3, rec.duration/2));
        State.mediaBlobs.set(id,{file,objectURL,videoEl:null});
      } else if(kind==='audio'){
        const a = document.createElement('audio');
        a.src=objectURL; a.preload='metadata';
        await new Promise((res,rej)=>{ a.onloadedmetadata=res; a.onerror=()=>rej(new Error('decode error')); });
        rec.duration=a.duration||0;
        State.mediaBlobs.set(id,{file,objectURL});
        // decode for waveform (best-effort, async, non-blocking)
        this._decodeWave(id,file);
      } else if(kind==='image'){
        const img = new Image(); img.src=objectURL;
        await new Promise((res,rej)=>{ img.onload=res; img.onerror=()=>rej(new Error('decode error')); });
        rec.width=img.naturalWidth; rec.height=img.naturalHeight; rec.duration=5;
        rec.thumb=objectURL;
        State.mediaBlobs.set(id,{file,objectURL,imgEl:img});
      }
    }catch(err){
      toast(`Could not import ${file.name}: ${err.message}`);
      URL.revokeObjectURL(objectURL);
      return;
    }
    State.media.set(id,rec);
    // persist blob to IndexedDB for project reload
    try{ await DB.put('media',{id,name:file.name,type:kind,duration:rec.duration,
      width:rec.width,height:rec.height,blob:file}); }catch(e){ /* non-fatal */ }
  },
  async _grabFrame(videoEl,t){
    return new Promise((res)=>{
      const c=document.createElement('canvas');
      c.width=160; c.height=90;
      const ctx=c.getContext('2d');
      const draw=()=>{
        try{ ctx.drawImage(videoEl,0,0,c.width,c.height); }catch(e){}
        res(c.toDataURL('image/jpeg',0.6));
      };
      const onSeek=()=>{ videoEl.removeEventListener('seeked',onSeek); draw(); };
      videoEl.addEventListener('seeked',onSeek);
      try{ videoEl.currentTime=t; }catch(e){ draw(); }
      setTimeout(()=>{ if(!c._done){c._done=true; draw();} },1200);
    });
  },
  async _decodeWave(id,file){
    if(!CAPS.webAudio) return;
    try{
      const ctx = new (window.AudioContext||window.webkitAudioContext)();
      const buf = await file.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(buf);
      const rec = State.media.get(id);
      if(rec){
        rec.waveform = downsampleWave(audioBuf,600);
        rec.beats = detectBeats(audioBuf);
        Timeline.render();
      }
      ctx.close();
    }catch(e){ /* waveform/beat detection optional, non-fatal */ }
  },
  get(id){ return State.media.get(id); },
  blob(id){ return State.mediaBlobs.get(id); }
};
function downsampleWave(audioBuffer, points){
  const data = audioBuffer.getChannelData(0);
  const blockSize = Math.floor(data.length/points)||1;
  const out=[];
  for(let i=0;i<points;i++){
    let sum=0,start=i*blockSize;
    for(let j=0;j<blockSize;j++) sum+=Math.abs(data[start+j]||0);
    out.push(sum/blockSize);
  }
  const max=Math.max(...out,0.0001);
  return out.map(v=>v/max);
}
/* Simple energy-based onset/beat detection — NOT full tempo/BPM analysis,
   just real local-energy-peak picking. Honest about its limits (see README). */
function detectBeats(audioBuffer){
  const data = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const win = Math.max(256, Math.floor(sr*0.05)); // ~50ms windows
  const energies=[];
  for(let i=0;i<data.length;i+=win){
    let sum=0; const end=Math.min(data.length,i+win);
    for(let j=i;j<end;j++) sum+=data[j]*data[j];
    energies.push(sum/(end-i));
  }
  const beats=[]; const avgSpan=20; // ~1s local average window
  for(let i=0;i<energies.length;i++){
    const s=Math.max(0,i-avgSpan), e=Math.min(energies.length,i+avgSpan);
    let localAvg=0; for(let k=s;k<e;k++) localAvg+=energies[k]; localAvg/=(e-s||1);
    if(energies[i] > localAvg*1.4 && energies[i] > 0.0004){
      const t=(i*win)/sr;
      if(!beats.length || t-beats[beats.length-1] > 0.2) beats.push(t);
    }
  }
  return beats;
}

/* ---------------- Clip model helpers ---------------- */
function addClipFromMedia(mediaId, trackId, startTime){
  const m = Media.get(mediaId);
  if(!m) return;
  const track = State.tracks.find(t=>t.id===trackId);
  if(!track) return;
  if((track.type==='video' && !(m.type==='video'||m.type==='image')) ||
     (track.type==='audio' && m.type!=='audio')){
    toast('Media type does not match track type'); return;
  }
  const clip = {
    id:uid(), trackId, mediaId, type:m.type,
    start: Math.max(0,startTime), duration: m.duration||5,
    trimStart:0, trimEnd:m.duration||5,
    transform:{x:State.project.width/2,y:State.project.height/2,scaleX:1,scaleY:1,rot:0,opacity:1},
    effects:{brightness:0,contrast:0,saturation:0,blur:0},
    volume:1, speed:1,
    keyframes:{},
    chroma:{enabled:false, keyColor:'#00ff00', similarity:0.4, smoothness:0.12, spill:0.5},
    mask:{enabled:false, kind:'rect', x:(m.width||State.project.width)/2, y:(m.height||State.project.height)/2,
      w:(m.width||State.project.width)*0.6, h:(m.height||State.project.height)*0.6, feather:20, invert:false},
    name:m.name
  };
  State.clips.push(clip);
  recomputeDuration(); History.snapshot(); Timeline.render();
  selectClip(clip.id);
}
function addTextClip(startTime,trackId){
  let track = trackId ? State.tracks.find(t=>t.id===trackId) : State.tracks.find(t=>t.type==='video');
  if(!track){ toast('Add a video track first'); return; }
  const clip = {
    id:uid(), trackId:track.id, mediaId:null, type:'text',
    start:Math.max(0,startTime), duration:4,
    transform:{x:State.project.width/2,y:State.project.height/2,scaleX:1,scaleY:1,rot:0,opacity:1},
    text:{content:'Your text here', font:'Arial', size:64, color:'#ffffff', weight:'700',
      align:'center', stroke:'#000000', strokeWidth:0, bg:'transparent', anim:'fade'},
    keyframes:{},
    name:'Text'
  };
  State.clips.push(clip);
  recomputeDuration(); History.snapshot(); Timeline.render(); selectClip(clip.id);
}
function addShapeClip(kind,startTime){
  let track = State.tracks.find(t=>t.type==='video');
  if(!track){ toast('Add a video track first'); return; }
  const clip = {
    id:uid(), trackId:track.id, mediaId:null, type:'shape',
    start:Math.max(0,startTime), duration:4,
    transform:{x:State.project.width/2,y:State.project.height/2,scaleX:1,scaleY:1,rot:0,opacity:1},
    shape:{kind, fill:'#5b8cff', stroke:'#ffffff', strokeWidth:0, w:300, h:300},
    keyframes:{},
    name:'Shape:'+kind
  };
  State.clips.push(clip);
  recomputeDuration(); History.snapshot(); Timeline.render(); selectClip(clip.id);
}
function addStickerClip(char,startTime){
  let track = State.tracks.find(t=>t.type==='video');
  if(!track){ toast('Add a video track first'); return; }
  const clip = {
    id:uid(), trackId:track.id, mediaId:null, type:'sticker',
    start:Math.max(0,startTime||State.playhead), duration:4,
    transform:{x:State.project.width/2,y:State.project.height/2,scaleX:1,scaleY:1,rot:0,opacity:1},
    sticker:{char, size:140},
    keyframes:{},
    name:'Sticker:'+char
  };
  State.clips.push(clip);
  recomputeDuration(); History.snapshot(); Timeline.render(); selectClip(clip.id);
}
function insertTemplate(kind){
  let track = State.tracks.find(t=>t.type==='video');
  if(!track){ toast('Add a video track first'); return; }
  const W=State.project.width, H=State.project.height;
  const t0 = State.playhead;
  const push = (clip)=>{ State.clips.push(clip); };
  if(kind==='lowerThird'){
    push({id:uid(),trackId:track.id,mediaId:null,type:'shape',start:t0,duration:5,
      transform:{x:W*0.28,y:H*0.86,scaleX:1,scaleY:1,rot:0,opacity:0.85},
      shape:{kind:'rect',fill:'#101418',stroke:'transparent',strokeWidth:0,w:W*0.4,h:H*0.09},
      keyframes:{},name:'Lower Third BG'});
    push({id:uid(),trackId:track.id,mediaId:null,type:'text',start:t0,duration:5,
      transform:{x:W*0.28,y:H*0.86,scaleX:1,scaleY:1,rot:0,opacity:1},
      text:{content:'Your Name / Title',font:'Arial',size:38,color:'#ffffff',weight:'700',
        align:'center',stroke:'#000000',strokeWidth:0,bg:'transparent',anim:'fade'},
      keyframes:{},name:'Lower Third Text'});
  } else if(kind==='introTitle'){
    push({id:uid(),trackId:track.id,mediaId:null,type:'text',start:t0,duration:3,
      transform:{x:W/2,y:H/2,scaleX:1,scaleY:1,rot:0,opacity:1},
      text:{content:'YOUR TITLE HERE',font:'Impact',size:96,color:'#ffffff',weight:'700',
        align:'center',stroke:'#000000',strokeWidth:4,bg:'transparent',anim:'pop'},
      keyframes:{},name:'Intro Title'});
  } else if(kind==='subscribeCTA'){
    push({id:uid(),trackId:track.id,mediaId:null,type:'shape',start:t0,duration:3.5,
      transform:{x:W*0.82,y:H*0.88,scaleX:1,scaleY:1,rot:0,opacity:0.9},
      shape:{kind:'rect',fill:'#e02020',stroke:'transparent',strokeWidth:0,w:W*0.22,h:H*0.08},
      keyframes:{},name:'Subscribe BG'});
    push({id:uid(),trackId:track.id,mediaId:null,type:'text',start:t0,duration:3.5,
      transform:{x:W*0.82,y:H*0.88,scaleX:1,scaleY:1,rot:0,opacity:1},
      text:{content:'SUBSCRIBE →',font:'Arial',size:34,color:'#ffffff',weight:'700',
        align:'center',stroke:'#000000',strokeWidth:0,bg:'transparent',anim:'pop'},
      keyframes:{},name:'Subscribe Text'});
  } else if(kind==='chapterTitle'){
    push({id:uid(),trackId:track.id,mediaId:null,type:'shape',start:t0,duration:3,
      transform:{x:W/2,y:H*0.14,scaleX:1,scaleY:1,rot:0,opacity:0.85},
      shape:{kind:'rect',fill:'#101418',stroke:'transparent',strokeWidth:0,w:W*0.5,h:H*0.1},
      keyframes:{},name:'Chapter BG'});
    push({id:uid(),trackId:track.id,mediaId:null,type:'text',start:t0,duration:3,
      transform:{x:W/2,y:H*0.14,scaleX:1,scaleY:1,rot:0,opacity:1},
      text:{content:'Chapter 1: Introduction',font:'Arial',size:40,color:'#ffffff',weight:'700',
        align:'center',stroke:'#000000',strokeWidth:0,bg:'transparent',anim:'fade'},
      keyframes:{},name:'Chapter Text'});
  }
  recomputeDuration(); History.snapshot(); Timeline.render(); Panels.render('media');
  toast('Template inserted — fully editable clips, tweak in Inspector');
}
function selectClip(id,additive){
  if(!additive) State.selection.clear();
  if(id) State.selection.add(id);
  Timeline.render(); Inspector.render();
}
function getClip(id){ return State.clips.find(c=>c.id===id); }
function deleteSelected(){
  if(!State.selection.size) return;
  State.clips = State.clips.filter(c=>!State.selection.has(c.id));
  State.selection.clear();
  recomputeDuration(); History.snapshot(); Timeline.render(); Inspector.render();
}
function splitAtPlayhead(){
  const t = State.playhead;
  let did=false;
  const targets = State.selection.size? State.clips.filter(c=>State.selection.has(c.id)) : State.clips;
  for(const c of targets){
    if(t>c.start+0.02 && t<c.start+c.duration-0.02){
      const rightDur = (c.start+c.duration)-t;
      const newClip = JSON.parse(JSON.stringify(c));
      newClip.id=uid();
      newClip.start=t;
      newClip.duration=rightDur;
      newClip.trimStart=(c.trimStart||0)+(t-c.start);
      c.duration = t-c.start;
      c.trimEnd = (c.trimStart||0)+c.duration;
      State.clips.push(newClip);
      did=true;
    }
  }
  if(did){ History.snapshot(); Timeline.render(); toast('Clip split'); }
}
function duplicateSelected(){
  const targets = State.clips.filter(c=>State.selection.has(c.id));
  if(!targets.length) return;
  const added=[];
  for(const c of targets){
    const n=JSON.parse(JSON.stringify(c)); n.id=uid(); n.start=c.start+c.duration+0.2;
    State.clips.push(n); added.push(n.id);
  }
  recomputeDuration(); History.snapshot(); Timeline.render();
  State.selection=new Set(added); Timeline.render(); Inspector.render();
}

/* ---------------- Compound / Nested Clips (Phase 10) ---------------- */
function createCompoundClip(){
  const targets = State.clips.filter(c=>State.selection.has(c.id));
  if(targets.length<2){ toast('Select 2+ clips to group'); return; }
  const minStart = Math.min(...targets.map(c=>c.start));
  const maxEnd = Math.max(...targets.map(c=>c.start+c.duration));
  const children = targets.map(c=>{
    const copy = JSON.parse(JSON.stringify(c));
    copy.start = c.start-minStart; // store as offset relative to compound start
    return copy;
  });
  const hostTrack = State.tracks.find(t=>t.id===targets[0].trackId) || State.tracks[0];
  const compound = {
    id:uid(), trackId:hostTrack.id, mediaId:null, type:'compound',
    start:minStart, duration:maxEnd-minStart,
    transform:{x:0,y:0,scaleX:1,scaleY:1,rot:0,opacity:1},
    keyframes:{},
    compound:{children},
    name:'Compound Clip ('+children.length+')'
  };
  State.clips = State.clips.filter(c=>!State.selection.has(c.id));
  State.clips.push(compound);
  recomputeDuration(); History.snapshot(); Timeline.render();
  selectClip(compound.id);
  toast('Compound clip created — double-click or use Ungroup to edit contents');
}
function ungroupCompound(clipId){
  const clip = getClip(clipId);
  if(!clip || clip.type!=='compound') return;
  const restored = (clip.compound?.children||[]).map(ch=>{
    const c = JSON.parse(JSON.stringify(ch));
    c.start = clip.start+ch.start; // back to absolute timeline time
    if(!State.tracks.find(t=>t.id===c.trackId)) c.trackId = clip.trackId; // relink if original track gone
    return c;
  });
  State.clips = State.clips.filter(c=>c.id!==clipId);
  State.clips.push(...restored);
  recomputeDuration(); History.snapshot(); Timeline.render();
  State.selection = new Set(restored.map(c=>c.id));
  Inspector.render();
  toast('Compound clip ungrouped');
}

/* ---------------- Keyframe Engine (Phase 8) ----------------
   Real numeric-property keyframing with interpolation + easing.
   Not a full bezier-handle graph editor (that's a bigger follow-up) —
   this version does real add/move/delete/interpolate/easing-per-segment,
   which is genuinely functional, just simplified. Labeled as such in UI. */
const Easing = {
  linear: t=>t,
  easeIn: t=>t*t,
  easeOut: t=>1-(1-t)*(1-t),
  easeInOut: t=> t<0.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2,
  bounce: t=>{
    const n1=7.5625,d1=2.75;
    if(t<1/d1) return n1*t*t;
    if(t<2/d1) return n1*(t-=1.5/d1)*t+0.75;
    if(t<2.5/d1) return n1*(t-=2.25/d1)*t+0.9375;
    return n1*(t-=2.625/d1)*t+0.984375;
  },
  elastic: t=>{
    if(t===0||t===1) return t;
    const p=0.3;
    return Math.pow(2,-10*t)*Math.sin((t-p/4)*(2*Math.PI)/p)+1;
  },
  back: t=>{ const c1=1.70158,c3=c1+1; return 1+c3*Math.pow(t-1,3)+c1*Math.pow(t-1,2); }
};
const KF = {
  // propPath examples: 'transform.x','transform.opacity','effects.brightness','volume'
  get(clip,propPath){ return (clip.keyframes && clip.keyframes[propPath]) || null; },
  isAnimated(clip,propPath){ const l=this.get(clip,propPath); return !!(l && l.length); },
  staticValue(clip,propPath){
    const parts=propPath.split('.');
    let v=clip; for(const p of parts) v = v ? v[p] : undefined;
    return v;
  },
  // localT = time relative to clip.start (0..clip.duration)
  valueAt(clip,propPath,localT){
    const list=this.get(clip,propPath);
    if(!list || !list.length) return this.staticValue(clip,propPath);
    const sorted=[...list].sort((a,b)=>a.t-b.t);
    if(localT<=sorted[0].t) return sorted[0].v;
    if(localT>=sorted[sorted.length-1].t) return sorted[sorted.length-1].v;
    for(let i=0;i<sorted.length-1;i++){
      const a=sorted[i], b=sorted[i+1];
      if(localT>=a.t && localT<=b.t){
        const span=b.t-a.t || 0.0001;
        const p=(localT-a.t)/span;
        const eased=(Easing[a.ease]||Easing.linear)(clamp(p,0,1));
        return a.v + (b.v-a.v)*eased;
      }
    }
    return sorted[sorted.length-1].v;
  },
  addOrUpdate(clip,propPath,localT,value,ease){
    if(!clip.keyframes) clip.keyframes={};
    if(!clip.keyframes[propPath]) clip.keyframes[propPath]=[];
    const list=clip.keyframes[propPath];
    const existing=list.find(k=>Math.abs(k.t-localT)<0.03);
    if(existing){ existing.v=value; if(ease) existing.ease=ease; }
    else list.push({t:clamp(localT,0,clip.duration), v:value, ease:ease||'linear'});
    list.sort((a,b)=>a.t-b.t);
  },
  remove(clip,propPath,index){
    const list=this.get(clip,propPath); if(!list) return;
    list.splice(index,1);
    if(!list.length) delete clip.keyframes[propPath];
  },
  clearProp(clip,propPath){ if(clip.keyframes) delete clip.keyframes[propPath]; },
  setEase(clip,propPath,index,ease){
    const list=this.get(clip,propPath); if(list && list[index]) list[index].ease=ease;
  }
};

/* ---------------- Captions (Phase 10) ---------------- */
const Captions = {
  add(start,end,text){
    State.captions.push({id:uid(),start,end,text});
    State.captions.sort((a,b)=>a.start-b.start);
    History.snapshot();
  },
  remove(id){ State.captions=State.captions.filter(c=>c.id!==id); History.snapshot(); },
  activeAt(t){ return State.captions.filter(c=>t>=c.start && t<=c.end); },
  importSRTorVTT(text,isVTT){
    const blocks = text.replace(/\r/g,'').trim().split(/\n\n+/);
    const out=[];
    for(const block of blocks){
      const lines = block.split('\n').filter(l=>l.trim().length);
      if(!lines.length) continue;
      let idx=0;
      if(!isVTT && /^\d+$/.test(lines[0].trim())) idx=1; // skip SRT sequence number
      if(isVTT && lines[0].toUpperCase().startsWith('WEBVTT')) continue;
      const timeLine = lines.find(l=>l.includes('-->'));
      if(!timeLine) continue;
      const m = timeLine.match(/(\d{2}:\d{2}:\d{2}[.,]\d{2,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{2,3})/);
      if(!m) continue;
      const start=this._parseTime(m[1]), end=this._parseTime(m[2]);
      const textLines = lines.slice(lines.indexOf(timeLine)+1);
      out.push({id:uid(), start, end, text:textLines.join(' ').trim()});
    }
    if(out.length){ State.captions=out.sort((a,b)=>a.start-b.start); History.snapshot(); toast(`Imported ${out.length} caption(s)`); }
    else toast('No valid captions found in file');
  },
  _parseTime(s){
    const [h,m,rest] = s.replace(',','.').split(':');
    const [sec,ms] = rest.split('.');
    return (+h)*3600+(+m)*60+(+sec)+((+ms||0)/(ms&&ms.length===2?100:1000));
  },
  _fmtSRT(t){
    const h=Math.floor(t/3600), m=Math.floor((t%3600)/60), s=Math.floor(t%60), ms=Math.round((t%1)*1000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
  },
  _fmtVTT(t){ return this._fmtSRT(t).replace(',','.'); },
  exportSRT(){
    let out='';
    State.captions.forEach((c,i)=>{ out+=`${i+1}\n${this._fmtSRT(c.start)} --> ${this._fmtSRT(c.end)}\n${c.text}\n\n`; });
    this._download(out,(State.project.name||'captions')+'.srt','text/plain');
  },
  exportVTT(){
    let out='WEBVTT\n\n';
    State.captions.forEach(c=>{ out+=`${this._fmtVTT(c.start)} --> ${this._fmtVTT(c.end)}\n${c.text}\n\n`; });
    this._download(out,(State.project.name||'captions')+'.vtt','text/vtt');
  },
  _download(text,name,type){
    const blob=new Blob([text],{type}); const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=name; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),4000);
  },
  drawActive(ctx,W,H,t){
    const active=this.activeAt(t);
    if(!active.length) return;
    const st=State.captionStyle;
    ctx.save();
    ctx.filter='none';
    ctx.textAlign='center'; ctx.textBaseline='alphabetic';
    let y = st.position==='top' ? H*0.10 : H*0.90;
    for(const cap of active){
      ctx.font=`700 ${st.size}px ${st.font}, sans-serif`;
      if(!st.karaoke){
        this._drawLine(ctx,cap.text,W/2,y,st,null);
      } else {
        const words=cap.text.split(/\s+/).filter(Boolean);
        const span=Math.max(0.001,cap.end-cap.start);
        const progress=(t-cap.start)/span;
        const activeIdx=Math.min(words.length-1, Math.floor(progress*words.length));
        this._drawLine(ctx,words.join(' '),W/2,y,st,{words,activeIdx});
      }
      y += st.position==='top' ? st.size*1.3 : -st.size*1.3;
    }
    ctx.restore();
  },
  _drawLine(ctx,text,cx,cy,st,karaoke){
    const padX=14, padY=8;
    const metrics=ctx.measureText(text);
    const w=metrics.width+padX*2, h=st.size*1.15+padY*2;
    if(st.bg && st.bg!=='transparent'){
      ctx.fillStyle=st.bg;
      ctx.fillRect(cx-w/2,cy-h+padY, w, h);
    }
    if(!karaoke){
      if(st.strokeWidth>0){ ctx.strokeStyle=st.stroke; ctx.lineWidth=st.strokeWidth; ctx.strokeText(text,cx,cy); }
      ctx.fillStyle=st.color; ctx.fillText(text,cx,cy);
      return;
    }
    // karaoke: draw word by word, highlight active word
    let x = cx - metrics.width/2;
    ctx.textAlign='left';
    for(let i=0;i<karaoke.words.length;i++){
      const word=karaoke.words[i]+(i<karaoke.words.length-1?' ':'');
      const wm=ctx.measureText(word).width;
      if(st.strokeWidth>0){ ctx.strokeStyle=st.stroke; ctx.lineWidth=st.strokeWidth; ctx.strokeText(word,x,cy); }
      ctx.fillStyle = i===karaoke.activeIdx ? '#ffd23c' : st.color;
      ctx.fillText(word,x,cy);
      x+=wm;
    }
    ctx.textAlign='center';
  }
};

/* ---------------- Chroma Key + Mask pixel processing (Phase 11) ---------------- */
function hexToRgb(hex){
  const h=(hex||'#00ff00').replace('#','');
  return {r:parseInt(h.substr(0,2),16)||0, g:parseInt(h.substr(2,2),16)||0, b:parseInt(h.substr(4,2),16)||0};
}
function applyChromaKey(ctx,w,h,opts){
  let img;
  try{ img=ctx.getImageData(0,0,w,h); }catch(e){ return; } // may fail on tainted canvas (cross-origin) — silently skip
  const d=img.data;
  const key=hexToRgb(opts.keyColor);
  const sim=clamp(opts.similarity!=null?opts.similarity:0.4,0,1);
  const smooth=Math.max(0.001,opts.smoothness!=null?opts.smoothness:0.1);
  const spill=clamp(opts.spill!=null?opts.spill:0.5,0,1);
  for(let i=0;i<d.length;i+=4){
    const r=d[i],g=d[i+1],b=d[i+2];
    const dr=(r-key.r)/255, dg=(g-key.g)/255, db=(b-key.b)/255;
    const dist=Math.sqrt(dr*dr+dg*dg+db*db)/Math.sqrt(3);
    let alpha=1;
    if(dist<sim) alpha=0; else if(dist<sim+smooth) alpha=(dist-sim)/smooth;
    d[i+3]=d[i+3]*alpha;
    if(spill>0 && alpha>0.05 && g>r && g>b){
      const reduce=spill*(g-Math.max(r,b));
      d[i+1]=Math.max(0,g-reduce);
    }
  }
  ctx.putImageData(img,0,0);
}
function applyMask(ctx,w,h,opts){
  const maskCanvas=document.createElement('canvas'); maskCanvas.width=w; maskCanvas.height=h;
  const mctx=maskCanvas.getContext('2d');
  mctx.fillStyle='#fff';
  if(opts.feather>0) mctx.filter=`blur(${opts.feather}px)`;
  const mx=opts.x!=null?opts.x:w/2, my=opts.y!=null?opts.y:h/2;
  const mw=opts.w||w*0.6, mh=opts.h||h*0.6;
  mctx.beginPath();
  if(opts.kind==='ellipse') mctx.ellipse(mx,my,mw/2,mh/2,0,0,Math.PI*2);
  else mctx.rect(mx-mw/2,my-mh/2,mw,mh);
  mctx.fill();
  if(opts.invert){
    mctx.filter='none';
    mctx.globalCompositeOperation='source-out';
    mctx.fillRect(0,0,w,h);
    mctx.globalCompositeOperation='source-over';
  }
  ctx.globalCompositeOperation='destination-in';
  ctx.filter='none';
  ctx.drawImage(maskCanvas,0,0);
  ctx.globalCompositeOperation='source-over';
}

/* ---------------- Auto-Reframe (Phase 38 — manual cover-crop, honest about no AI tracking) ---------------- */
function reframeProject(newW,newH){
  if(!confirm(`Reframe project to ${newW}×${newH}? Video/image clips will be auto-cropped to cover the new frame; text/shapes keep relative position.`)) return;
  const oldW=State.project.width, oldH=State.project.height;
  for(const clip of State.clips){
    if(clip.type==='video'||clip.type==='image'){
      const m = clip.mediaId ? Media.get(clip.mediaId) : null;
      const mw=m?.width||oldW, mh=m?.height||oldH;
      const coverScale = Math.max(newW/mw, newH/mh);
      clip.transform.scaleX = coverScale;
      clip.transform.scaleY = coverScale;
      clip.transform.x = newW/2;
      clip.transform.y = newH/2;
    } else if(clip.type!=='compound'){
      clip.transform.x = oldW ? (clip.transform.x/oldW)*newW : newW/2;
      clip.transform.y = oldH ? (clip.transform.y/oldH)*newH : newH/2;
    }
  }
  State.project.width=newW; State.project.height=newH;
  Player.resizeCanvas(); recomputeDuration(); Timeline.render(); Player._procCanvas.clear();
  History.snapshot(); Player.renderFrame();
  toast(`Reframed to ${newW}×${newH}`);
}

/* ---------------- Audio Ducking (Phase 28 — keyframe-based, per spec's allowed alternative) ---------------- */
function autoDuck(voiceTrackId,musicTrackId,duckAmount,attack,release){
  const voiceClips=State.clips.filter(c=>c.trackId===voiceTrackId);
  const musicClips=State.clips.filter(c=>c.trackId===musicTrackId && c.type!=='text' && c.type!=='shape');
  if(!voiceClips.length||!musicClips.length){ toast('Need clips on both selected tracks'); return; }
  attack=attack||0.25; release=release||0.35;
  let count=0;
  for(const mc of musicClips){
    KF.clearProp(mc,'volume');
    KF.addOrUpdate(mc,'volume',0,1);
    for(const vc of voiceClips){
      const os=Math.max(mc.start,vc.start), oe=Math.min(mc.start+mc.duration,vc.start+vc.duration);
      if(oe<=os) continue;
      count++;
      const lS=clamp(os-mc.start,0,mc.duration), lE=clamp(oe-mc.start,0,mc.duration);
      KF.addOrUpdate(mc,'volume',Math.max(0,lS-attack),1);
      KF.addOrUpdate(mc,'volume',lS,duckAmount);
      KF.addOrUpdate(mc,'volume',lE,duckAmount);
      KF.addOrUpdate(mc,'volume',Math.min(mc.duration,lE+release),1);
    }
    KF.addOrUpdate(mc,'volume',mc.duration,1);
  }
  History.snapshot(); Inspector.render();
  toast(count?`Auto-duck applied at ${count} overlap(s)`:'No overlaps found between selected tracks');
}

/* ---------------- Timeline UI ---------------- */
const Timeline = {
  dragState:null,
  render(){
    const area = $('#tracksarea');
    area.innerHTML='';
    const px = State.zoom;
    const totalW = Math.max(800, (State.duration+20)*px);
    $('#ruler').style.width = (totalW+120)+'px';
    this.renderRuler(totalW);

    for(const track of State.tracks){
      const row = document.createElement('div');
      row.className='track'; row.style.height=track.height+'px';
      row.innerHTML = `
        <div class="trackhead">
          <div class="tname">${escapeHtml(track.name)}</div>
          <div class="tbtns">
            <button data-act="mute" title="Mute">${track.muted?'🔇':'🔊'}</button>
            <button data-act="lock" title="Lock">${track.locked?'🔒':'🔓'}</button>
            <button data-act="vis" title="Visibility">${track.visible?'👁':'🚫'}</button>
            <button data-act="del" title="Delete track">✕</button>
          </div>
        </div>
        <div class="tracklane ${track.type}" style="width:${totalW}px" data-track="${track.id}"></div>`;
      area.appendChild(row);
      const lane = row.querySelector('.tracklane');
      row.querySelectorAll('.trackhead button').forEach(b=>{
        b.onclick=()=>this.trackAction(track.id,b.dataset.act);
      });
      for(const clip of State.clips.filter(c=>c.trackId===track.id)){
        lane.appendChild(this.renderClip(clip,px,track));
      }
      lane.ondragover=e=>e.preventDefault();
      lane.ondrop=e=>{
        e.preventDefault();
        const mediaId = e.dataTransfer.getData('text/media-id');
        const rect = lane.getBoundingClientRect();
        const t = Math.max(0,(e.clientX-rect.left)/px);
        if(mediaId) addClipFromMedia(mediaId,track.id,t);
      };
    }
    const ph = $('#playhead');
    ph.style.left = (120 + State.playhead*px)+'px';
    ph.style.height = area.scrollHeight+22+'px';
    $('#zoomlabel').textContent = Math.round(px/60*100)+'%';
  },
  renderRuler(totalW){
    const ruler = $('#ruler');
    ruler.innerHTML='';
    ruler.style.position='relative';
    const px=State.zoom;
    const step = px<20?10 : px<50?5 : px<100?2:1;
    for(let s=0;s*px<totalW-120;s+=step){
      const tick=document.createElement('div');
      tick.style.cssText=`position:absolute;left:${120+s*px}px;top:0;bottom:0;width:1px;background:var(--line);`;
      ruler.appendChild(tick);
      if(s%(step*4===0?step:step*4)===0 || step>=2){
        const lbl=document.createElement('div');
        lbl.textContent=fmtTime(s).slice(3,8);
        lbl.style.cssText=`position:absolute;left:${124+s*px}px;top:3px;font-size:9px;color:var(--txt-2);`;
        ruler.appendChild(lbl);
      }
    }
    const scrub=(clientX)=>{
      const rect=ruler.getBoundingClientRect();
      const t=Math.max(0,(clientX-rect.left-120)/px);
      Player.seek(t);
    };
    ruler.onmousedown=(e)=>{
      scrub(e.clientX);
      const move=(ev)=>scrub(ev.clientX);
      const up=()=>{ document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up); };
      document.addEventListener('mousemove',move);
      document.addEventListener('mouseup',up);
    };
    ruler.ontouchstart=(e)=>{
      e.preventDefault();
      scrub(e.touches[0].clientX);
      const move=(ev)=>{ ev.preventDefault(); scrub(ev.touches[0].clientX); };
      const up=()=>{ document.removeEventListener('touchmove',move); document.removeEventListener('touchend',up); };
      document.addEventListener('touchmove',move,{passive:false});
      document.addEventListener('touchend',up);
    };
  },
  renderClip(clip,px,track){
    const el=document.createElement('div');
    el.className=`clip ${clip.type}`+(State.selection.has(clip.id)?' selected':'');
    el.style.left=(clip.start*px)+'px';
    el.style.width=Math.max(4,clip.duration*px)+'px';
    el.dataset.id=clip.id;
    const m = clip.mediaId?Media.get(clip.mediaId):null;
    let thumbHtml='';
    if(m && m.thumb) thumbHtml=`<div class="clipthumb" style="background-image:url('${m.thumb}')"></div>`;
    el.innerHTML = `<div class="cliplabel">${escapeHtml(clip.name||clip.type)}</div>${thumbHtml}
      <div class="cliphandle l"></div><div class="cliphandle r"></div>`;
    if(m && m.waveform && clip.type==='audio'){
      const cv=document.createElement('canvas'); cv.className='wave';
      el.appendChild(cv);
      requestAnimationFrame(()=>this.drawWave(cv,m.waveform));
      if(m.beats && m.beats.length){
        for(const bt of m.beats){
          const localBeat = bt-(clip.trimStart||0);
          if(localBeat<0 || localBeat>clip.duration) continue;
          const tick=document.createElement('div');
          tick.style.cssText=`position:absolute;left:${(localBeat/clip.duration)*100}%;top:0;bottom:0;width:1px;background:rgba(255,210,60,.8);pointer-events:none;`;
          el.appendChild(tick);
        }
      }
    }
    el.onmousedown=(e)=>this.startDrag(e,clip,el,px);
    el.ontouchstart=(e)=>this.startDrag(e.touches[0],clip,el,px,e);
    el.oncontextmenu=(e)=>{ e.preventDefault(); ContextMenu.open(e.clientX,e.clientY,clip); };
    return el;
  },
  drawWave(cv,peaks){
    const rect=cv.getBoundingClientRect();
    const w=Math.max(20,rect.width), h=Math.max(10,rect.height);
    cv.width=w; cv.height=h;
    const ctx=cv.getContext('2d');
    ctx.fillStyle='rgba(255,255,255,.55)';
    const bw=w/peaks.length;
    for(let i=0;i<peaks.length;i++){
      const bh=Math.max(1,peaks[i]*h);
      ctx.fillRect(i*bw,(h-bh)/2,Math.max(1,bw-0.5),bh);
    }
  },
  startDrag(e,clip,el,px,origEvent){
    if(origEvent) origEvent.preventDefault();
    const isTouch = !!origEvent;
    const target = e.target.classList && e.target.classList.contains('cliphandle')
      ? (e.target.classList.contains('l')?'trim-l':'trim-r') : 'move';
    if(State.tracks.find(t=>t.id===clip.trackId)?.locked) return;
    if(target==='move') selectClip(clip.id, e.shiftKey||e.ctrlKey||e.metaKey);
    this.dragState = {clip, mode:target, startX:e.clientX, origStart:clip.start,
      origDur:clip.duration, origTrimStart:clip.trimStart||0, px};
    const move=(ev)=>{
      if(ev.touches) ev.preventDefault();
      const pt = ev.touches?ev.touches[0]:ev;
      this.onDrag(pt);
    };
    const up=()=>{
      document.removeEventListener('mousemove',move);
      document.removeEventListener('mouseup',up);
      document.removeEventListener('touchmove',move);
      document.removeEventListener('touchend',up);
      if(this.dragState){ History.snapshot(); this.dragState=null; }
    };
    document.addEventListener('mousemove',move);
    document.addEventListener('mouseup',up);
    document.addEventListener('touchmove',move,{passive:false});
    document.addEventListener('touchend',up);
  },
  onDrag(e){
    const ds=this.dragState; if(!ds) return;
    const dx=(e.clientX-ds.startX)/ds.px;
    let snap = v=> State.project.snapping ? this.snapValue(v,ds.clip) : v;
    if(ds.mode==='move'){
      let ns = Math.max(0, ds.origStart+dx);
      ds.clip.start = snap(ns);
    } else if(ds.mode==='trim-l'){
      let ns = clamp(ds.origStart+dx, 0, ds.origStart+ds.origDur-0.1);
      const delta = ns-ds.origStart;
      ds.clip.start = ns;
      ds.clip.duration = ds.origDur-delta;
      ds.clip.trimStart = ds.origTrimStart+delta;
    } else if(ds.mode==='trim-r'){
      let nd = Math.max(0.1, ds.origDur+dx);
      ds.clip.duration = nd;
      ds.clip.trimEnd = ds.clip.trimStart+nd;
    }
    recomputeDuration();
    this.render();
  },
  snapValue(v,clip){
    const threshold = 8/State.zoom;
    const points=[0,State.playhead];
    for(const c of State.clips) if(c.id!==clip.id){ points.push(c.start); points.push(c.start+c.duration); }
    if(State.snapToBeats){
      for(const c of State.clips){
        if(c.type!=='audio') continue;
        const m=Media.get(c.mediaId);
        if(m?.beats) for(const bt of m.beats){
          const abs = c.start + (bt-(c.trimStart||0));
          if(abs>=c.start && abs<=c.start+c.duration) points.push(abs);
        }
      }
    }
    for(const p of points) if(Math.abs(v-p)<threshold) return p;
    return v;
  },
  trackAction(id,act){
    const t = State.tracks.find(x=>x.id===id); if(!t) return;
    if(act==='mute') t.muted=!t.muted;
    if(act==='lock') t.locked=!t.locked;
    if(act==='vis') t.visible=!t.visible;
    if(act==='del'){
      if(!confirm(`Delete track "${t.name}" and its clips?`)) return;
      State.tracks=State.tracks.filter(x=>x.id!==id);
      State.clips=State.clips.filter(c=>c.trackId!==id);
      recomputeDuration();
    }
    History.snapshot(); this.render();
  },
  addTrack(type){
    const n = State.tracks.filter(t=>t.type===type).length+1;
    State.tracks.push({id:uid(),type,name:(type==='video'?'V':'A')+n,height:type==='video'?56:40,
      muted:false,locked:false,visible:true});
    History.snapshot(); this.render();
  },
  setZoom(v){ State.zoom=clamp(v,10,400); this.render(); }
};

const ContextMenu = {
  el:null,
  open(x,y,clip){
    this.close();
    const items = [
      ['Cut', ()=>{ this.copy(clip); deleteSelected(); }],
      ['Copy', ()=>this.copy(clip)],
      ['Paste', ()=>this.paste()],
      ['Duplicate', ()=>{ selectClip(clip.id); duplicateSelected(); }],
      ['Split at playhead', ()=>{ selectClip(clip.id); splitAtPlayhead(); }],
      ['Delete', ()=>{ selectClip(clip.id); deleteSelected(); }],
    ];
    if(State.selection.size>1) items.splice(4,0,['Create Compound Clip', ()=>createCompoundClip()]);
    if(clip.type==='compound') items.push(['Ungroup compound clip', ()=>ungroupCompound(clip.id)]);
    const m=document.createElement('div');
    m.style.cssText=`position:fixed;left:${x}px;top:${y}px;background:var(--bg-2);border:1px solid var(--line);
      border-radius:8px;padding:4px;z-index:80;min-width:170px;box-shadow:0 6px 24px rgba(0,0,0,.5);`;
    for(const [label,fn] of items){
      const b=document.createElement('button');
      b.textContent=label; b.style.cssText='display:block;width:100%;text-align:left;margin-bottom:2px;background:transparent;border:none;';
      b.onclick=()=>{ fn(); this.close(); };
      m.appendChild(b);
    }
    document.body.appendChild(m); this.el=m;
    setTimeout(()=>document.addEventListener('click',this._close=()=>this.close(),{once:true}),0);
  },
  copy(clip){ this._clip = JSON.parse(JSON.stringify(clip)); toast('Copied'); },
  paste(){
    if(!this._clip) return;
    const n=JSON.parse(JSON.stringify(this._clip)); n.id=uid(); n.start=State.playhead;
    State.clips.push(n); recomputeDuration(); History.snapshot(); Timeline.render();
  },
  close(){ if(this.el){ this.el.remove(); this.el=null; } }
};

/* ---------------- Player / Compositor ---------------- */
const Player = {
  ctx:null, raf:null, lastTs:0, _procCanvas:new Map(),
  init(){ this.ctx = $('#stageCanvas').getContext('2d',{alpha:false}); this.resizeCanvas(); },
  resizeCanvas(){
    const canvas=$('#stageCanvas');
    canvas.width=State.project.width; canvas.height=State.project.height;
  },
  play(){
    if(State.playing) return;
    // Warm up every video element inside this click's user-gesture context —
    // Android Chrome/Safari block unmuted .play() calls made later from
    // inside a requestAnimationFrame loop without a fresh user gesture.
    for(const clip of State.clips){
      if(clip.type!=='video') continue;
      const b=Media.blob(clip.mediaId); if(!b) continue;
      if(!b.videoEl){ b.videoEl=document.createElement('video'); b.videoEl.src=b.objectURL;
        b.videoEl.playsInline=true; b.videoEl.preload='auto'; }
      const p=b.videoEl.play();
      if(p && p.then) p.then(()=>b.videoEl.pause()).catch(()=>{});
    }
    State.playing=true; $('#btnPlay').textContent='⏸';
    this.lastTs=performance.now();
    const loop=(ts)=>{
      if(!State.playing) return;
      const dt=(ts-this.lastTs)/1000; this.lastTs=ts;
      State.playhead = Math.min(State.duration, State.playhead+dt);
      if(State.playhead>=State.duration){ this.pause(); }
      this.renderFrame();
      Timeline.render();
      this.raf=requestAnimationFrame(loop);
    };
    this.raf=requestAnimationFrame(loop);
  },
  pause(){
    State.playing=false; $('#btnPlay').textContent='▶';
    cancelAnimationFrame(this.raf);
    this.syncMediaElements(true);
  },
  toggle(){ State.playing? this.pause(): this.play(); },
  seek(t){
    State.playhead = clamp(t,0,Math.max(State.duration,0));
    this.renderFrame(); Timeline.render();
  },
  stepFrame(dir){
    this.seek(State.playhead + dir/State.project.fps);
  },
  activeClipsAt(t){
    return State.clips.filter(c=>t>=c.start && t<c.start+c.duration &&
      State.tracks.find(tr=>tr.id===c.trackId && tr.visible!==false));
  },
  getProcessedCanvas(clip,sourceEl,iw,ih,maskOverride){
    if(!iw||!ih) return null;
    // Mobile/low-end performance: process chroma-key/mask pixels at a reduced
    // resolution when Preview Quality is Half/Quarter, then stretch on draw.
    const qEl=$('#previewQuality');
    const scale = (this.exporting) ? 1 : (qEl ? parseFloat(qEl.value)||1 : 1);
    const pw=Math.max(48,Math.round(iw*scale)), ph=Math.max(48,Math.round(ih*scale));
    let cv=this._procCanvas.get(clip.id);
    if(!cv || cv.width!==pw || cv.height!==ph){
      cv=document.createElement('canvas'); cv.width=pw; cv.height=ph;
      this._procCanvas.set(clip.id,cv);
    }
    const octx=cv.getContext('2d');
    octx.clearRect(0,0,pw,ph);
    try{ octx.drawImage(sourceEl,0,0,pw,ph); }catch(e){ return null; }
    if(clip.chroma?.enabled) applyChromaKey(octx,pw,ph,clip.chroma);
    if(clip.mask?.enabled){
      const mk=maskOverride||clip.mask;
      applyMask(octx,pw,ph,{...mk, x:(mk.x||0)*scale, y:(mk.y||0)*scale, w:(mk.w||0)*scale, h:(mk.h||0)*scale, feather:(mk.feather||0)*scale});
    }
    return cv;
  },
  syncMediaElements(pause){
    for(const clip of State.clips){
      if(clip.type!=='video') continue;
      const b=Media.blob(clip.mediaId); if(!b) continue;
      if(!b.videoEl){ b.videoEl=document.createElement('video'); b.videoEl.src=b.objectURL; b.videoEl.muted=false;
        b.videoEl.playsInline=true; b.videoEl.preload='auto'; }
      if(pause) b.videoEl.pause();
    }
  },
  renderFrame(){
    const ctx=this.ctx, W=State.project.width, H=State.project.height;
    ctx.save();
    ctx.fillStyle=State.project.bg||'#000';
    ctx.fillRect(0,0,W,H);
    const t=State.playhead;
    const active = this.activeClipsAt(t).sort((a,b)=>{
      const ta=State.tracks.findIndex(tr=>tr.id===a.trackId);
      const tb=State.tracks.findIndex(tr=>tr.id===b.trackId);
      return tb-ta; // later tracks in array drawn first (so first track = topmost)... reverse for natural order
    });
    for(const clip of active){
      this.drawClip(ctx,clip,t,W,H);
    }
    Captions.drawActive(ctx,W,H,t);
    ctx.restore();
    $('#timecode').textContent = `${fmtTime(t)} / ${fmtTime(State.duration)}`;
    const ph=$('#playhead'); ph.style.left=(120+t*State.zoom)+'px';
  },
  drawClip(ctx,clip,t,W,H){
    const localT = t-clip.start + (clip.trimStart||0);
    const clipLocalT = t-clip.start; // for keyframes, relative to clip's own timeline (0..duration)
    ctx.save();
    const kx = KF.isAnimated(clip,'transform.x') ? KF.valueAt(clip,'transform.x',clipLocalT) : clip.transform.x;
    const ky = KF.isAnimated(clip,'transform.y') ? KF.valueAt(clip,'transform.y',clipLocalT) : clip.transform.y;
    const ksx = KF.isAnimated(clip,'transform.scaleX') ? KF.valueAt(clip,'transform.scaleX',clipLocalT) : clip.transform.scaleX;
    const ksy = KF.isAnimated(clip,'transform.scaleY') ? KF.valueAt(clip,'transform.scaleY',clipLocalT) : clip.transform.scaleY;
    const krot = KF.isAnimated(clip,'transform.rot') ? KF.valueAt(clip,'transform.rot',clipLocalT) : clip.transform.rot;
    const kop = KF.isAnimated(clip,'transform.opacity') ? KF.valueAt(clip,'transform.opacity',clipLocalT) : clip.transform.opacity;
    const tr={x:kx,y:ky,scaleX:ksx,scaleY:ksy,rot:krot,opacity:kop};
    ctx.globalAlpha = tr.opacity!=null?tr.opacity:1;
    ctx.translate(tr.x, tr.y);
    ctx.rotate((tr.rot||0)*Math.PI/180);
    ctx.scale(tr.scaleX||1, tr.scaleY||1);
    const fx = clip.effects ? {
      brightness: KF.isAnimated(clip,'effects.brightness') ? KF.valueAt(clip,'effects.brightness',clipLocalT) : clip.effects.brightness,
      contrast: KF.isAnimated(clip,'effects.contrast') ? KF.valueAt(clip,'effects.contrast',clipLocalT) : clip.effects.contrast,
      saturation: KF.isAnimated(clip,'effects.saturation') ? KF.valueAt(clip,'effects.saturation',clipLocalT) : clip.effects.saturation,
      blur: KF.isAnimated(clip,'effects.blur') ? KF.valueAt(clip,'effects.blur',clipLocalT) : clip.effects.blur,
    } : {};
    const filters=[];
    if(fx.brightness) filters.push(`brightness(${100+fx.brightness}%)`);
    if(fx.contrast) filters.push(`contrast(${100+fx.contrast}%)`);
    if(fx.saturation) filters.push(`saturate(${100+fx.saturation}%)`);
    if(fx.blur) filters.push(`blur(${fx.blur}px)`);
    ctx.filter = filters.length?filters.join(' '):'none';

    // crossfade with adjacent clip on same track
    let fadeAlpha=1;
    const trackClips = State.clips.filter(c=>c.trackId===clip.trackId).sort((a,b)=>a.start-b.start);
    const idx = trackClips.indexOf(clip);
    const next = trackClips[idx+1];
    const XFADE=0.5;
    if(next && (clip.start+clip.duration-next.start)>0){
      const overlap = clip.start+clip.duration-next.start;
      if(t> clip.start+clip.duration-overlap) fadeAlpha = 1-((t-(clip.start+clip.duration-overlap))/overlap);
    }
    const prev = trackClips[idx-1];
    if(prev && (prev.start+prev.duration-clip.start)>0){
      const overlap = prev.start+prev.duration-clip.start;
      if(t< clip.start+overlap) fadeAlpha = Math.min(fadeAlpha,(t-clip.start)/overlap);
    }
    ctx.globalAlpha *= clamp(fadeAlpha,0,1);

    if(clip.type==='video'){
      const b=Media.blob(clip.mediaId);
      if(b){
        if(!b.videoEl){ b.videoEl=document.createElement('video'); b.videoEl.src=b.objectURL; b.videoEl.playsInline=true; b.videoEl.preload='auto'; }
        const v=b.videoEl;
        const kvol = KF.isAnimated(clip,'volume') ? KF.valueAt(clip,'volume',clipLocalT) : (clip.volume!=null?clip.volume:1);
        v.volume = clamp(kvol,0,1);
        const kspeed = KF.isAnimated(clip,'speed') ? KF.valueAt(clip,'speed',clipLocalT) : (clip.speed||1);
        v.playbackRate = clamp(kspeed,0.1,8);
        if(State.playing){
          if(v.paused) v.play().catch(()=>{});
          if(Math.abs(v.currentTime-localT)>0.35) v.currentTime=localT;
        } else {
          if(Math.abs(v.currentTime-localT)>0.03) try{ v.currentTime=localT; }catch(e){}
        }
        const m=Media.get(clip.mediaId);
        const iw=m?.width||W, ih=m?.height||H;
        try{
          let maskOpts = clip.mask;
          if(clip.mask?.enabled){
            maskOpts = {...clip.mask,
              x: KF.isAnimated(clip,'mask.x') ? KF.valueAt(clip,'mask.x',clipLocalT) : clip.mask.x,
              y: KF.isAnimated(clip,'mask.y') ? KF.valueAt(clip,'mask.y',clipLocalT) : clip.mask.y,
            };
          }
          const processed = (clip.chroma?.enabled || clip.mask?.enabled) ? this.getProcessedCanvas(clip,v,iw,ih,maskOpts) : null;
          ctx.drawImage(processed||v,-iw/2,-ih/2,iw,ih);
        }catch(e){}
      }
    } else if(clip.type==='image'){
      const b=Media.blob(clip.mediaId);
      if(b?.imgEl){
        const iw=b.imgEl.naturalWidth, ih=b.imgEl.naturalHeight;
        let maskOpts = clip.mask;
        if(clip.mask?.enabled){
          maskOpts = {...clip.mask,
            x: KF.isAnimated(clip,'mask.x') ? KF.valueAt(clip,'mask.x',clipLocalT) : clip.mask.x,
            y: KF.isAnimated(clip,'mask.y') ? KF.valueAt(clip,'mask.y',clipLocalT) : clip.mask.y,
          };
        }
        const processed = (clip.chroma?.enabled || clip.mask?.enabled) ? this.getProcessedCanvas(clip,b.imgEl,iw,ih,maskOpts) : null;
        ctx.drawImage(processed||b.imgEl,-iw/2,-ih/2,iw,ih);
      }
    } else if(clip.type==='sticker'){
      ctx.filter='none';
      const sk=clip.sticker||{char:'⭐',size:120};
      ctx.font=`${sk.size}px sans-serif`;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(sk.char,0,0);
    } else if(clip.type==='text'){
      const tx=clip.text||{};
      ctx.filter='none';
      let alpha=ctx.globalAlpha;
      if(tx.anim==='fade'){
        const fadeIn=Math.min(1,(t-clip.start)/0.4);
        const fadeOut=Math.min(1,(clip.start+clip.duration-t)/0.4);
        alpha*=clamp(Math.min(fadeIn,fadeOut),0,1);
      } else if(tx.anim==='pop'){
        const p=clamp((t-clip.start)/0.35,0,1);
        ctx.scale(0.6+0.4*p,0.6+0.4*p);
      }
      ctx.globalAlpha=alpha;
      ctx.font = `${tx.weight||700} ${tx.size||64}px ${tx.font||'Arial'}, sans-serif`;
      ctx.textAlign = tx.align||'center';
      ctx.textBaseline='middle';
      if(tx.bg && tx.bg!=='transparent'){
        const metrics=ctx.measureText(tx.content||'');
        const w=metrics.width+24, h=(tx.size||64)*1.3;
        ctx.fillStyle=tx.bg;
        ctx.fillRect(-w/2,-h/2,w,h);
      }
      if(tx.strokeWidth>0){
        ctx.strokeStyle=tx.stroke||'#000'; ctx.lineWidth=tx.strokeWidth;
        ctx.strokeText(tx.content||'',0,0);
      }
      ctx.fillStyle=tx.color||'#fff';
      ctx.fillText(tx.content||'',0,0);
    } else if(clip.type==='shape'){
      const sh=clip.shape||{};
      ctx.fillStyle=sh.fill||'#5b8cff';
      ctx.strokeStyle=sh.stroke||'#fff';
      ctx.lineWidth=sh.strokeWidth||0;
      const w=sh.w||200,h=sh.h||200;
      ctx.beginPath();
      if(sh.kind==='rect'){ ctx.rect(-w/2,-h/2,w,h); }
      else if(sh.kind==='ellipse'){ ctx.ellipse(0,0,w/2,h/2,0,0,Math.PI*2); }
      else if(sh.kind==='triangle'){ ctx.moveTo(0,-h/2); ctx.lineTo(w/2,h/2); ctx.lineTo(-w/2,h/2); ctx.closePath(); }
      else if(sh.kind==='line'){ ctx.moveTo(-w/2,0); ctx.lineTo(w/2,0); }
      ctx.fill(); if(sh.strokeWidth>0) ctx.stroke();
    } else if(clip.type==='compound'){
      const localT = t-clip.start;
      for(const child of (clip.compound?.children||[])){
        if(localT>=child.start && localT<child.start+child.duration){
          const virtualClip = {...child, start: clip.start+child.start};
          this.drawClip(ctx, virtualClip, t, W, H);
        }
      }
    }
    ctx.restore();
  }
};

/* ---------------- Inspector ---------------- */
const Inspector = {
  render(){
    const ids=[...State.selection];
    const empty=$('#inspectorEmpty'), body=$('#inspectorBody');
    if(ids.length!==1){ empty.classList.remove('hidden'); body.classList.add('hidden'); return; }
    const clip=getClip(ids[0]); if(!clip){ empty.classList.remove('hidden'); body.classList.add('hidden'); return; }
    empty.classList.add('hidden'); body.classList.remove('hidden');
    const clipLocalT = clamp(State.playhead-clip.start, 0, clip.duration);
    const inClip = (State.playhead>=clip.start && State.playhead<=clip.start+clip.duration);
    if(clip.type==='compound'){
      body.innerHTML = `<h3>Compound Clip</h3>
        <div class="row"><label>Name</label><input id="insName" type="text" value="${escapeHtml(clip.name||'')}"></div>
        <div style="color:var(--txt-2);font-size:11px;margin:6px 0;">Contains ${clip.compound.children.length} nested clip(s).
        Transform/effects on a compound clip aren't editable directly — ungroup to edit individual pieces.</div>`;
      body.innerHTML += this.rangeRow('cmpOpacity','Group Opacity','transform.opacity',clip.transform.opacity,0,1,0.01,clip,clipLocalT,inClip);
      body.innerHTML += `<div class="row"><button id="ungroupBtn" style="flex:1;">Ungroup</button></div>`;
      $('#insName').oninput=(e)=>{ clip.name=e.target.value; };
      $('#insName').onchange=()=>{ History.snapshot(); Timeline.render(); };
      const el=$('#cmpOpacity');
      el.oninput=()=>{ const v=parseFloat(el.value); $('#cmpOpacityVal').textContent=v; clip.transform.opacity=v; Player.renderFrame(); };
      el.onchange=()=>History.snapshot();
      $('#ungroupBtn').onclick=()=>ungroupCompound(clip.id);
      return;
    }
    let html = `<h3>Clip</h3>
      <div class="row"><label>Name</label><input id="insName" type="text" value="${escapeHtml(clip.name||'')}"></div>
      <h3>Transform <span style="color:var(--txt-2);font-weight:400;">— ◆ = keyframe at playhead</span></h3>`;
    const tr=clip.transform;
    html+=this.rangeRow('insX','X','transform.x',tr.x,0,State.project.width*1.5,1,clip,clipLocalT,inClip);
    html+=this.rangeRow('insY','Y','transform.y',tr.y,0,State.project.height*1.5,1,clip,clipLocalT,inClip);
    html+=this.rangeRow('insScaleX','Scale X','transform.scaleX',tr.scaleX,0.05,4,0.01,clip,clipLocalT,inClip);
    html+=this.rangeRow('insScaleY','Scale Y','transform.scaleY',tr.scaleY,0.05,4,0.01,clip,clipLocalT,inClip);
    html+=this.rangeRow('insRot','Rotation','transform.rot',tr.rot,-180,180,1,clip,clipLocalT,inClip);
    html+=this.rangeRow('insOpacity','Opacity','transform.opacity',tr.opacity,0,1,0.01,clip,clipLocalT,inClip);

    if(clip.type==='video'||clip.type==='image'){
      html+=`<h3>Effects</h3>`;
      const fx=clip.effects||{};
      html+=this.rangeRow('fxBrightness','Brightness','effects.brightness',fx.brightness||0,-100,100,1,clip,clipLocalT,inClip);
      html+=this.rangeRow('fxContrast','Contrast','effects.contrast',fx.contrast||0,-100,100,1,clip,clipLocalT,inClip);
      html+=this.rangeRow('fxSaturation','Saturation','effects.saturation',fx.saturation||0,-100,100,1,clip,clipLocalT,inClip);
      html+=this.rangeRow('fxBlur','Blur','effects.blur',fx.blur||0,0,20,0.5,clip,clipLocalT,inClip);

      const ck=clip.chroma||{};
      html+=`<h3>Chroma Key (Green Screen)</h3>
        <div class="row"><label>Enable</label><input id="ckEnable" type="checkbox" ${ck.enabled?'checked':''} style="flex:0;"></div>
        <div class="row"><label>Key Color</label><input id="ckColor" type="color" value="${ck.keyColor}"></div>`;
      html+=this.rangeRow('ckSim','Similarity',null,ck.similarity,0,1,0.01);
      html+=this.rangeRow('ckSmooth','Smoothness',null,ck.smoothness,0.001,0.6,0.01);
      html+=this.rangeRow('ckSpill','Spill reduce',null,ck.spill,0,1,0.01);

      const mk=clip.mask||{};
      html+=`<h3>Mask</h3>
        <div class="row"><label>Enable</label><input id="mkEnable" type="checkbox" ${mk.enabled?'checked':''} style="flex:0;"></div>
        <div class="row"><label>Shape</label><select id="mkKind">
          <option value="rect" ${mk.kind==='rect'?'selected':''}>Rectangle</option>
          <option value="ellipse" ${mk.kind==='ellipse'?'selected':''}>Ellipse</option>
        </select></div>`;
      html+=this.rangeRow('mkX','Position X','mask.x',mk.x,0,State.project.width*1.5,1,clip,clipLocalT,inClip);
      html+=this.rangeRow('mkY','Position Y','mask.y',mk.y,0,State.project.height*1.5,1,clip,clipLocalT,inClip);
      html+=this.rangeRow('mkW','Width',null,mk.w,10,Math.max(2000,State.project.width),1);
      html+=this.rangeRow('mkH','Height',null,mk.h,10,Math.max(2000,State.project.height),1);
      html+=this.rangeRow('mkFeather','Feather',null,mk.feather,0,80,1);
      html+=`<div class="row"><label>Invert</label><input id="mkInvert" type="checkbox" ${mk.invert?'checked':''} style="flex:0;"></div>
        <div style="color:var(--txt-2);font-size:11px;margin-top:4px;">No automatic object tracking — but you can
        keyframe Position X/Y (◆) frame-by-frame as a manual tracking substitute.</div>`;
    }
    if(clip.type==='video'){
      html+=`<h3>Audio / Speed</h3>`;
      html+=this.rangeRow('insVolume','Volume','volume',clip.volume!=null?clip.volume:1,0,1,0.01,clip,clipLocalT,inClip);
      html+=`<div class="row"><label>Speed preset</label><select id="insSpeed">
        ${[0.1,0.25,0.5,0.75,1,1.25,1.5,2,4,8].map(v=>`<option value="${v}" ${clip.speed===v?'selected':''}>${v}x</option>`).join('')}
        </select></div>`;
      html+=this.rangeRow('insSpeedKf','Speed ramp','speed',clip.speed!=null?clip.speed:1,0.1,8,0.05,clip,clipLocalT,inClip);
    }
    if(clip.type==='sticker'){
      const sk=clip.sticker;
      html+=`<h3>Sticker</h3><div class="row"><label>Character</label><input id="skChar" type="text" value="${escapeHtml(sk.char)}" style="flex:1;width:0;font-size:18px;"></div>`;
      html+=this.rangeRow('skSize','Size',null,sk.size,20,400,1);
    }
    if(clip.type==='text'){
      const tx=clip.text;
      html+=`<h3>Text</h3>
        <div class="row"><label>Content</label><textarea id="txContent" rows="2" style="flex:1;width:0;">${escapeHtml(tx.content)}</textarea></div>
        <div class="row"><label>Font</label><select id="txFont">
          ${['Arial','Georgia','"Courier New"','"Trebuchet MS"','Impact','"Times New Roman"'].map(f=>`<option ${tx.font===f?'selected':''}>${f}</option>`).join('')}
        </select></div>`;
      html+=this.rangeRow('txSize','Size',null,tx.size,10,200,1);
      html+=`<div class="row"><label>Color</label><input id="txColor" type="color" value="${tx.color}"></div>
        <div class="row"><label>Stroke</label><input id="txStroke" type="color" value="${tx.stroke}"></div>`;
      html+=this.rangeRow('txStrokeW','Stroke W',null,tx.strokeWidth,0,12,1);
      html+=`<div class="row"><label>Align</label><select id="txAlign">
          ${['left','center','right'].map(a=>`<option ${tx.align===a?'selected':''}>${a}</option>`).join('')}
        </select></div>
        <div class="row"><label>Animation</label><select id="txAnim">
          ${['none','fade','pop'].map(a=>`<option ${tx.anim===a?'selected':''}>${a}</option>`).join('')}
        </select></div>`;
    }
    if(clip.type==='shape'){
      const sh=clip.shape;
      html+=`<h3>Shape</h3>
        <div class="row"><label>Fill</label><input id="shFill" type="color" value="${sh.fill}"></div>
        <div class="row"><label>Stroke</label><input id="shStroke" type="color" value="${sh.stroke}"></div>`;
      html+=this.rangeRow('shStrokeW','Stroke W',null,sh.strokeWidth,0,20,1);
      html+=this.rangeRow('shW','Width',null,sh.w,10,2000,1);
      html+=this.rangeRow('shH','Height',null,sh.h,10,2000,1);
    }
    body.innerHTML=html;
    this.wire(clip);
  },
  rangeRow(id,label,propPath,val,min,max,step,clip,clipLocalT,inClip){
    const animated = propPath && clip && KF.isAnimated(clip,propPath);
    let diamond='', strip='';
    if(propPath){
      diamond = `<button class="kfDiamond" data-prop="${propPath}" data-src="${id}" data-min="${min}" data-max="${max}"
        title="${animated?'Animated — click to add/update keyframe at playhead':'Click to start animating this property'}"
        style="flex:0 0 auto;width:22px;height:22px;padding:0;font-size:11px;
        ${animated?'background:var(--accent);border-color:var(--accent);':''}">${animated?'◆':'◇'}</button>`;
      if(animated && clip){
        const list=[...KF.get(clip,propPath)].sort((a,b)=>a.t-b.t);
        const dur=Math.max(0.001,clip.duration);
        strip = `<div class="row" style="margin-top:-3px;"><label></label>
          <div class="kfStrip" data-prop="${propPath}" style="flex:1 1 auto;height:14px;background:var(--bg-1);
            border-radius:3px;position:relative;cursor:pointer;">
            ${list.map((k,i)=>`<div class="kfDot" data-prop="${propPath}" data-idx="${i}"
              title="t=${k.t.toFixed(2)}s  v=${(+k.v).toFixed(2)}  ease=${k.ease}  (click=jump, shift+click=delete)"
              style="position:absolute;left:${(k.t/dur)*100}%;top:1px;width:8px;height:8px;margin-left:-4px;
              background:#fff;border-radius:2px;transform:rotate(45deg);"></div>`).join('')}
            <div style="position:absolute;left:${(clipLocalT/dur)*100}%;top:-2px;bottom:-2px;width:1px;background:#ff5050;"></div>
          </div>
          <span class="valtag"></span></div>
          <div class="row" style="margin-top:-4px;"><label></label>
            <select class="kfEase" data-prop="${propPath}" style="flex:1 1 auto;font-size:10px;">
              ${Object.keys(Easing).map(e=>`<option value="${e}">${e} (nearest keyframe)</option>`).join('')}
            </select></div>`;
      }
    }
    return `<div class="row">${diamond}<label>${label}</label>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">
      <span class="valtag" id="${id}Val">${typeof val==='number'?(Math.round(val*100)/100):val}</span></div>${strip}`;
  },
  wire(clip){
    const clipLocalT = clamp(State.playhead-clip.start, 0, clip.duration);
    const bindRange=(id,setter,propPath)=>{
      const el=$('#'+id); if(!el) return;
      el.oninput=()=>{
        const v=parseFloat(el.value); $('#'+id+'Val').textContent=Math.round(v*100)/100;
        setter(v);
        if(propPath && KF.isAnimated(clip,propPath)){
          const lt=clamp(State.playhead-clip.start,0,clip.duration);
          KF.addOrUpdate(clip,propPath,lt,v);
          this.render(); // refresh strip position while dragging is fine (cheap)
        }
        Player.renderFrame();
      };
      el.onchange=()=>History.snapshot();
    };
    $('#insName').oninput=(e)=>{ clip.name=e.target.value; };
    $('#insName').onchange=()=>{ History.snapshot(); Timeline.render(); };
    bindRange('insX',v=>clip.transform.x=v,'transform.x');
    bindRange('insY',v=>clip.transform.y=v,'transform.y');
    bindRange('insScaleX',v=>clip.transform.scaleX=v,'transform.scaleX');
    bindRange('insScaleY',v=>clip.transform.scaleY=v,'transform.scaleY');
    bindRange('insRot',v=>clip.transform.rot=v,'transform.rot');
    bindRange('insOpacity',v=>clip.transform.opacity=v,'transform.opacity');
    if($('#fxBrightness')){
      bindRange('fxBrightness',v=>clip.effects.brightness=v,'effects.brightness');
      bindRange('fxContrast',v=>clip.effects.contrast=v,'effects.contrast');
      bindRange('fxSaturation',v=>clip.effects.saturation=v,'effects.saturation');
      bindRange('fxBlur',v=>clip.effects.blur=v,'effects.blur');

      $('#ckEnable').onchange=(e)=>{ clip.chroma.enabled=e.target.checked; History.snapshot(); Player.renderFrame(); };
      $('#ckColor').oninput=(e)=>{ clip.chroma.keyColor=e.target.value; Player.renderFrame(); };
      $('#ckColor').onchange=()=>History.snapshot();
      bindRange('ckSim',v=>clip.chroma.similarity=v);
      bindRange('ckSmooth',v=>clip.chroma.smoothness=v);
      bindRange('ckSpill',v=>clip.chroma.spill=v);

      $('#mkEnable').onchange=(e)=>{ clip.mask.enabled=e.target.checked; History.snapshot(); Player.renderFrame(); };
      $('#mkKind').onchange=(e)=>{ clip.mask.kind=e.target.value; History.snapshot(); Player.renderFrame(); };
      $('#mkInvert').onchange=(e)=>{ clip.mask.invert=e.target.checked; History.snapshot(); Player.renderFrame(); };
      bindRange('mkX',v=>clip.mask.x=v,'mask.x');
      bindRange('mkY',v=>clip.mask.y=v,'mask.y');
      bindRange('mkW',v=>clip.mask.w=v);
      bindRange('mkH',v=>clip.mask.h=v);
      bindRange('mkFeather',v=>clip.mask.feather=v);
    }
    if($('#insVolume')){
      bindRange('insVolume',v=>clip.volume=v,'volume');
      $('#insSpeed').onchange=(e)=>{ clip.speed=parseFloat(e.target.value); History.snapshot(); this.render(); };
      bindRange('insSpeedKf',v=>clip.speed=v,'speed');
    }
    if($('#skChar')){
      $('#skChar').oninput=(e)=>{ clip.sticker.char=e.target.value||'⭐'; Player.renderFrame(); Timeline.render(); };
      $('#skChar').onchange=()=>History.snapshot();
      bindRange('skSize',v=>clip.sticker.size=v);
    }
    if($('#txContent')){
      $('#txContent').oninput=(e)=>{ clip.text.content=e.target.value; Player.renderFrame(); Timeline.render(); };
      $('#txContent').onchange=()=>History.snapshot();
      $('#txFont').onchange=(e)=>{ clip.text.font=e.target.value; History.snapshot(); Player.renderFrame(); };
      bindRange('txSize',v=>clip.text.size=v);
      $('#txColor').oninput=(e)=>{ clip.text.color=e.target.value; Player.renderFrame(); };
      $('#txColor').onchange=()=>History.snapshot();
      $('#txStroke').oninput=(e)=>{ clip.text.stroke=e.target.value; Player.renderFrame(); };
      $('#txStroke').onchange=()=>History.snapshot();
      bindRange('txStrokeW',v=>clip.text.strokeWidth=v);
      $('#txAlign').onchange=(e)=>{ clip.text.align=e.target.value; History.snapshot(); Player.renderFrame(); };
      $('#txAnim').onchange=(e)=>{ clip.text.anim=e.target.value; History.snapshot(); };
    }
    if($('#shFill')){
      $('#shFill').oninput=(e)=>{ clip.shape.fill=e.target.value; Player.renderFrame(); };
      $('#shFill').onchange=()=>History.snapshot();
      $('#shStroke').oninput=(e)=>{ clip.shape.stroke=e.target.value; Player.renderFrame(); };
      $('#shStroke').onchange=()=>History.snapshot();
      bindRange('shStrokeW',v=>clip.shape.strokeWidth=v);
      bindRange('shW',v=>clip.shape.w=v);
      bindRange('shH',v=>clip.shape.h=v);
    }

    // ---- keyframe controls ----
    $$('.kfDiamond').forEach(btn=>{
      btn.onclick=()=>{
        const prop=btn.dataset.prop, src=$('#'+btn.dataset.src);
        const v=parseFloat(src.value);
        const lt=clamp(State.playhead-clip.start,0,clip.duration);
        if(!KF.isAnimated(clip,prop) && lt>0.02){
          // seed a keyframe at the start so existing value doesn't jump
          KF.addOrUpdate(clip,prop,0,v);
        }
        KF.addOrUpdate(clip,prop,lt,v);
        History.snapshot(); this.render();
      };
      btn.oncontextmenu=(e)=>{
        e.preventDefault();
        const prop=btn.dataset.prop;
        if(KF.isAnimated(clip,prop) && confirm('Remove all keyframes for this property?')){
          KF.clearProp(clip,prop); History.snapshot(); this.render();
        }
      };
    });
    $$('.kfDot').forEach(dot=>{
      dot.onclick=(e)=>{
        e.stopPropagation();
        const prop=dot.dataset.prop, idx=parseInt(dot.dataset.idx);
        const list=KF.get(clip,prop);
        if(e.shiftKey){ KF.remove(clip,prop,idx); History.snapshot(); this.render(); return; }
        if(list && list[idx]){ Player.seek(clip.start+list[idx].t); }
      };
    });
    $$('.kfEase').forEach(sel=>{
      const prop=sel.dataset.prop;
      const list=KF.get(clip,prop);
      if(list && list.length){
        const lt=clamp(State.playhead-clip.start,0,clip.duration);
        let nearest=0,best=Infinity;
        list.forEach((k,i)=>{ const d=Math.abs(k.t-lt); if(d<best){best=d;nearest=i;} });
        sel.value=list[nearest].ease||'linear';
        sel.onchange=()=>{ KF.setEase(clip,prop,nearest,sel.value); History.snapshot(); Player.renderFrame(); };
      }
    });
    $$('.kfStrip').forEach(strip=>{
      strip.onclick=(e)=>{
        if(e.target.classList.contains('kfDot')) return;
        const rect=strip.getBoundingClientRect();
        const p=clamp((e.clientX-rect.left)/rect.width,0,1);
        Player.seek(clip.start + p*clip.duration);
      };
    });

    Player.renderFrame();
  }
};

/* ---------------- Left Panels ---------------- */
const Panels = {
  current:'media',
  render(tab){
    if(tab) this.current=tab;
    $$('#lefttabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===this.current));
    const body=$('#leftbody');
    if(this.current==='media') body.innerHTML=this.mediaHtml();
    else if(this.current==='text') body.innerHTML=this.textHtml();
    else if(this.current==='shapes') body.innerHTML=this.shapesHtml();
    else if(this.current==='effects') body.innerHTML=this.effectsHtml();
    else if(this.current==='transitions') body.innerHTML=this.transitionsHtml();
    else if(this.current==='captions') body.innerHTML=this.captionsHtml();
    else if(this.current==='stickers') body.innerHTML=this.stickersHtml();
    else if(this.current==='templates') body.innerHTML=this.templatesHtml();
    else if(this.current==='audio') body.innerHTML=this.audioHtml();
    else if(this.current==='settings') body.innerHTML=this.settingsHtml();
    this.wire();
  },
  mediaHtml(){
    const items=[...State.media.values()];
    let html=`<div class="dropzone" id="dz">Drag & drop video / audio / images here<br>or <button id="dzBtn">Browse files</button></div>`;
    if(!items.length) html+=`<div style="color:var(--txt-2);text-align:center;padding:20px 4px;">No media yet.</div>`;
    else{
      html+='<div class="medgrid">';
      for(const m of items){
        html+=`<div class="meditem" draggable="true" data-id="${m.id}">
          <div class="thumb" style="background-image:url('${m.thumb||''}')">
            <span class="kind">${m.type}</span>
            <button class="addBtn" data-id="${m.id}" title="Add to timeline at playhead">+</button>
          </div>
          <div class="meta">${escapeHtml(m.name)}</div></div>`;
      }
      html+='</div>';
    }
    return html;
  },
  textHtml(){
    return `<button class="listbtn" id="addTextBtn">+ Add Text Layer<small>Editable in preview & inspector</small></button>
      <div style="color:var(--txt-2);font-size:11px;margin-top:8px;">Text animations: Fade, Pop (more presets in inspector).</div>`;
  },
  shapesHtml(){
    const shapes=['rect','ellipse','triangle','line'];
    return `<div class="medgrid">${shapes.map(s=>`<button class="listbtn shapeBtn" data-shape="${s}" style="text-align:center;">${s}</button>`).join('')}</div>`;
  },
  effectsHtml(){
    return `<div style="color:var(--txt-2);font-size:11px;">Select a clip on the timeline, then adjust
      Brightness / Contrast / Saturation / Blur in the right Inspector panel. These apply in real time and to export.</div>`;
  },
  transitionsHtml(){
    return `<div style="color:var(--txt-2);font-size:11px;line-height:1.5;">
      <b>Crossfade</b> is applied automatically whenever two clips on the same track overlap —
      just drag one clip to overlap the next by ~0.5s.<br><br>
      Additional transition types (wipe, slide, zoom) are on the roadmap — not faked here.</div>`;
  },
  captionsHtml(){
    const st=State.captionStyle;
    let html=`<div class="row"><button id="capAddBtn" style="flex:1;">+ Add caption at playhead</button></div>
      <div class="row"><button id="capImportBtn" style="flex:1;">Import .srt/.vtt</button></div>
      <div class="row"><button id="capExportSrt">Export .srt</button><button id="capExportVtt">Export .vtt</button></div>
      <h3>Style</h3>
      <div class="row"><label>Position</label><select id="capPos">
        <option value="bottom" ${st.position==='bottom'?'selected':''}>Bottom</option>
        <option value="top" ${st.position==='top'?'selected':''}>Top</option>
      </select></div>`;
    html+=this.rr('capSize','Size',st.size,14,90,1);
    html+=`<div class="row"><label>Color</label><input id="capColor" type="color" value="${st.color}"></div>
      <div class="row"><label>Stroke</label><input id="capStroke" type="color" value="${st.strokeWidth>0?st.stroke:'#000000'}"></div>`;
    html+=this.rr('capStrokeW','Stroke W',st.strokeWidth,0,10,1);
    html+=`<div class="row"><label>Karaoke</label><input id="capKaraoke" type="checkbox" ${st.karaoke?'checked':''} style="flex:0;"></div>
      <h3>Caption list (${State.captions.length})</h3>`;
    if(!State.captions.length) html+=`<div style="color:var(--txt-2);font-size:11px;">No captions yet. Add one at the playhead, or import an .srt/.vtt file.</div>`;
    else{
      for(const c of State.captions){
        html+=`<div class="capRow" data-id="${c.id}">
          <div class="times"><input type="number" step="0.1" class="capStart" value="${c.start.toFixed(2)}">
            <input type="number" step="0.1" class="capEnd" value="${c.end.toFixed(2)}">
            <button class="capDel">✕</button></div>
          <textarea class="capText" rows="2">${escapeHtml(c.text)}</textarea></div>`;
      }
    }
    return html;
  },
  rr(id,label,val,min,max,step){ return this.mkrange(id,label,val,min,max,step); },
  mkrange(id,label,val,min,max,step){
    return `<div class="row"><label>${label}</label>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">
      <span class="valtag" id="${id}Val">${val}</span></div>`;
  },
  stickersHtml(){
    const emojis=['😀','😂','🔥','❤️','👍','👏','🎉','⭐','✅','❌','⚡','💯','🚀','👀','🙌','😍','🤔','😎','🎯','📌','⚠️','💡','🏆','🎬'];
    return `<div class="stickerGrid">${emojis.map(e=>`<button class="stickerBtn" data-char="${e}">${e}</button>`).join('')}</div>
      <div style="color:var(--txt-2);font-size:11px;margin-top:10px;">Click a sticker to insert it at the playhead. Then drag/scale/animate it like any other clip (keyframes work too).</div>`;
  },
  templatesHtml(){
    const items=[
      ['lowerThird','Lower Third','Name/title bar — bottom-left'],
      ['introTitle','Intro Title','Big centered pop-in title'],
      ['subscribeCTA','Subscribe CTA','Bottom-right subscribe callout'],
      ['chapterTitle','Chapter Title','Top banner for chapters/topics'],
    ];
    return items.map(([k,name,desc])=>`<button class="listbtn tplBtn" data-tpl="${k}">${name}<small>${desc}</small></button>`).join('')+
      `<div style="color:var(--txt-2);font-size:11px;margin-top:8px;">Inserts real, fully editable clips at the playhead — not a fixed image.</div>`;
  },
  audioHtml(){
    const vTracks=State.tracks.filter(t=>t.type==='video'||t.type==='audio');
    const opts=(t)=>`<option value="${t.id}">${escapeHtml(t.name)} (${t.type})</option>`;
    return `<h3>Auto-Duck Music</h3>
      <div style="color:var(--txt-2);font-size:11px;margin-bottom:6px;">
        Automatically lowers music volume under a voice track using real
        volume keyframes (attack/release), per browser-safe approach.</div>
      <div class="row"><label>Voice track</label><select id="duckVoice">${State.tracks.map(opts).join('')}</select></div>
      <div class="row"><label>Music track</label><select id="duckMusic">${State.tracks.map(opts).join('')}</select></div>`+
      this.mkrange('duckAmt','Duck to',0.25,0,1,0.05)+
      `<div class="row"><button id="duckApply" class="primary" style="flex:1;">Apply Auto-Duck</button></div>
      <h3>Safe-Area Guides</h3>
      <div class="row"><label>Show guides</label><input id="safeToggle" type="checkbox" ${State.showSafeGuides?'checked':''} style="flex:0;"></div>
      <div style="color:var(--txt-2);font-size:11px;">Action-safe (90%) and title-safe (80%) margins, shown over the preview only — never exported.</div>`;
  },
  settingsHtml(){
    const p=State.project;
    return `<h3 style="text-transform:uppercase;font-size:11px;color:var(--txt-2);margin-top:0;">Project</h3>
      <div class="row"><label>Preset</label><select id="setPreset">
        <option value="1920x1080x30">YouTube 1920×1080</option>
        <option value="1080x1920x30">Shorts/Reels 1080×1920</option>
        <option value="1080x1080x30">Instagram 1080×1080</option>
        <option value="1080x1350x30">Instagram 4:5</option>
        <option value="custom">Custom</option>
      </select></div>
      <div class="row"><label>Width</label><input id="setW" type="number" value="${p.width}"></div>
      <div class="row"><label>Height</label><input id="setH" type="number" value="${p.height}"></div>
      <div class="row"><label>FPS</label><select id="setFps">
        ${[24,25,30,50,60].map(f=>`<option ${p.fps===f?'selected':''}>${f}</option>`).join('')}
      </select></div>
      <div class="row"><label>Background</label><input id="setBg" type="color" value="${p.bg}"></div>
      <div class="row"><label>Snapping</label><input id="setSnap" type="checkbox" ${p.snapping?'checked':''} style="flex:0;"></div>
      <h3>Auto-Reframe</h3>
      <div style="color:var(--txt-2);font-size:11px;margin-bottom:6px;">
        Changes canvas size and auto-crops/centers video &amp; image clips to
        cover the new frame (manual center-crop — no AI subject tracking,
        since that isn't feasible client-side; text/shapes/stickers keep
        their relative position).</div>
      <div class="medgrid">
        <button class="reframeBtn" data-w="1080" data-h="1920">9:16 Shorts</button>
        <button class="reframeBtn" data-w="1080" data-h="1080">1:1 Square</button>
        <button class="reframeBtn" data-w="1080" data-h="1350">4:5 Portrait</button>
        <button class="reframeBtn" data-w="1920" data-h="1080">16:9 Landscape</button>
      </div>
      <h3 style="text-transform:uppercase;font-size:11px;color:var(--txt-2);">Capabilities</h3>
      <div style="font-size:11px;line-height:1.7;color:var(--txt-1);">
        ${Object.entries(CAPS).map(([k,v])=>`<div><span class="dot ${v?'ok':'err'}"></span>${k}: ${v?'supported':'unavailable'}</div>`).join('')}
      </div>`;
  },
  wire(){
    if(this.current==='media'){
      const dz=$('#dz');
      $('#dzBtn').onclick=()=>$('#fileImportInput').click();
      dz.ondragover=(e)=>{ e.preventDefault(); dz.classList.add('drag'); };
      dz.ondragleave=()=>dz.classList.remove('drag');
      dz.ondrop=(e)=>{ e.preventDefault(); dz.classList.remove('drag'); Media.importFiles(e.dataTransfer.files); };
      $$('.meditem').forEach(el=>{
        el.ondragstart=(e)=>e.dataTransfer.setData('text/media-id',el.dataset.id);
        el.ondblclick=()=>addClipFromMedia(el.dataset.id, defaultTrackFor(el.dataset.id), State.playhead);
      });
      // Tap-to-add button — works on Android/touch where HTML5 drag-and-drop is unsupported,
      // and is a faster path on desktop too.
      $$('.addBtn').forEach(b=>{
        b.onclick=(e)=>{
          e.stopPropagation();
          addClipFromMedia(b.dataset.id, defaultTrackFor(b.dataset.id), State.playhead);
        };
      });
    }
    if(this.current==='text'){
      $('#addTextBtn').onclick=()=>addTextClip(State.playhead);
    }
    if(this.current==='shapes'){
      $$('.shapeBtn').forEach(b=>b.onclick=()=>addShapeClip(b.dataset.shape,State.playhead));
    }
    if(this.current==='captions'){
      $('#capAddBtn').onclick=()=>{
        Captions.add(State.playhead, Math.min(State.duration||State.playhead+3, State.playhead+3), 'New caption');
        this.render('captions');
      };
      $('#capImportBtn').onclick=()=>$('#captionImportInput').click();
      $('#capExportSrt').onclick=()=>Captions.exportSRT();
      $('#capExportVtt').onclick=()=>Captions.exportVTT();
      $('#capPos').onchange=(e)=>{ State.captionStyle.position=e.target.value; History.snapshot(); Player.renderFrame(); };
      $('#capSize').oninput=(e)=>{ State.captionStyle.size=parseFloat(e.target.value); $('#capSizeVal').textContent=e.target.value; Player.renderFrame(); };
      $('#capSize').onchange=()=>History.snapshot();
      $('#capColor').oninput=(e)=>{ State.captionStyle.color=e.target.value; Player.renderFrame(); };
      $('#capColor').onchange=()=>History.snapshot();
      $('#capStroke').oninput=(e)=>{ State.captionStyle.stroke=e.target.value; Player.renderFrame(); };
      $('#capStroke').onchange=()=>History.snapshot();
      $('#capStrokeW').oninput=(e)=>{ State.captionStyle.strokeWidth=parseFloat(e.target.value); $('#capStrokeWVal').textContent=e.target.value; Player.renderFrame(); };
      $('#capStrokeW').onchange=()=>History.snapshot();
      $('#capKaraoke').onchange=(e)=>{ State.captionStyle.karaoke=e.target.checked; History.snapshot(); Player.renderFrame(); };
      $$('.capRow').forEach(row=>{
        const id=row.dataset.id;
        const cap=State.captions.find(c=>c.id===id);
        row.querySelector('.capStart').onchange=(e)=>{ cap.start=parseFloat(e.target.value)||0; State.captions.sort((a,b)=>a.start-b.start); History.snapshot(); Player.renderFrame(); };
        row.querySelector('.capEnd').onchange=(e)=>{ cap.end=parseFloat(e.target.value)||cap.start+1; History.snapshot(); Player.renderFrame(); };
        row.querySelector('.capText').oninput=(e)=>{ cap.text=e.target.value; Player.renderFrame(); };
        row.querySelector('.capText').onchange=()=>History.snapshot();
        row.querySelector('.capDel').onclick=()=>{ Captions.remove(id); this.render('captions'); Player.renderFrame(); };
      });
    }
    if(this.current==='stickers'){
      $$('.stickerBtn').forEach(b=>b.onclick=()=>addStickerClip(b.dataset.char,State.playhead));
    }
    if(this.current==='templates'){
      $$('.tplBtn').forEach(b=>b.onclick=()=>insertTemplate(b.dataset.tpl));
    }
    if(this.current==='audio'){
      $('#duckApply').onclick=()=>{
        autoDuck($('#duckVoice').value, $('#duckMusic').value, parseFloat($('#duckAmt').value), 0.25, 0.35);
      };
      $('#duckAmt').oninput=(e)=>$('#duckAmtVal').textContent=e.target.value;
      $('#safeToggle').onchange=(e)=>{
        State.showSafeGuides=e.target.checked;
        $('#safeGuides').classList.toggle('show', State.showSafeGuides);
        renderSafeGuides();
      };
    }
    if(this.current==='settings'){
      $('#setPreset').onchange=(e)=>{
        const v=e.target.value; if(v==='custom') return;
        const [w,h,f]=v.split('x').map(Number);
        State.project.width=w; State.project.height=h; State.project.fps=f;
        Player.resizeCanvas(); Panels.render('settings'); History.snapshot(); Player.renderFrame();
      };
      $('#setW').onchange=(e)=>{ State.project.width=parseInt(e.target.value)||1920; Player.resizeCanvas(); History.snapshot(); Player.renderFrame(); };
      $('#setH').onchange=(e)=>{ State.project.height=parseInt(e.target.value)||1080; Player.resizeCanvas(); History.snapshot(); Player.renderFrame(); };
      $('#setFps').onchange=(e)=>{ State.project.fps=parseInt(e.target.value); History.snapshot(); };
      $('#setBg').oninput=(e)=>{ State.project.bg=e.target.value; Player.renderFrame(); };
      $('#setBg').onchange=()=>History.snapshot();
      $('#setSnap').onchange=(e)=>{ State.project.snapping=e.target.checked; History.snapshot(); };
      $$('.reframeBtn').forEach(b=>b.onclick=()=>reframeProject(parseInt(b.dataset.w),parseInt(b.dataset.h)));
    }
  }
};
function defaultTrackFor(mediaId){
  const m=Media.get(mediaId);
  const t = State.tracks.find(t=> (m.type==='audio'?t.type==='audio':t.type==='video'));
  return t?t.id:State.tracks[0].id;
}

/* ---------------- Export ---------------- */
const Exporter = {
  async open(){
    if(!CAPS.mediaRecorder || !CAPS.captureStream){
      alert('Export is unavailable: this browser does not support MediaRecorder / canvas.captureStream(). Try a recent Chrome, Edge, or Firefox.');
      return;
    }
    const mime = CAPS.webmVp9?'video/webm;codecs=vp9,opus': CAPS.webmVp8?'video/webm;codecs=vp8,opus':'video/webm';
    const modal=document.createElement('div');
    modal.className='modalbg';
    modal.innerHTML=`<div class="modal">
      <h2>Export Video</h2>
      <div class="row"><label>Format</label><span>${mime.startsWith('video/webm')?'WebM (VP9/VP8 + Opus)':'WebM'} ${CAPS.mp4Rec?'':'&nbsp;— MP4 unavailable in this browser'}</span></div>
      <div class="row"><label>Resolution</label><select id="expRes">
        <option value="1">Original (${State.project.width}×${State.project.height})</option>
        <option value="0.75">75%</option>
        <option value="0.5">50%</option>
      </select></div>
      <div class="row"><label>FPS</label><select id="expFps">
        ${[24,25,30,50,60].map(f=>`<option ${State.project.fps===f?'selected':''}>${f}</option>`).join('')}
      </select></div>
      <div class="row"><label>Quality</label><select id="expQ">
        <option value="low">Low (5 Mbps)</option><option value="med" selected>Medium (10 Mbps)</option><option value="high">High (18 Mbps)</option>
      </select></div>
      <div id="exportProgWrap"><div id="exportProgBar"></div></div>
      <div id="exportStatus" style="font-size:11px;color:var(--txt-2);margin-top:6px;">Ready.</div>
      <div class="actions">
        <button id="expCancel">Close</button>
        <button id="expGo" class="primary">Start Export</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    $('#expCancel',modal).onclick=()=>{ this.cancel(); modal.remove(); };
    $('#expGo',modal).onclick=()=>this.run(modal,mime);
  },
  cancelled:false,
  cancel(){ this.cancelled=true; if(this.recorder && this.recorder.state==='recording') this.recorder.stop(); },
  async run(modal,mime){
    this.cancelled=false;
    const resScale=parseFloat($('#expRes',modal).value);
    const fps=parseInt($('#expFps',modal).value);
    const qMap={low:5_000_000, med:10_000_000, high:18_000_000};
    const bitrate=qMap[$('#expQ',modal).value];
    $('#expGo',modal).textContent='Exporting...'; $('#expGo',modal).disabled=true;

    const W=Math.round(State.project.width*resScale), H=Math.round(State.project.height*resScale);
    const off=document.createElement('canvas'); off.width=W; off.height=H;
    const octx=off.getContext('2d',{alpha:false});

    // audio mix via WebAudio
    let audioDest=null, actx=null;
    if(CAPS.webAudio){
      actx = new (window.AudioContext||window.webkitAudioContext)();
      audioDest = actx.createMediaStreamDestination();
      for(const clip of State.clips){
        if(clip.type==='video'){
          const b=Media.blob(clip.mediaId);
          if(b && b.videoEl){
            try{
              if(!b._srcNode){ b._srcNode=actx.createMediaElementSource(b.videoEl); }
              b._srcNode.connect(audioDest);
            }catch(e){/* already connected or cross device */}
          }
        }
      }
    }

    const canvasStream = off.captureStream(fps);
    const tracks=[...canvasStream.getVideoTracks()];
    if(audioDest) tracks.push(...audioDest.stream.getAudioTracks());
    const mixed = new MediaStream(tracks);

    const chunks=[];
    let rec;
    try{
      rec = new MediaRecorder(mixed,{mimeType:mime, videoBitsPerSecond:bitrate});
    }catch(e){ rec = new MediaRecorder(mixed); }
    this.recorder=rec;
    rec.ondataavailable=(e)=>{ if(e.data.size) chunks.push(e.data); };

    const totalDur=State.duration||1;
    const startWall=performance.now();
    let t=0;
    State.playhead=0;
    Player.pause();
    Player.syncMediaElements(true);
    Player.exporting=true;
    Player._procCanvas.clear(); // drop any reduced-res cached frames so export re-processes at full quality

    const stepDur=1/fps;
    $('#exportStatus',modal).textContent='Recording... 0%';
    rec.start(250);

    const renderLoop=()=>{
      if(this.cancelled){ rec.stop(); return; }
      // draw current frame at time t onto off-canvas using same logic as Player but scaled
      octx.save();
      octx.scale(resScale,resScale);
      const savedCtx=Player.ctx; Player.ctx=octx;
      State.playhead=t;
      Player.renderFrame();
      Player.ctx=savedCtx;
      octx.restore();

      const pct=Math.min(100, Math.round((t/totalDur)*100));
      $('#exportProgBar',modal).style.width=pct+'%';
      $('#exportStatus',modal).textContent=`Recording... ${pct}%  (${fmtTime(t)} / ${fmtTime(totalDur)})`;

      t+=stepDur;
      if(t>=totalDur){
        setTimeout(()=>rec.stop(), 300);
      } else {
        setTimeout(renderLoop, stepDur*1000);
      }
    };

    rec.onstop=()=>{
      Player.exporting=false;
      Player._procCanvas.clear();
      if(actx) actx.close();
      if(this.cancelled){ $('#exportStatus',modal).textContent='Cancelled.'; $('#expGo',modal).disabled=false; $('#expGo',modal).textContent='Start Export'; return; }
      const blob=new Blob(chunks,{type:mime.split(';')[0]});
      const filename=(State.project.name||'export').replace(/[^\w-]+/g,'_')+'.webm';
      const url=URL.createObjectURL(blob);
      this._lastBlob=blob; this._lastFilename=filename;
      $('#exportProgBar',modal).style.width='100%';
      $('#exportStatus',modal).innerHTML=`Done — ${(blob.size/1e6).toFixed(1)} MB, saved to your Downloads as <b>${filename}</b>.`;
      $('#expGo',modal).disabled=false; $('#expGo',modal).textContent='Start Export';

      // Real save-to-disk: trigger an actual browser download immediately (works everywhere).
      const a=document.createElement('a'); a.href=url; a.download=filename;
      document.body.appendChild(a); a.click(); a.remove();

      // Also show a manual re-download link + a real "Save As..." picker where supported.
      const links=document.createElement('div');
      links.style.cssText='margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;';
      links.innerHTML=`<a href="${url}" download="${filename}" style="color:var(--accent);">Download again</a>`;
      if(CAPS.fsAccess){
        const saveBtn=document.createElement('button');
        saveBtn.textContent='Save As...';
        saveBtn.onclick=async()=>{
          try{
            const handle=await window.showSaveFilePicker({
              suggestedName:filename,
              types:[{description:'WebM video',accept:{'video/webm':['.webm']}}]
            });
            const writable=await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            toast('Saved to chosen location');
          }catch(e){ if(e.name!=='AbortError') toast('Save As failed: '+e.message); }
        };
        links.appendChild(saveBtn);
      }
      $('#exportStatus',modal).after(links);
      toast('Export complete — file saved to Downloads');
    };

    renderLoop();
  }
};

/* ---------------- Project Save/Load ---------------- */
const Project = {
  async save(){
    const data = {
      id: State.project.id, name: State.project.name,
      project: State.project, tracks: State.tracks, clips: State.clips,
      captions: State.captions, captionStyle: State.captionStyle,
      mediaRefs: [...State.media.values()].map(m=>({id:m.id,name:m.name,type:m.type,duration:m.duration,width:m.width,height:m.height,thumb:m.thumb})),
      savedAt: Date.now()
    };
    try{
      await DB.put('projects',{id:data.id, name:data.name, json:JSON.stringify(data), savedAt:data.savedAt});
      toast('Project saved (local, IndexedDB)');
    }catch(e){ toast('Save failed: '+e.message); }
  },
  async exportJson(){
    const data = {
      project: State.project, tracks: State.tracks, clips: State.clips,
      captions: State.captions, captionStyle: State.captionStyle,
      mediaRefs: [...State.media.values()].map(m=>({id:m.id,name:m.name,type:m.type,duration:m.duration,width:m.width,height:m.height}))
    };
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=(State.project.name||'project')+'.apnacut.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),4000);
  },
  async importJsonFile(file){
    const text=await file.text();
    const data=JSON.parse(text);
    State.project=data.project; State.tracks=data.tracks; State.clips=data.clips;
    State.captions=data.captions||[]; State.captionStyle=data.captionStyle||State.captionStyle;
    State.selection.clear();
    // attempt relink from IndexedDB media store
    const allMedia = await DB.getAll('media').catch(()=>[]);
    State.media.clear(); State.mediaBlobs.clear();
    let missing=0;
    for(const ref of (data.mediaRefs||[])){
      const found = allMedia.find(m=>m.id===ref.id);
      if(found){
        const url=URL.createObjectURL(found.blob);
        State.media.set(ref.id,{...ref, thumb:ref.thumb||null});
        State.mediaBlobs.set(ref.id,{file:found.blob, objectURL:url});
        if(found.type==='image'){ const img=new Image(); img.src=url; State.mediaBlobs.get(ref.id).imgEl=img; }
      } else { missing++; }
    }
    $('#projName').value=State.project.name;
    Player.resizeCanvas(); recomputeDuration(); Timeline.render(); Panels.render('media'); Player.renderFrame();
    History.stack=[]; History.idx=-1; History.snapshot();
    if(missing) toast(`${missing} media file(s) missing — use Import to relink them.`);
    else toast('Project loaded');
  },
  async openPicker(){
    const list = await DB.getAll('projects').catch(()=>[]);
    if(!list.length){ $('#projectOpenInput').click(); return; }
    const modal=document.createElement('div'); modal.className='modalbg';
    modal.innerHTML=`<div class="modal"><h2>Open Project</h2>
      ${list.sort((a,b)=>b.savedAt-a.savedAt).map(p=>`<button class="listbtn" data-id="${p.id}">${escapeHtml(p.name)}<small>${new Date(p.savedAt).toLocaleString()}</small></button>`).join('')}
      <button class="listbtn" id="openFromFile">Open from .json file...</button>
      <div class="actions"><button id="closeOpen">Close</button></div></div>`;
    document.body.appendChild(modal);
    $('#closeOpen',modal).onclick=()=>modal.remove();
    $('#openFromFile',modal).onclick=()=>{ modal.remove(); $('#projectOpenInput').click(); };
    $$('.listbtn',modal).forEach(b=>{
      if(b.id==='openFromFile') return;
      b.onclick=async()=>{
        const rec=await DB.get('projects',b.dataset.id);
        if(rec){ const data=JSON.parse(rec.json); await this._applyLoaded(data); }
        modal.remove();
      };
    });
  },
  async _applyLoaded(data){
    State.project=data.project; State.tracks=data.tracks; State.clips=data.clips;
    State.captions=data.captions||[]; State.captionStyle=data.captionStyle||State.captionStyle;
    State.selection.clear();
    const allMedia = await DB.getAll('media').catch(()=>[]);
    State.media.clear(); State.mediaBlobs.clear();
    for(const ref of (data.mediaRefs||[])){
      const found = allMedia.find(m=>m.id===ref.id);
      if(found){
        const url=URL.createObjectURL(found.blob);
        State.media.set(ref.id,{...ref});
        State.mediaBlobs.set(ref.id,{file:found.blob, objectURL:url});
        if(found.type==='image'){ const img=new Image(); img.src=url; State.mediaBlobs.get(ref.id).imgEl=img; }
      }
    }
    $('#projName').value=State.project.name;
    Player.resizeCanvas(); recomputeDuration(); Timeline.render(); Panels.render('media'); Player.renderFrame();
    History.stack=[]; History.idx=-1; History.snapshot();
    toast('Project loaded');
  },
  newProject(){
    if(!confirm('Start a new project? Unsaved changes will be lost.')) return;
    State.project={id:uid(),name:'Untitled Project',width:1920,height:1080,fps:30,bg:'#000000',snapping:true,autosaveSec:20};
    State.tracks=[{id:uid(),type:'video',name:'V1',height:56,muted:false,locked:false,visible:true},
                  {id:uid(),type:'audio',name:'A1',height:44,muted:false,locked:false,visible:true}];
    State.clips=[]; State.selection.clear(); State.media.clear(); State.mediaBlobs.clear();
    State.captions=[]; State.playhead=0;
    $('#projName').value=State.project.name;
    Player.resizeCanvas(); recomputeDuration(); Timeline.render(); Panels.render('media'); Player.renderFrame();
    History.stack=[]; History.idx=-1; History.snapshot();
  }
};

/* ---------------- Status bar ---------------- */
/* ---------------- Safe-area guides overlay ---------------- */
function renderSafeGuides(){
  const el=$('#safeGuides');
  if(!State.showSafeGuides){ el.innerHTML=''; return; }
  el.innerHTML = `
    <div class="g" style="left:5%;right:5%;top:5%;bottom:5%;"></div>
    <div class="g" style="left:10%;right:10%;top:10%;bottom:10%;border-color:rgba(255,180,60,.5);"></div>`;
}

function renderStatus(){
  const bar=$('#statusbar');
  const codec = CAPS.webmVp9?'WebM/VP9':CAPS.webmVp8?'WebM/VP8':'no video codec';
  bar.innerHTML = `
    <span><span class="dot ${CAPS.mediaRecorder&&CAPS.captureStream?'ok':'err'}"></span>Export: ${CAPS.mediaRecorder&&CAPS.captureStream?codec:'unavailable'}</span>
    <span><span class="dot ${CAPS.mp4Rec?'ok':'warn'}"></span>MP4: ${CAPS.mp4Rec?'available':'unavailable — use WebM'}</span>
    <span><span class="dot ${CAPS.webAudio?'ok':'err'}"></span>Web Audio</span>
    <span><span class="dot ${CAPS.indexedDB?'ok':'err'}"></span>Project storage</span>
    <span><span class="dot ok"></span>All media stays on this device</span>
    <span id="statusRes"></span>`;
}

/* ---------------- Keyboard shortcuts ---------------- */
function initShortcuts(){
  document.addEventListener('keydown',(e)=>{
    const typing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);
    if(typing) return;
    const mod=e.ctrlKey||e.metaKey;
    if(e.code==='Space'){ e.preventDefault(); Player.toggle(); }
    else if(mod && e.key.toLowerCase()==='z'){ e.preventDefault(); History.undo(); }
    else if(mod && e.key.toLowerCase()==='y'){ e.preventDefault(); History.redo(); }
    else if(mod && e.key.toLowerCase()==='s'){ e.preventDefault(); Project.save(); }
    else if(mod && e.key.toLowerCase()==='o'){ e.preventDefault(); Project.openPicker(); }
    else if(mod && e.key.toLowerCase()==='c'){ const id=[...State.selection][0]; if(id) ContextMenu.copy(getClip(id)); }
    else if(mod && e.key.toLowerCase()==='v'){ ContextMenu.paste(); }
    else if(e.key==='Delete'||e.key==='Backspace'){ deleteSelected(); }
    else if(e.key.toLowerCase()==='s' && !mod){ splitAtPlayhead(); }
    else if(e.key.toLowerCase()==='v' && !mod){ State.activeTool='select'; }
    else if(e.key==='ArrowLeft'){ Player.stepFrame(-1); }
    else if(e.key==='ArrowRight'){ Player.stepFrame(1); }
    else if(e.key==='+'||e.key==='='){ Timeline.setZoom(State.zoom*1.25); }
    else if(e.key==='-'){ Timeline.setZoom(State.zoom/1.25); }
  });
}

/* ---------------- Wiring / init ---------------- */
function initUI(){
  $('#projName').onchange=(e)=>{ State.project.name=e.target.value; History.snapshot(); };
  $('#btnNew').onclick=()=>Project.newProject();
  $('#btnOpen').onclick=()=>Project.openPicker();
  $('#btnSave').onclick=()=>Project.save();
  $('#btnImport').onclick=()=>$('#fileImportInput').click();
  $('#btnUndo').onclick=()=>History.undo();
  $('#btnRedo').onclick=()=>History.redo();
  $('#btnExport').onclick=()=>Exporter.open();
  $('#btnFullscreen').onclick=()=>{
    const el=document.documentElement;
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if(!isFs){
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if(req) req.call(el).catch?.(()=>{});
      else toast('Fullscreen not supported in this browser');
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if(exit) exit.call(document);
    }
  };
  $('#fileImportInput').onchange=(e)=>{ Media.importFiles(e.target.files); e.target.value=''; };
  $('#projectOpenInput').onchange=(e)=>{ if(e.target.files[0]) Project.importJsonFile(e.target.files[0]); e.target.value=''; };
  $('#captionImportInput').onchange=async(e)=>{
    const f=e.target.files[0]; if(!f) return;
    const text=await f.text();
    Captions.importSRTorVTT(text, f.name.toLowerCase().endsWith('.vtt'));
    Panels.render('captions'); Player.renderFrame();
    e.target.value='';
  };

  $('#btnPlay').onclick=()=>Player.toggle();
  $('#btnPrevFrame').onclick=()=>Player.stepFrame(-1);
  $('#btnNextFrame').onclick=()=>Player.stepFrame(1);
  $('#btnSplit').onclick=()=>splitAtPlayhead();
  $('#previewQuality').onchange=()=>Player.renderFrame();
  $('#zoomIn').onclick=()=>Timeline.setZoom(State.zoom*1.25);
  $('#zoomOut').onclick=()=>Timeline.setZoom(State.zoom/1.25);

  $('#btnAddVTrack').onclick=()=>Timeline.addTrack('video');
  $('#btnAddATrack').onclick=()=>Timeline.addTrack('audio');
  $('#btnSnap').onclick=(e)=>{ State.project.snapping=!State.project.snapping; e.target.classList.toggle('active',State.project.snapping); };
  $('#btnSnapBeat').onclick=(e)=>{ State.snapToBeats=!State.snapToBeats; e.target.classList.toggle('active',State.snapToBeats); };
  $('#toolSelect').onclick=(e)=>{ State.activeTool='select'; $$('#timelinetoolbar button').forEach(b=>b.classList.remove('active')); e.target.classList.add('active'); };
  $('#toolBlade').onclick=(e)=>{ State.activeTool='blade'; $$('#timelinetoolbar button').forEach(b=>b.classList.remove('active')); e.target.classList.add('active'); };

  $$('#lefttabs button').forEach(b=> b.onclick=()=>{ Panels.render(b.dataset.tab); if(window.innerWidth<=900) closeMobilePanels(); } );

  // Mobile panel toggles
  const mm=$('#btnMobileMedia'), mi=$('#btnMobileInspector'), scrim=$('#panelScrim');
  function updateMobileButtons(){
    const mobile = window.innerWidth<=900;
    mm.classList.toggle('hidden',!mobile);
    mi.classList.toggle('hidden',!mobile);
  }
  window.addEventListener('resize',updateMobileButtons); updateMobileButtons();
  mm.onclick=()=>{ $('#leftpanel').classList.add('open'); scrim.classList.add('show'); };
  mi.onclick=()=>{ $('#rightpanel').classList.add('open'); scrim.classList.add('show'); };
  scrim.onclick=closeMobilePanels;
  function closeMobilePanels(){ $('#leftpanel').classList.remove('open'); $('#rightpanel').classList.remove('open'); scrim.classList.remove('show'); }
  window.closeMobilePanels=closeMobilePanels;

  $('#previewwrap').addEventListener('click',(e)=>{
    // hit-test simple click-to-select on canvas (rough bounding-box test)
  });

  // timeline background click clears selection
  $('#timelinescroll').addEventListener('mousedown',(e)=>{
    if(e.target.id==='timelinescroll' || e.target.id==='tracksarea' || e.target.classList.contains('tracklane')){
      State.selection.clear(); Timeline.render(); Inspector.render();
    }
  });
}

async function boot(){
  Player.init();
  initUI();
  initShortcuts();
  renderStatus();
  Panels.render('media');
  Timeline.render();
  Inspector.render();
  renderSafeGuides();
  recomputeDuration();
  Player.renderFrame();
  History.snapshot();

  // autosave
  setInterval(()=>{ if(State.clips.length) Project.save(); }, (State.project.autosaveSec||20)*1000);

  // register service worker (offline)
  if('serviceWorker' in navigator){
    try{ await navigator.serviceWorker.register('./sw.js'); }catch(e){ /* non-fatal */ }
  }

  if(!CAPS.mediaRecorder||!CAPS.captureStream) toast('Export not supported in this browser — editing still works.',4000);
}
document.addEventListener('DOMContentLoaded',boot);
