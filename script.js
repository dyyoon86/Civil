/* ===== State & helpers ===== */
const el = id => document.getElementById(id);
const ENVS = ['dev','test','prod'];
const state = { dev:null, test:null, prod:null };         // Map<normalizedPath, rec>
const rawText = { dev:null, test:null, prod:null };       // 원본 텍스트 저장
let currentRoot = null;
let commonPrefix = '/';
let diffIndex = { size:new Set(), hash:new Set(), both:new Set() };
let IGNORE_EXTS = ['.java'];
let SFTP_CONF = { profiles: [] };

/* 접두 정규화 규칙 (운영만 CLU_SBM_ → SBM_) */
const PREFIX_RULES = [ { env: 'prod', regex: /(^|\/)CLU_SBM_/g, replacement: '$1SBM_' } ];
function normalizePath(path, env) {
  let p = path;
  for (const rule of PREFIX_RULES) if (rule.env === env) p = p.replace(rule.regex, rule.replacement);
  return p;
}

/* 제외 확장자 */
function parseIgnoreExtsInput() {
  const val = (el('ignore-exts').value || '').split(',').map(s=>s.trim()).filter(Boolean);
  IGNORE_EXTS = val.length ? val : [];
}
function shouldIgnore(path) {
  const lower = path.toLowerCase();
  return IGNORE_EXTS.some(ext => lower.endsWith(ext.trim().toLowerCase()));
}

/* tolerant parser */
function parseScanResult(text, env) {
  if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let raw of lines) {
    if (!raw) continue;
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let parts = line.includes('|') ? line.split('|') : line.split(/\s+/);
    let path = (parts[0] || '').trim().replace(/\\/g, '/');
    if (!path) continue;

    const normPathForIgnore = normalizePath(path, env);
    if (shouldIgnore(normPathForIgnore)) continue;

    const cleanNum = v => (v || '').toString().replace(/,/g, '');
    let size = parts[1] ? Number(cleanNum(parts[1])) : null;
    let mtime = null;
    if (parts[2]) {
      const t = cleanNum(parts[2]).trim();
      const dot = t.indexOf('.');
      mtime = dot >= 0 ? Number(t.slice(0, dot)) : Number(t);
      if (!isFinite(mtime)) mtime = null;
    }
    let sha7 = parts[3] ? String(parts[3]).trim() : null;
    rows.push({ path, size, mtime, sha7 });
  }
  return rows;
}
function fileToMap(rows, env){
  const m = new Map();
  for (const r of rows) {
    const norm = normalizePath(r.path, env);
    m.set(norm, { ...r, normPath: norm, envOriginalPath: r.path });
  }
  return m;
}
async function loadFileToEnv(file, env) {
  const text = await file.text();
  rawText[env] = text;
  const rows = parseScanResult(text, env);
  console.log(`[${env}] parsed lines = ${rows.length}`);
  state[env] = fileToMap(rows, env);
  recalcPrefixAndRebuild();
}
function reparseAllWithCurrentIgnores() {
  for (const env of ENVS) {
    const t = rawText[env];
    if (!t) continue;
    const rows = parseScanResult(t, env);
    state[env] = fileToMap(rows, env);
  }
  recalcPrefixAndRebuild();
}

/* 공통 접두 */
function allPathsUnion() {
  const set = new Set();
  for (const env of ENVS) { const m = state[env]; if (!m) continue; for (const p of m.keys()) set.add(p); }
  return Array.from(set.values());
}
function normalizeDirPrefix(p) { if (!p) return ''; let s=p.trim(); if (!s.startsWith('/')) s='/'+s; s=s.replace(/\/+$/,''); return s||'/'; }
function calcCommonDirPrefix(paths) {
  if (!paths || paths.length===0) return '/';
  const splitAll = paths.map(p => p.replace(/^\/+/,'').split('/'));
  const minLen = Math.min.apply(null, splitAll.map(a=>a.length));
  const out = [];
  for (let i=0; i<minLen-1; i++) { const seg = splitAll[0][i]; if (splitAll.every(a => a[i] === seg)) out.push(seg); else break; }
  return '/' + out.join('/');
}
function stripPrefix(path, prefix) {
  const pre = normalizeDirPrefix(prefix);
  if (pre==='/' || !path.startsWith(pre + '/')) return path;
  return path.slice(pre.length);
}

