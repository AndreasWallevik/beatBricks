import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, rectSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import confetti from "canvas-confetti";
import "./index.css";

// AUTH
import { auth, db, provider } from "./lib/firebase";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, serverTimestamp, query, orderBy } from "firebase/firestore";


// BeatBricks – Music Project Board
// Fix: clipboard permission errors are now safely caught with graceful fallbacks.
// Extras: immutable updates in editor, debounced save, tighter memoization, self-tests.

// ✅ FIX: REMOVE UNDEFINED KEYS SO UPDATE DOESN'T NUKE FIELDS
function pruneUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

const STORAGE_KEY = "beatbricks.v2";
const SUGGESTED = ["Draft","Write lyrics","Polish lyrics","Record vocals","Mix","Master"]; 
const COLORS = ["#7c3aed","#10b981","#f59e0b","#ef4444","#06b6d4","#22c55e","#eab308","#f97316"]; 
const EMOJIS = ["🎧","🎵","🎶","🎤","🎛️","🚀","✨","🔥","⭐","🧠","📝","🎯","🌈","💎","💡"]; 
const uid = () => Math.random().toString(36).slice(2,9);

function load() { try { const j = localStorage.getItem(STORAGE_KEY); return j ? JSON.parse(j) : null; } catch { return null; } }
function save(data) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {} }

function calcProjectProgress(p){ const t=p.tasks?.length||0; const d=p.tasks?.filter(x=>x.done).length||0; return t?Math.round((d*100)/t):0; }
function calcXP(projects){ const done=projects.flatMap(p=>p.tasks||[]).filter(t=>t.done).length; const xp=done*10; const level=Math.floor(xp/100)+1; return {xp,level,pct:xp%100}; }

// --- Utilities: color + clipboard-safe path open ---
function shadeColor(hex, amt){ try{ const h=hex.replace('#',''); const v=parseInt(h.length===3?h.split('').map(c=>c+c).join(''):h,16); let r=(v>>16)&255,g=(v>>8)&255,b=v&255; r=Math.min(255,Math.max(0,r+Math.round(2.55*amt))); g=Math.min(255,Math.max(0,g+Math.round(2.55*amt))); b=Math.min(255,Math.max(0,b+Math.round(2.55*amt))); return '#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join(''); }catch{return hex;} }

async function copyToClipboard(text){
  // Try new Clipboard API in secure contexts
  try { if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); return true; } } catch {}
  // Fallback: execCommand('copy') using a hidden textarea
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); document.body.removeChild(ta);
    if (ok) return true;
  } catch {}
  // Last resort: show prompt so user can copy manually
  try { window.prompt('Copy to clipboard:', text); return true; } catch {}
  return false;
}

async function tryOpenPath(path){
  if(!path) return false;
  // 1) Native (Electron/Tauri) if available
  try{ const shell = (window).electron?.shell; if (shell?.openPath) { await shell.openPath(path); return true; } }catch{}
  // 2) Attempt file:// open (may be blocked in some browsers)
  try{ const url = path.startsWith("file://") ? path : ("file:///"+path.replaceAll("\\","/")); const win = window.open(url, "_blank"); if (win) return true; }catch{}
  // 3) Copy path as a safe fallback (no crash if permissions policy blocks clipboard)
  const copied = await copyToClipboard(path);
  if (copied) alert("Path copied to clipboard:\n" + path);
  else alert("Could not open or copy the path. Please copy it manually:\n" + path);
  return copied;
}

// --- App state with demo seed + debounced save ---

/*
function useAppState(){
  const seed = {
    projects: [
      { id: uid(), name: "Midnight Drive", type:"Single", note:"Synthwave", emoji:"🎧", color: COLORS[0], priority: 3,
        path: "C\\\\Users\\\\you\\\\Music\\\\MidnightDrive",
        links:[{label:"SoundCloud", url:"https://soundcloud.com/"}],
        tasks:[{id:uid(), title:"Draft", done:true},{id:uid(), title:"Write lyrics", done:false},{id:uid(), title:"Record vocals", done:false},{id:uid(), title:"Mix", done:false}] },
      { id: uid(), name: "Ocean Echoes", type:"Beat", note:"Lo‑fi", emoji:"🌊", color: COLORS[3], priority: 2,
        path: "D\\\\Projects\\\\OceanEchoes",
        links:[{label:"Lyrics", url:"https://docs.google.com/"}],
        tasks:[{id:uid(), title:"Draft", done:false}] },
    ]
  };
  const [state, setState] = useState(()=> load() ?? seed);
  useEffect(()=>{ const id=setTimeout(()=>save(state),250); return ()=>clearTimeout(id); },[state]);
  return [state, setState];
}
*/

function useFirebaseState() {
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState([]);

  // auth state
  useEffect(() => onAuthStateChanged(auth, setUser), []);

  // live projects
  useEffect(() => {
    if (!user) { setProjects([]); return; }
    const q = query(collection(db, `users/${user.uid}/projects`), orderBy("order","asc"));
    return onSnapshot(q, snap => setProjects(snap.docs.map(d => d.data())));
  }, [user]);

  // --- CRUD (each function is top-level; none are nested inside another) ---

  // ✅ FIX: NEW PROJECT GETS AN ORDER INDEX; PRIORITY STAYS (0–3)
  const addProject = useCallback(async () => {
    if (!user) return;
    const p = {
      id: crypto.randomUUID(),
      name: "New project",
      type: "", note: "",
      emoji: "🎧",
      color: "#7c3aed",
      accent: "#00000000", // transparent by default
      label: "",           // optional tag (shown if present)
      group: "",           // optional “project group”
      priority: 2,            // 0 None, 1 Low, 2 Med, 3 High
      order: projects.length, // 👈 used for manual sort
      //path: "",
      links: [],
      tasks: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, `users/${user.uid}/projects/${p.id}`), p);
  }, [user, projects.length]);

  const cloneProject = useCallback(async (id) => {
    if (!user) return;
    const src = projects.find(p => p.id === id);
    if (!src) return;

    // reset progress on clone (make all tasks undone). Change if you prefer to keep done state.
    const tasks = (src.tasks || []).map(t => ({ ...t, done: false }));

    const clone = {
      ...src,
      id: crypto.randomUUID(),
      name: `${src.name} (copy)`,
      order: projects.length,
      accent: "#00000000", // transparent by default
      label: "",           // optional tag (shown if present)
      group: "",           // optional “project group”
      tasks,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(doc(db, `users/${user.uid}/projects/${clone.id}`), clone);
  }, [user, projects]);

  // ✅ FIX: SAFE MERGE PATCH INTO DOC (NO UNDEFINED)
  const updateProject = useCallback(async (patch) => {
    if (!user || !patch?.id) return;
    const { id, ...rest } = patch;
    const clean = pruneUndefined(rest);
    if (!Object.keys(clean).length) return;
    await updateDoc(doc(db, `users/${user.uid}/projects/${id}`), clean);
  }, [user]);


  const deleteProject = useCallback(async (id) => {
    if (!user) return;
    await deleteDoc(doc(db, `users/${user.uid}/projects/${id}`));
  }, [user]);

  // tasks / links
  const toggleTask = useCallback(async (pid, tid) => {
    const p = projects.find(x => x.id === pid); if (!p) return;
    const tasks = (p.tasks || []).map(t => t.id === tid ? { ...t, done: !t.done } : t);
    await updateProject({ id: pid, tasks });
  }, [projects, updateProject]);

  const addTask = useCallback(async (pid, title) => {
    const p = projects.find(x => x.id === pid); if (!p) return;
    const tasks = [...(p.tasks || []), { id: crypto.randomUUID(), title, done: false }];
    await updateProject({ id: pid, tasks });
  }, [projects, updateProject]);

  // ✅ FIX: ONLY PATCH THE TASKS ARRAY; NOTHING ELSE CHANGES
  const addSuggested = useCallback(async (pid) => {
    const p = projects.find(x => x.id === pid); 
    if (!p) return;
    const tasks = [...(p.tasks || [])];
    SUGGESTED.forEach(st => {
      if (!tasks.some(t => t.title.toLowerCase() === st.toLowerCase())) {
        tasks.push({ id: crypto.randomUUID(), title: st, done: false });
      }
    });
    await updateProject({ id: pid, tasks }); // 👈 only tasks field gets updated
  }, [projects, updateProject]);


  const addLink = useCallback(async (pid) => {
    const p = projects.find(x => x.id === pid); if (!p) return;
    const links = [...(p.links || []), { label: "Link", url: "https://" }];
    await updateProject({ id: pid, links });
  }, [projects, updateProject]);

  const changeColor = useCallback(async (pid) => {
    const p = projects.find(x => x.id === pid); if (!p) return;
    const COLORS = ["#7c3aed","#10b981","#f59e0b","#ef4444","#06b6d4","#22c55e","#eab308","#f97316"];
    await updateProject({ id: pid, color: COLORS[(Math.random()*COLORS.length)|0] });
  }, [projects, updateProject]);

  return {
    user, projects,
    addProject, cloneProject, updateProject, deleteProject,
    toggleTask, addTask, addSuggested, addLink, changeColor,
  };
}