/* diff (null도 차이로 간주) */
function buildDiffIndex() {
  diffIndex = { size:new Set(), hash:new Set(), both:new Set() };
  const loaded = ENVS.filter(e => state[e] && state[e].size > 0);
  if (loaded.length < 2) { el('c-hash').textContent=0; el('c-size').textContent=0; el('c-both').textContent=0; return; }
  const paths = allPathsUnion();
  for (const path of paths) {
    const values = loaded.map(env => {
      const rec = state[env].get(path);
      return { env, size: rec ? rec.size : null, sha: rec ? rec.sha7 : null };
    });
    const sizeSet = new Set(values.map(v => v.size !== null ? v.size : 'null'));
    const hashSet = new Set(values.map(v => v.sha  !== null ? v.sha  : 'null'));
    const sizeDiff = sizeSet.size > 1;
    const hashDiff = hashSet.size > 1;
    if (sizeDiff && hashDiff) diffIndex.both.add(path);
    else if (hashDiff)        diffIndex.hash.add(path);
    else if (sizeDiff)        diffIndex.size.add(path);
  }
  el('c-hash').textContent = diffIndex.hash.size;
  el('c-size').textContent = diffIndex.size.size;
  el('c-both').textContent = diffIndex.both.size;
}
function selectedDiffSets() {
  const s = new Set();
  if (el('f-hash').checked) for (const p of diffIndex.hash) s.add(p);
  if (el('f-size').checked) for (const p of diffIndex.size) s.add(p);
  if (el('f-both').checked) for (const p of diffIndex.both) s.add(p);
  return s;
}
function isFiltering(){ return el('f-hash').checked || el('f-size').checked || el('f-both').checked; }
function filteredPathsUnion(){
  const all = allPathsUnion();
  if (!isFiltering()) return all;
  const sel = selectedDiffSets();
  return all.filter(p => sel.has(p));
}

/* KST time, size */
function isoTime(epochSec){
  try {
    const d = new Date(epochSec * 1000);
    const offset = 9 * 60 * 60000; // +9h
    const local = new Date(d.getTime() + offset);
    const pad = n => String(n).padStart(2,'0');
    return `${local.getUTCFullYear()}-${pad(local.getUTCMonth()+1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} KST`;
  } catch(e){ return String(epochSec); }
}
function humanSize(n){ let x=Number(n||0),u=0; const units=['B','KB','MB','GB','TB']; while(x>=1024 && u<units.length-1){x/=1024;u++;} return `${x.toFixed(1)} ${units[u]}`; }

/* search highlight */
function highlightAndOpen(container, q){
  container.querySelectorAll('.name').forEach(n=>{
    const t=n.textContent.toLowerCase();
    if(t.includes(q)){ let cur=n.closest('.node'); while(cur){cur.classList.add('open'); cur=cur.parentElement.closest('.node');} n.parentElement.classList.add('selected'); }
  });
}