// --- DnD brick wrapper ---
function SortableBrick({ id, span=1, children }){
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className={`touch-none ${isDragging?"z-10 scale-[1.02]":""}`}>
      <div style={{ gridColumn: `span ${span} / span ${span}` }}>{children}</div>
    </div>
  );
}

// --- Brick card ---
function Brick({ p, user, onOpen, onToggleTask, onDelete, onClone, onColor }){
  const progress = calcProjectProgress(p);
  const allDone = progress===100 && (p.tasks?.length>0);
  const celebrated = useRef(new Set());
  useEffect(()=>{ if(allDone && !celebrated.current.has(p.id)){ confetti({particleCount:120, spread:70, origin:{y:0.4}}); celebrated.current.add(p.id); } },[allDone, p.id]);
  const c1=p.color; const c2=shadeColor(p.color,-35);
  const stop=useCallback(e=>e.stopPropagation(),[]);
  const visibleTasks = useMemo(()=>{ const undone=(p.tasks||[]).filter(t=>!t.done); const done=(p.tasks||[]).filter(t=>t.done); return [...undone,...done].slice(0,4); },[p.tasks]);
  
  {p.label && (
    <div className="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded-full bg-black/40">
      {p.label}
    </div>
  )}

  return (
    <div 
      onClick={()=>onOpen(p.id)} 
      className="relative aspect-square rounded-2xl shadow-lg text-white overflow-hidden cursor-pointer transition-transform hover:-translate-y-0.5 hover:shadow-2xl bg-slate-900"
      style={{
        boxShadow: p.accent ? `inset 0 0 0 3px ${p.accent}` : undefined
      }}
    >
      <div className="pointer-events-none absolute inset-0" style={{background:`linear-gradient(135deg, ${c1}aa, ${c2}ff)`}}/>
      <div className="pointer-events-none absolute inset-0 opacity-20 mix-blend-overlay" style={{backgroundImage:
        "radial-gradient(circle at 20% 20%, #ffffff22 2px, transparent 2px),"+
        "radial-gradient(circle at 80% 30%, #ffffff11 1px, transparent 1px),"+
        "radial-gradient(circle at 40% 80%, #ffffff22 2px, transparent 2px)"}}/>
      <div className="absolute inset-0 p-3 flex flex-col">
        {/* Header with space for title */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xl">{p.emoji}</span>
          <div className="font-semibold text-base truncate">{p.name}</div>
        </div>
        <div className="mt-1 flex items-center gap-1 flex-wrap" onClick={stop}>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-black/30">
            {["None","Low","Med","High"][Math.max(0, Math.min(3, p.priority ?? 0))]}
          </span>
          <button disabled={!user} className="px-2 py-1 text-xs bg-white/15 hover:bg-white/25 rounded" onClick={(e)=>{e.stopPropagation(); onColor(p.id);}}>Color</button>
          <button disabled={!user} className="px-2 py-1 text-xs bg-white/15 hover:bg-white/25 rounded" onClick={(e)=>{e.stopPropagation(); onClone(p.id);}}>Copy</button>
          <button disabled={!user} className="px-2 py-1 text-xs bg-white/15 hover:bg-white/25 rounded text-red-200" onClick={(e)=>{e.stopPropagation(); onDelete(p.id);}}>Del</button>
        </div>
        <div className="text-xs text-white/80 mt-1 line-clamp-1">{p.type||"Project"}{p.note?` • ${p.note}`:""}</div>

        {/* Progress */}
        <div className="mt-2">
          <div className="flex items-center justify-between text-[11px] text-white/80"><span>Progress</span><span>{progress}%</span></div>
          <div className="h-2 bg-white/20 rounded mt-1 overflow-hidden"><div className="h-full bg-white/80" style={{width:`${progress}%`}}/></div>
        </div>

        {/* Links + Path */}
        <div className="flex flex-wrap gap-2 mt-2" onClick={stop}>
          {(p.links||[]).slice(0,3).map((lnk,i)=> (
            <a key={lnk.url||i} href={lnk.url} target="_blank" rel="noreferrer" className="text-[11px] px-2 py-1 rounded-full bg-white/15 hover:bg-white/25 inline-flex items-center gap-1" onClick={stop}>🔗 {lnk.label||"Link"}</a>
          ))}
          {/* p.path && (
            <button className="text-[11px] px-2 py-1 rounded-full bg-white/15 hover:bg-white/25" onClick={(e)=>{e.stopPropagation(); tryOpenPath(p.path);}}>📁 Open</button>
          )*/}
        </div>

        {/* Tasks (undone first, highlighted) */}
        <div className="mt-2 grid grid-cols-2 gap-1" onClick={stop}>
          {visibleTasks.map(t=> (
            <label key={t.id} className={`flex items-center gap-2 text-[11px] rounded px-2 py-1 ${t.done?"bg-white/10":"bg-amber-300/30 ring-1 ring-amber-200"}`}>
              <input disabled={!user} type="checkbox" checked={t.done} onChange={()=>onToggleTask(p.id, t.id)} className={t.done?"accent-white":"accent-amber-500"}/>
              <span className={`truncate ${t.done?"line-through opacity-70":"font-medium"}`}>{t.title}</span>
            </label>
          ))}
        </div>

        {/* Footer */}
        <div className="mt-auto pt-2">
          <button disabled={!user} onClick={(e)=>{e.stopPropagation(); onOpen(p.id);}} className="w-full text-sm bg-white/15 hover:bg-white/25 rounded py-1.5">Open project</button>
          {allDone && (<div className="absolute bottom-2 left-2 text-emerald-200 text-xs">✔ Done!</div>)}
        </div>
      </div>
    </div>
  );
}

// --- Modal ---
function Modal({ open, onClose, children }){
  if(!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose}/>
      <div className="absolute inset-x-0 top-10 mx-auto w-[min(1800px,94vw)] max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl p-6">
        {children}
      </div>
    </div>
  );
}