/* wrap view + copy 1-line */
function wrapPathForView(raw){ return String(raw||'').replace(/\//g, '/<wbr>'); }
function setWrappedCopyable(elm, rawPath){
  elm.innerHTML = wrapPathForView(rawPath || '');
  elm.classList.add('wrap2','path-mono');
  elm.dataset.raw = rawPath || '';
  elm.oncopy = (e)=>{ try{ e.clipboardData.setData('text/plain', elm.dataset.raw); e.preventDefault(); }catch(_){} };
}

/* details */
function clearDetails(){
  const P = el('d-path'); P.textContent='트리에서 파일을 클릭하세요'; P.classList.add('muted');
  const F = el('d-full'); F.textContent='-'; F.classList.add('muted');
  el('env-table').style.display='none';
  el('env-table').querySelector('tbody').innerHTML='';
}
function buildDiffTooltip(normPath) {
  const parts = [];
  for (const env of ENVS) {
    const r = state[env]?.get(normPath);
    if (!r) continue;
    const size = (r.size!=null && isFinite(r.size)) ? r.size : '-';
    const sha  = r.sha7 || '-';
    parts.push(`${env.toUpperCase()}: size=${size}, sha=${sha}`);
  }
  return parts.join(' | ');
}
function showDetailsForPath(normPath){
  const selPath = stripPrefix(normPath, commonPrefix) || '/';
  const dp = document.getElementById('d-path'); dp.classList.remove('muted'); setWrappedCopyable(dp, selPath);
  const df = document.getElementById('d-full'); df.classList.remove('muted'); setWrappedCopyable(df, normPath);

  const tbody = el('env-table').querySelector('tbody'); tbody.innerHTML = '';
  let any=false;

  for (const env of ENVS) {
    const rec = state[env]?.get(normPath);
    const tr = document.createElement('tr');
    const tdEnv = document.createElement('td'); tdEnv.textContent = env.toUpperCase();

    if (rec) {
      const tdPath= document.createElement('td'); tdPath.className = 'path-wrap';
      const displayPath = (env === 'prod') ? (rec.envOriginalPath || rec.normPath) : rec.normPath;
      setWrappedCopyable(tdPath, displayPath);

      const tdSize= document.createElement('td'); tdSize.innerHTML =
        (rec.size!=null && isFinite(rec.size)) ? `${rec.size.toLocaleString()} <span class="pill">${humanSize(rec.size)}</span>` : '-';

      const tdTime= document.createElement('td'); tdTime.textContent = rec.mtime ? `${isoTime(rec.mtime)} (${rec.mtime})` : '-';
      const tdHash= document.createElement('td'); tdHash.textContent = rec.sha7 || '-';

      const tdActions = document.createElement('td');
      const mkBtn = (label)=>{ const b=document.createElement('button'); b.className='btn'; b.style.padding='4px 8px'; b.textContent=label; return b; };

      const bMeta = mkBtn('SFTP 메타');
      bMeta.addEventListener('click', ()=>{
        const targetPath = displayPath;
        openSftpModal({
          env, path: targetPath,
          onMeta: (res) => {
            tdSize.innerHTML = (res.size!=null)
              ? `${Number(res.size).toLocaleString()} <span class="pill">${humanSize(res.size)}</span>` : '-';
            tdTime.textContent = res.mtimeEpoch ? `${isoTime(res.mtimeEpoch)} (${res.mtimeEpoch})` : '-';
            tdHash.textContent = res.sha ? (res.sha.substring(0,7)) : '-';
            const m = state[env]; if (m) {
              const old = m.get(normPath) || {};
              m.set(normPath, { ...old,
                size: (res.size!=null) ? Number(res.size) : old.size,
                mtime: (res.mtimeEpoch!=null) ? Number(res.mtimeEpoch) : old.mtime,
                sha7: res.sha ? res.sha.substring(0,7) : old.sha7,
                envOriginalPath: (env==='prod') ? targetPath : old.envOriginalPath,
                normPath: old.normPath || normPath
              });
              buildDiffIndex();
            }
          }
        });
      });

      const bDl = mkBtn('SFTP 다운로드');
      bDl.addEventListener('click', ()=>{
        const targetPath = displayPath;
        openSftpModal({ env, path: targetPath, onMeta:null });
      });

      tdActions.appendChild(bMeta);
      tdActions.appendChild(bDl);

      tr.appendChild(tdEnv); tr.appendChild(tdPath); tr.appendChild(tdSize); tr.appendChild(tdTime); tr.appendChild(tdHash); tr.appendChild(tdActions);
      any=true;
    } else {
      tr.innerHTML = `<td>${env.toUpperCase()}</td><td colspan="5" class="warn">해당 경로 없음</td>`;
      any=true;
    }
    tbody.appendChild(tr);
  }
  el('env-table').style.display = any ? 'table' : 'none';
}

/* render */
function rebuildTree() {
  buildDiffIndex();
  const paths = filteredPathsUnion();
  if (paths.length === 0) {
    const reason = isFiltering() ? '선택된 차이에 해당하는 파일이 없습니다.' : '업로드/로드된 경로가 없습니다. (또는 모두 제외됨)';
    el('tree').innerHTML = `<div style="padding:10px;color:#9aa3af">${reason}</div>`;
    el('stats').textContent = '';
    clearDetails();
    return;
  }
  const root = buildTreeFromUnion(paths, commonPrefix);
  currentRoot = root;
  const {folders, files} = countTree(root);
  el('stats').textContent =
    `공통 접두: ${commonPrefix} · 폴더 ${folders} · 파일 ${files} (DEV:${state.dev?state.dev.size:0}, TEST:${state.test?state.test.size:0}, PROD:${state.prod?state.prod.size:0})`;
  renderTree(root, el('tree'), {openDepth:1, filter:el('q').value});
  clearDetails();
}
function buildTreeFromUnion(paths, prefix) {
  const root = { name:'(root)', path:'/', children:new Map(), files:new Map() };
  for (const full of paths) {
    const rel = stripPrefix(full, prefix).replace(/^\/+/, '');
    const parts = rel.split('/');
    let cur = root, curPath = '';
    for (let i=0;i<parts.length;i++){
      const seg = parts[i];
      const isLast = i===parts.length-1;
      if (isLast){
        cur.files.set(seg, full);
      } else {
        if (!cur.children.has(seg)){
          const np = curPath ? (curPath + '/' + seg) : seg;
          cur.children.set(seg, { name: seg, path:'/' + np, children:new Map(), files:new Map() });
        }
        curPath = curPath ? (curPath + '/' + seg) : seg;
        cur = cur.children.get(seg);
      }
    }
  }
  return root;
}
function countTree(node){ let folders=node.children.size, files=node.files.size; for(const ch of node.children.values()){const c=countTree(ch); folders+=c.folders; files+=c.files;} return {folders,files}; }
function renderTree(root, container, {openDepth=1, filter=''} = {}) {
  container.innerHTML='';
  const frag = document.createDocumentFragment();
  frag.appendChild(renderNode(root, true, 0));
  container.appendChild(frag);
  container.querySelectorAll('.node[data-depth]').forEach(n=>{
    const d=Number(n.getAttribute('data-depth')); if(d<=openDepth) n.classList.add('open');
  });
  if(filter){ highlightAndOpen(container, filter.toLowerCase()); }
}
function renderNode(node, isRoot, depth) {
  const nodeEl = document.createElement('div');
  nodeEl.className='node folder';
  nodeEl.setAttribute('data-depth', depth);

  const header = document.createElement('div'); header.className='rowline';
  const disc = document.createElement('div'); disc.className='disclosure'; disc.title='펼치기/접기';
  const icon = document.createElement('div'); icon.className='icon'; icon.textContent = isRoot ? '📁':'📂';
  const name = document.createElement('div'); name.className='name'; name.textContent = isRoot ? '(root)' : node.name;
  const badge = document.createElement('span'); badge.className='badge'; badge.textContent = String(node.children.size + node.files.size);
  header.appendChild(disc); header.appendChild(icon); header.appendChild(name); header.appendChild(badge);
  header.addEventListener('click', (e)=>{ if(e.target===disc) return; nodeEl.classList.toggle('open'); });
  disc.addEventListener('click', (e)=>{ e.stopPropagation(); nodeEl.classList.toggle('open'); });

  const childrenWrap = document.createElement('div'); childrenWrap.className='children';

  const folderNames = Array.from(node.children.keys()).sort((a,b)=>a.localeCompare(b));
  for (const nm of folderNames) childrenWrap.appendChild(renderNode(node.children.get(nm),false,depth+1));

  const fileNames = Array.from(node.files.keys()).sort((a,b)=>a.localeCompare(b));
  for (const fn of fileNames) {
    const normFullPath = node.files.get(fn);
    const fileEl = document.createElement('div'); fileEl.className='node file'; fileEl.setAttribute('data-depth', depth+1);
    const row = document.createElement('div'); row.className='rowline';
    const d2 = document.createElement('div'); d2.className='disclosure'; d2.style.visibility='hidden';
    const ic = document.createElement('div'); ic.className='icon'; ic.textContent='📄';
    const nm = document.createElement('div'); nm.className='name'; nm.textContent=fn; nm.title=normFullPath;

    const sizeDiff = diffIndex.size.has(normFullPath);
    const hashDiff = diffIndex.hash.has(normFullPath);
    const bothDiff = diffIndex.both.has(normFullPath);
    if (bothDiff)      fileEl.classList.add('diff-both');
    else if (hashDiff) fileEl.classList.add('diff-hash');
    else if (sizeDiff) fileEl.classList.add('diff-size');
    if (sizeDiff || hashDiff || bothDiff) nm.title = buildDiffTooltip(normFullPath);

    row.appendChild(d2); row.appendChild(ic); row.appendChild(nm);
    row.addEventListener('click', ()=>{
      showDetailsForPath(normFullPath);
      document.querySelectorAll('.selected').forEach(e=>e.classList.remove('selected'));
      fileEl.classList.add('selected');
    });
    fileEl.appendChild(row);
    childrenWrap.appendChild(fileEl);
  }

  nodeEl.appendChild(header); nodeEl.appendChild(childrenWrap);
  return nodeEl;
}

/* CSV Export */
function csvEscape(v){ if (v===null||v===undefined) return ''; const s=String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; }
function toCSV(rows){ return rows.map(r => r.map(csvEscape).join(',')).join('\n'); }
function downloadCSV(filename, csvText){
  const blob = new Blob(["\uFEFF"+csvText], { type: "text/csv;charset=utf-8;" }); // BOM for Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function buildExportRows({onlyFiltered=false} = {}){
  const header = [
    'relative_path_after_prefix', 'normalized_full_path',
    'DEV_size','DEV_mtime_kst','DEV_mtime_epoch','DEV_sha','DEV_original_path',
    'TEST_size','TEST_mtime_kst','TEST_mtime_epoch','TEST_sha','TEST_original_path',
    'PROD_size','PROD_mtime_kst','PROD_mtime_epoch','PROD_sha','PROD_original_path',
    'diff_size','diff_hash','diff_both'
  ];
  const rows = [header];
  const paths = (onlyFiltered ? filteredPathsUnion() : allPathsUnion()).sort((a,b)=>a.localeCompare(b));
  for (const p of paths){
    const rel = stripPrefix(p, commonPrefix) || '/';
    const get = (env) => state[env]?.get(p) || null;
    const dev = get('dev'), test = get('test'), prod = get('prod');
    rows.push([
      rel, p,
      dev?.size ?? '', dev?.mtime ? isoTime(dev.mtime) : '', dev?.mtime ?? '', dev?.sha7 ?? '', dev?.envOriginalPath ?? '',
      test?.size ?? '', test?.mtime ? isoTime(test.mtime) : '', test?.mtime ?? '', test?.sha7 ?? '', test?.envOriginalPath ?? '',
      prod?.size ?? '', prod?.mtime ? isoTime(prod.mtime) : '', prod?.mtime ?? '', prod?.sha7 ?? '', prod?.envOriginalPath ?? '',
      diffIndex.size.has(p) ? 'Y' : '', diffIndex.hash.has(p) ? 'Y' : '', diffIndex.both.has(p) ? 'Y' : ''
    ]);
  }
  return rows;
}

/* conf 불러오기 */
async function loadSftpConf() {
  try {
    const r = await fetch('/api/conf/sftp', { cache: 'no-store' });
    if (!r.ok) throw new Error('conf fetch ' + r.status);
    const j = await r.json();
    SFTP_CONF = j && j.profiles ? j : { profiles: [] };
  } catch (e) {
    console.warn('SFTP conf load failed:', e);
    SFTP_CONF = { profiles: [] };
  }
}

/* SFTP modal & calls (relative URL) */
function openSftpModal({ env, path, onMeta }) {
  const M = document.getElementById('sftp-modal');
  const set = (id,v)=>document.getElementById(id).value=v??'';
  set('sf-env', env.toUpperCase());
  set('sf-path', path);
  document.getElementById('sf-msg').textContent = '';
  M.style.display='flex';

  // 프로필 드롭다운 채우기 (env 필터)
  const sel = document.getElementById('sf-profile');
  sel.innerHTML = '<option value="">직접 입력</option>';
  const list = (SFTP_CONF.profiles || []).filter(p => (p.env||'').toLowerCase() === env.toLowerCase());
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.name || `${p.host}:${p.port||22}`;
    opt.textContent = p.name ? `${p.name} (${p.host}:${p.port||22})` : `${p.host}:${p.port||22}`;
    opt.dataset.host = p.host || '';
    opt.dataset.port = (p.port!=null ? String(p.port) : '22');
    opt.dataset.user = p.username || '';
    sel.appendChild(opt);
  }
  sel.onchange = () => {
    const o = sel.options[sel.selectedIndex];
    if (!o || !o.dataset) return;
    if (o.value === '') return; // 직접 입력
    document.getElementById('sf-host').value = o.dataset.host || '';
    document.getElementById('sf-port').value = o.dataset.port || '22';
    document.getElementById('sf-user').value = o.dataset.user || '';
  };

  const close = ()=>{ M.style.display='none'; };
  document.getElementById('sf-cancel').onclick = close;

  const readInput = () => ({
    host: document.getElementById('sf-host').value.trim(),
    port: Number(document.getElementById('sf-port').value.trim()||'22'),
    username: document.getElementById('sf-user').value.trim(),
    password: document.getElementById('sf-pass').value,
    path
  });

  document.getElementById('sf-stat').onclick = async ()=>{
    const body = { ...readInput(), env };
    if(!body.host || !body.username || !body.password){ document.getElementById('sf-msg').textContent='접속 정보를 입력하세요.'; return; }
    document.getElementById('sf-msg').textContent='메타 조회 중...';
    try{
      const r = await fetch('/api/sftp/stat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if(!r.ok) throw new Error(await r.text());
      const res = await r.json(); // {size, mtimeEpoch, sha, sha7, updated}
      document.getElementById('sf-msg').textContent = res.updated ? '완료 (out.txt 반영됨)' : '완료';
      if (onMeta) onMeta(res);
    }catch(e){
      document.getElementById('sf-msg').textContent='오류: ' + e.message;
    }
  };

  document.getElementById('sf-download').onclick = async ()=>{
    const body = readInput();
    if(!body.host || !body.username || !body.password){ document.getElementById('sf-msg').textContent='접속 정보를 입력하세요.'; return; }
    document.getElementById('sf-msg').textContent='다운로드 중...';
    try{
      const r = await fetch('/api/sftp/download', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if(!r.ok) throw new Error(await r.text());
      const blob = await r.blob();
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      const fname = body.path.split('/').pop() || 'download.bin';
      a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      document.getElementById('sf-msg').textContent='다운로드 완료';
    }catch(e){
      document.getElementById('sf-msg').textContent='오류: ' + e.message;
    }
  };
}

/* wiring */
function bindFileInput(id, env){ el(id).addEventListener('change', e=>{ const f=e.target.files?.[0]; if(f) loadFileToEnv(f, env); }); }
bindFileInput('file-dev','dev'); bindFileInput('file-test','test'); bindFileInput('file-prod','prod');

const drop = el('drop');
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault(); drop.classList.add('dragover');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault(); drop.classList.remove('dragover');}));
drop.addEventListener('drop', e=>{
  e.preventDefault(); drop.classList.remove('dragover');
  const files = e.dataTransfer.files;
  for (const f of files) {
    const name=f.name.toLowerCase();
    if (name.includes('prod')) loadFileToEnv(f,'prod');
    else if (name.includes('test')) loadFileToEnv(f,'test');
    else if (name.includes('dev')) loadFileToEnv(f,'dev');
    else if (!state.dev) loadFileToEnv(f,'dev');
    else if (!state.test) loadFileToEnv(f,'test');
    else loadFileToEnv(f,'prod');
  }
});