// --- Project Editor (immutable updates) ---
function ProjectEditor({ user, project, onClose, onSave, onDelete, onToggleTask, onAddTask, onAddSuggested, onAddLink }){
  const [draft, setDraft] = useState(project);
  useEffect(()=>setDraft(project),[project]);
  if(!draft) return null;
  const progress = calcProjectProgress(draft);
  const set = (patch)=>setDraft(d=>({...d, ...patch}));

  const updateTaskTitle = useCallback((id, title)=> setDraft(d=>({ ...d, tasks: (d.tasks||[]).map(t=> t.id===id ? { ...t, title } : t) })),[]);
  const removeTask = useCallback((id)=> setDraft(d=>({ ...d, tasks: (d.tasks||[]).filter(t=> t.id!==id) })),[]);
  const updateLink = useCallback((idx, patch)=> setDraft(d=>({ ...d, links: (d.links||[]).map((l,i)=> i===idx ? { ...l, ...patch } : l) })),[]);
  const removeLink = useCallback((idx)=> setDraft(d=>({ ...d, links: (d.links||[]).filter((_,i)=> i!==idx) })),[]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <input disabled={!user} value={draft.emoji} onChange={e=>set({emoji:e.target.value})} className="w-12 text-2xl text-center border rounded"/>
          <input disabled={!user} value={draft.name} onChange={e=>set({name:e.target.value})} placeholder="Project name" className="px-3 py-2 border rounded w-[min(480px,60vw)]"/>
        </div>
        <div className="space-x-2">
          <button disabled={!user} onClick={()=>onDelete(draft.id)} className="px-3 py-2 rounded bg-red-600 text-white">Delete</button>
          <button disabled={!user} onClick={()=>onSave(draft)} className="px-3 py-2 rounded bg-black text-white">Save</button>
          <button disabled={!user} onClick={onClose} className="px-3 py-2 rounded bg-slate-200">Close</button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
        <div className="md:col-span-2 space-y-4">
          <div className="bg-slate-50 rounded-xl p-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-sm mb-1">Priority</div>
                <select value={draft.priority} onChange={e=>set({priority:Number(e.target.value)})} className="w-full border rounded p-2">
                  <option value={3}>High</option><option value={2}>Medium</option><option value={1}>Low</option><option value={0}>None</option>
                </select>
              </div>
              <div>
                <div className="text-sm mb-1">Type / Note</div>
                <input value={draft.type||""} onChange={e=>set({type:e.target.value})} placeholder="Single, EP, Beat…" className="w-full border rounded p-2"/>
              </div>
              <div className="col-span-2">
                <div className="text-sm mb-1">Short note</div>
                <textarea value={draft.note||""} onChange={e=>set({note:e.target.value})} rows={2} className="w-full border rounded p-2"/>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-start">


                {/* COLOR*/}
                <div className="bg-gray-300 rounded-lg border p-3">
                  <div className="text-sm mb-5">Color</div>
                  <input type="color" value={draft.color} 
                          onChange={e=>set({color:e.target.value})} 
                          className="h-11 w-15 rounded"/>

                {/*RANDOM COLOR - BUTTON*/}
                <button 
                  className="px-1 py-1 bg-gray-200 rounded-lg border p-2" 
                  onClick={()=>set({color: COLORS[(Math.random()*COLORS.length)|0]})}>Random
                </button>
                </div>
                
                {/* STROKE*/}
                <div className="bg-gray-300 rounded-lg border p-2">
                  <div className="text-sm mb-20">Stroke</div>
                  <input type="color" value={draft.accent || "#00000000"}
                        onChange={e=>set({accent: e.target.value})}
                        className="h-5 w-full border rounded" />
                  </div>
                <div>
                {/* PROJECT LABEL */}
                <div className="bg-gray-300 rounded-lg border p-2">
                  <div className="text-sm mb-10">Label</div>
                  <input value={draft.label || ""} 
                        onChange={e=>set({label: e.target.value})}
                        placeholder="Project tag (e.g. EP‑A)"
                        className="w-full border rounded p-5" />
                </div>
                  </div>
                  
                {/* PROJECT GROUP (WIDE INPUT) */}
                <div className="bg-gray-300 rounded-lg border p-2">
                  <div className="text-sm mb-10">Project group</div>
                  <input value={draft.group || ""} 
                        onChange={e=>set({group: e.target.value})}
                        placeholder="Group name (e.g. Album X)"
                        className="w-full border rounded p-5" />
                </div>
              </div>
            </div>


            
            <div className="mt-3 text-xs text-slate-600 flex items-center justify-between"><span>{progress}% complete</span><span>Priority: {["None","Low","Med","High"][draft.priority??0]}</span></div>
            <div className="h-2 bg-slate-300 rounded mt-1 overflow-hidden"><div className="h-full bg-slate-800" style={{width:`${progress}%`}}/></div>
          </div>
          {/*TASKS*/}
          <div className="bg-slate-50 rounded-xl p-3">
            <div className="text-sm mb-2 font-medium">Tasks</div>
            <div className="space-y-2">
              {(draft.tasks||[]).map(t=> (
                <label key={t.id} className="flex items-center gap-2 bg-white rounded-md p-2 border">
                  <input type="checkbox" checked={t.done} onChange={()=>onToggleTask(draft.id, t.id)} className="accent-black"/>
                  <input value={t.title} onChange={e=>updateTaskTitle(t.id, e.target.value)} className={`flex-1 border-0 outline-none ${t.done?"line-through opacity-60":""}`}/>
                  <button className="px-2 py-1 rounded bg-slate-200" onClick={()=>removeTask(t.id)}>Remove</button>
                </label>
              ))}
              <div className="flex gap-2">
                <input placeholder="Add task…" onKeyDown={(e)=>{ if(e.key==='Enter' && e.currentTarget.value.trim()){ onAddTask(draft.id, e.currentTarget.value.trim()); e.currentTarget.value=''; } }} className="flex-1 border rounded p-2"/>
                <button onClick={()=>onAddSuggested(draft.id)} className="px-2 py-1 rounded bg-slate-200">Suggested</button>
              </div>
            </div>
          </div>
        </div>
        {/*LINKS*/}
        <div className="space-y-4">
          <div className="bg-slate-50 rounded-xl p-3">
            <div className="text-sm mb-2 font-medium">Links</div>
            {(draft.links||[]).map((lnk,i)=> (
              <div key={lnk.url||lnk.label||i} className="flex gap-2 items-center mb-2">
                <input value={lnk.label} onChange={e=>updateLink(i,{label:e.target.value})} placeholder="Label (SoundCloud, Lyrics…)" className="border rounded p-2 flex-1"/>
                <input value={lnk.url} onChange={e=>updateLink(i,{url:e.target.value})} placeholder="https://" className="border rounded p-2 flex-1"/>
                <button className="px-2 py-1 rounded bg-slate-200" onClick={()=>removeLink(i)}>Remove</button>
              </div>
            ))}
            <button onClick={()=>onAddLink(draft.id)} className="px-2 py-1 rounded bg-slate-200">+ Add link</button>
          </div>
          <div className="bg-slate-50 rounded-xl p-3 text-sm text-slate-600">When all tasks are checked, confetti fires and the brick shows a <em>Done</em> badge. 🥳</div>
        </div>
      </div>
    </div>
  );
}