el('btn-expand').addEventListener('click', ()=> document.querySelectorAll('.tree .node').forEach(n=>n.classList.add('open')));
el('btn-collapse').addEventListener('click', ()=> document.querySelectorAll('.tree .node').forEach(n=>n.classList.remove('open')));
el('q').addEventListener('input', ()=>{ if(!currentRoot) return; renderTree(currentRoot, el('tree'), {openDepth:0, filter:el('q').value}); });

el('btn-clear').addEventListener('click', ()=>{
  for (const env of ENVS){ state[env]=null; rawText[env]=null; }
  el('file-dev').value=''; el('file-test').value=''; el('file-prod').value='';
  el('tree').innerHTML=''; el('stats').textContent=''; clearDetails();
  el('prefix').value=''; el('auto-prefix').checked=true; commonPrefix='/'; el('prefix-show').textContent='/';
  diffIndex={size:new Set(),hash:new Set(),both:new Set()};
  el('f-hash').checked=false; el('f-size').checked=false; el('f-both').checked=false;
  el('c-hash').textContent='0'; el('c-size').textContent='0'; el('c-both').textContent='0';
});

['f-hash','f-size','f-both'].forEach(id => el(id).addEventListener('change', rebuildTree));
el('auto-prefix').addEventListener('change', recalcPrefixAndRebuild);
el('prefix').addEventListener('change', ()=>{ el('auto-prefix').checked=false; recalcPrefixAndRebuild(); });
el('btn-apply-ignore').addEventListener('click', ()=>{ parseIgnoreExtsInput(); reparseAllWithCurrentIgnores(); });

document.getElementById('btn-export-all').addEventListener('click', ()=>{ buildDiffIndex(); const rows = buildExportRows({onlyFiltered:false}); downloadCSV(`scan_export_all_${Date.now()}.csv`, toCSV(rows)); });
document.getElementById('btn-export-filtered').addEventListener('click', ()=>{ buildDiffIndex(); const rows = buildExportRows({onlyFiltered:true});  downloadCSV(`scan_export_filtered_${Date.now()}.csv`, toCSV(rows)); });

function recalcPrefixAndRebuild() {
  if (el('auto-prefix').checked) {
    const paths = allPathsUnion();
    commonPrefix = calcCommonDirPrefix(paths) || '/';
    el('prefix').value = commonPrefix;
  } else {
    const user = normalizeDirPrefix(el('prefix').value);
    commonPrefix = user || '/';
  }
  el('prefix-show').textContent = commonPrefix;
  rebuildTree();
}

/* ---- WAS에서 자동 로드: /data/dev|tst|opt/out.txt ---- */
async function fetchText(url){ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error(url+': '+r.status); return r.text(); }
async function loadFixed(){
  try{
    const dev = await fetchText('/data/dev/out.txt');
    rawText.dev = dev; state.dev = fileToMap(parseScanResult(dev,'dev'),'dev');
  }catch(_){}
  try{
    const tst = await fetchText('/data/tst/out.txt');
    rawText.test = tst; state.test = fileToMap(parseScanResult(tst,'test'),'test');
  }catch(_){}
  try{
    const opt = await fetchText('/data/opt/out.txt');
    rawText.prod = opt; state.prod = fileToMap(parseScanResult(opt,'prod'),'prod');
  }catch(_){}
  recalcPrefixAndRebuild();
}

window.addEventListener('load', async () => {
  await loadSftpConf();
  await loadFixed();
});