// --- App Root ---
export default function App(){
  // const [state, setState] = useAppState();
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(null);
  const [sortMode, setSortMode] = useState("order"); // "order" | "priority"
  const [groupMode, setGroupMode] = useState("none"); // "none" | "project" | "priority"

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint:{ distance:6 } }));
  // const projects = state.projects;

  const {
    user, projects,
    addProject, cloneProject, updateProject, deleteProject,
    toggleTask, addTask, addSuggested, addLink, changeColor
  } = useFirebaseState();


 

  // ✅ FIX: KEEP MANUAL ORDER STABLE; SEARCH STILL WORKS
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const arr = q
      ? projects.filter(p => [p.name, p.type, p.note].join(" ").toLowerCase().includes(q))
      : projects;
    if (sortMode === "priority") {
      // Priority first (high→low), then stable by order
      return arr.slice().sort((a,b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.order ?? 0) - (b.order ?? 0));
    }
    // Manual mode
    return arr.slice().sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
  }, [projects, query, sortMode]);

  // >>> ADD THIS
  const filteredIds = useMemo(() => filtered.map(p => p.id), [filtered]);
  const xp = useMemo(() => calcXP(projects), [projects]);
  // <<< ADD THIS

    // ✅ BUILD GROUPS FOR RENDERING (VISUAL SECTIONS)
  const groups = useMemo(() => {
    if (groupMode === "project") {
      const map = new Map();
      for (const p of filtered) {
        const key = (p.group || "Ungrouped").trim() || "Ungrouped";
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(p);
      }
      return Array.from(map.entries()); // [ [groupName, projects[]], ... ]
    }
    if (groupMode === "priority") {
      const label = (n)=>["None","Low","Med","High"][Math.max(0, Math.min(3, n ?? 0))];
      const map = new Map();
      for (const p of filtered) {
        const key = label(p.priority);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(p);
      }
      // High→Low→None for nicer order
      const order = ["High","Med","Low","None"];
      return order.filter(k => map.has(k)).map(k => [k, map.get(k)]);
    }
    // no grouping
    return [["All", filtered]];
  }, [filtered, groupMode]);


  // const addProject = useCallback(()=>{
  //  const p={ id:uid(), name:"New project", type:"", note:"", emoji: EMOJIS[(Math.random()*EMOJIS.length)|0], color: COLORS[(Math.random()*COLORS.length)|0], priority:2, path:"", links:[], tasks:[] };
  //  setState(prev => ({ ...prev, projects:[p, ...prev.projects] }));
  //},[setState]);
  //const updateProject = useCallback((patch)=> setState(prev=>({ ...prev, projects: prev.projects.map(pr=>pr.id===patch.id?{...pr,...patch}:pr) })),[setState]);
  // const deleteProject = useCallback((id)=> setState(prev=>({ ...prev, projects: prev.projects.filter(p=>p.id!==id) })),[setState]);
  // const cloneProject = useCallback((id)=> setState(prev=>{ const src=prev.projects.find(p=>p.id===id); if(!src) return prev; const clone={...src, id:uid(), name:src.name+" (copy)", tasks:(src.tasks||[]).map(t=>({...t,id:uid()}))}; return { ...prev, projects:[clone, ...prev.projects] }; }),[setState]);
  // const toggleTask = useCallback((pid, tid)=> setState(prev=>({ ...prev, projects: prev.projects.map(p=> p.id!==pid ? p : { ...p, tasks: (p.tasks||[]).map(t=> t.id===tid ? { ...t, done: !t.done } : t) }) })),[setState]);
  // const addTask = useCallback((pid, title)=> setState(prev=>({ ...prev, projects: prev.projects.map(p=> p.id!==pid ? p : { ...p, tasks: [...(p.tasks||[]), {id:uid(), title, done:false}] }) })),[setState]);
  // const addSuggested = useCallback((pid)=> setState(prev=>({ ...prev, projects: prev.projects.map(p=> p.id!==pid ? p : { ...p, tasks: [...(p.tasks||[]), ...SUGGESTED.filter(st=>!(p.tasks||[]).some(t=>t.title.toLowerCase()===st.toLowerCase())).map(title=>({id:uid(),title,done:false}))] }) })),[setState]);
  // const addLink = useCallback((pid)=> setState(prev=>({ ...prev, projects: prev.projects.map(p=> p.id!==pid ? p : { ...p, links: [...(p.links||[]), {label:"Link", url:"https://"}] }) })),[setState]);
  // const changeColor = useCallback((pid)=> setState(prev=>({ ...prev, projects: prev.projects.map(p=> p.id!==pid ? p : { ...p, color: COLORS[(Math.random()*COLORS.length)|0] }) })),[setState]);

  // >>> REPLACE onDragEnd WITH THIS
  const onDragEnd = useCallback(async (e) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    if (query.trim()) return; // don't reorder while filtered

    const ids = filtered.map(p => p.id);
    const oldIndex = ids.indexOf(active.id);
    const newIndex = ids.indexOf(over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(filtered, oldIndex, newIndex);

    try {
      // PERSIST THE NEW ORDER INDEXES
      await Promise.all(
        reordered.map((p, i) =>
          updateProject({ id: p.id, order: i }) // <<< WRITE order
        )
      );
    } catch (err) {
      console.error("Failed to persist order", err);
    }
  }, [filtered, query, updateProject]);
  // <<< REPLACE END



  const active = useMemo(()=> projects.find(p=>p.id===activeId) || null, [projects, activeId]);

  // --- Self tests (run once in dev browsers) ---
  useEffect(()=>{
    try {
      const t1 = calcProjectProgress({tasks:[]}); console.assert(t1===0, 'progress empty');
      const t2 = calcProjectProgress({tasks:[{done:true},{done:false},{done:true},{done:false}]}); console.assert(t2===50, 'progress 2/4');
      const xpT = calcXP([{tasks:[{done:true},{done:true}]},{tasks:[{done:false}]}]); console.assert(xpT.xp===20 && xpT.level>=1, 'xp calc');
      const sc = shadeColor('#336699', -20); console.assert(/^#[0-9a-fA-F]{6}$/.test(sc), 'shadeColor hex');
      // copyToClipboard(''); // should not throw
    } catch {}
  },[]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-slate-200">
      <div className="mx-auto max-w-7xl px-4 py-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-black text-white grid place-items-center text-xl">🧱</div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">BeatBricks</h1>
              <p className="text-slate-600 -mt-1 text-sm">Project Progress Dashboard</p>
            </div>
          </div>

          <select
            value={groupMode}
            onChange={(e)=>setGroupMode(e.target.value)}
            className="hidden md:block border rounded px-2 py-2 bg-white"
            title="Grouping"
          >
            <option value="none">No grouping</option>
            <option value="project">Group by project</option>
            <option value="priority">Group by priority</option>
          </select>



          <div className="flex items-center gap-2">
            {/* Search (desktop) */}
            {user && (
              <div className="w-64 hidden md:block">
                <div className="relative">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search projects…"
                    className="w-full pl-3 pr-3 py-2 rounded-md bg-white shadow border border-slate-200"
                  />
                </div>
              </div>
            )}

          <select
            value={sortMode}
            onChange={(e)=>setSortMode(e.target.value)}
            className="hidden md:block border rounded px-2 py-2 bg-white"
          >
            <option value="order">Manual order</option>
            <option value="priority">Priority</option>
          </select>


            {/* Actions */}
            {user && (
              <>
                <button onClick={addProject} className="px-3 py-2 rounded-md bg-black text-white">
                  + New project
                </button>

                <button
                  onClick={() => {
                    const blob = new Blob([JSON.stringify({ projects }, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "beatbricks-data.json";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="px-3 py-2 rounded-md bg-white border"
                >
                  Export
                </button>

                <label className="px-3 py-2 rounded-md bg-white border cursor-pointer">
                  Import
                  <input
                    type="file"
                    accept="application/json"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        const text = await f.text();
                        const data = JSON.parse(text);
                        for (const p of data.projects || []) {
                          const id = p.id || crypto.randomUUID();
                          await setDoc(doc(db, `users/${user.uid}/projects/${id}`), { ...p, id });
                        }
                        alert("Import complete");
                      } catch {
                        alert("Import failed");
                      }
                    }}
                  />
                </label>
              </>
            )}

            {/* Auth UI */}
            {user ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">{user.email}</span>
                <button
                  onClick={() => signOut(auth)}
                  className="px-3 py-2 rounded-md bg-white border border-slate-200 hover:bg-slate-50"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <button
                onClick={() => signInWithPopup(auth, provider)}
                className="px-3 py-2 rounded-md bg-black text-white hover:bg-slate-800"
              >
                Sign in
              </button>
            )}
          </div>
        </div>

        {/* Mobile search */}
        {user && (
          <div className="md:hidden mt-4">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              className="w-full pl-3 pr-3 py-2 rounded-md bg-white shadow border border-slate-200"
            />
          </div>
        )}

        {/* Signed-in content */}
        {user ? (
          <>
            {/* XP / Level */}
            <div className="mt-4 bg-white rounded-xl shadow p-4">
              <div className="flex items-center justify-between">
                <div className="font-medium">Level {xp.level}</div>
                <div className="text-sm text-slate-600">{xp.xp} XP</div>
              </div>
              <div className="h-2 bg-slate-200 rounded mt-2 overflow-hidden">
                <div className="h-full bg-slate-800" style={{ width: `${xp.pct}%` }} />
              </div>
            </div>

          {/* Bricks Grid */}
          <div className="mt-6">
            {filtered.length === 0 ? (
              <div className="text-center py-20 text-slate-500">
                <p className="text-lg">No projects yet.</p>
                <p className="text-sm">
                  Click <strong>New project</strong> to start a brick.
                </p>
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={filteredIds} strategy={rectSortingStrategy}>
                  {/* ✅ LOOP THROUGH GROUPS */}
                  {groups.map(([title, items]) => (
                    <div key={title} className="mt-6">
                      {groupMode !== "none" && (
                        <div className="text-sm font-medium text-slate-600 mb-2 px-1">
                          {title}
                        </div>
                      )}
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 auto-rows-fr">
                        {items.map((p) => (
                          <SortableBrick key={p.id} id={p.id} span={1}>
                            <Brick
                              user={user}
                              p={p}
                              onOpen={setActiveId}
                              onToggleTask={toggleTask}
                              onDelete={deleteProject}
                              onClone={cloneProject}
                              onColor={changeColor}
                            />
                          </SortableBrick>
                        ))}
                      </div>
                    </div>
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </div>

          </>
        ) : (
          <div className="mt-10 text-center text-slate-600">
            <p className="text-lg mb-3">Sign in to view your projects</p>
            <button
              onClick={() => signInWithPopup(auth, provider)}
              className="px-4 py-2 rounded-md bg-black text-white hover:bg-slate-800"
            >
              Sign in with Google
            </button>
          </div>
        )}

        {/* Modal */}
        <Modal open={!!activeId} onClose={() => setActiveId(null)}>
          {user && active && (
            <ProjectEditor
              user={user}
              project={active}
              onClose={() => setActiveId(null)}
              onSave={(patch) => {
                updateProject(patch);
                setActiveId(null);
              }}
              onDelete={(id) => {
                deleteProject(id);
                setActiveId(null);
              }}
              onToggleTask={toggleTask}
              onAddTask={addTask}
              onAddSuggested={addSuggested}
              onAddLink={addLink}
            />
          )}
        </Modal>

        <div className="text-center text-xs text-slate-500 mt-10">
          Cloud-synced with Firebase. For native folder open, wrap in Electron.
        </div>
      </div>
    </div>
  );

}
