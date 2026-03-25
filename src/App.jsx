import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";

const MODULES = {
  CFO: { color: "#3B82F6", exam: "2026-04-30", examLabel: "Apr 30, 2:30 PM", weak: false },
  MDV: { color: "#8B5CF6", exam: "2026-05-06", examLabel: "May 6, 10:00 AM", weak: true },
  MTM: { color: "#10B981", exam: "2026-05-11", examLabel: "May 11, 2:00 PM", weak: false },
  MTX: { color: "#F59E0B", exam: "2026-05-12", examLabel: "May 12, 2:00 PM", weak: true },
  PEN: { color: "#EF4444", exam: "2026-05-15", examLabel: "May 15, 10:00 AM", weak: true },
};
const MOD_KEYS = Object.keys(MODULES);
const PHASE_META = {
  understand: { color: "#3B82F6", label: "Understand", short: "U" },
  recall: { color: "#F59E0B", label: "Recall", short: "R" },
  exam: { color: "#EF4444", label: "Exam prep", short: "E" },
};
const RAG = [
  { value: "none", label: "Not started", bg: "var(--rag-none)", text: "var(--rag-none-text)" },
  { value: "red", label: "Weak", bg: "#FCA5A5", text: "#7F1D1D" },
  { value: "amber", label: "Partial", bg: "#FCD34D", text: "#78350F" },
  { value: "green", label: "Confident", bg: "#6EE7B7", text: "#064E3B" },
];
const RAG_MAP = Object.fromEntries(RAG.map(r => [r.value, r]));

const HOLIDAY = { start: "2026-04-11", end: "2026-04-15" };
const inH = ds => ds >= HOLIDAY.start && ds <= HOLIDAY.end;
const DS = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const PD = s => { const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); };
const TODAY = DS(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
const EXAM_DATES = {}; for (const [m, i] of Object.entries(MODULES)) EXAM_DATES[i.exam] = m;

/* ──────────────────────────────────────────
   ALGORITHMIC SCHEDULER
   ────────────────────────────────────────── */
function defaultTargets() {
  return {
    CFO: { understand: 30, recall: 14, exam: 10 },
    MDV: { understand: 36, recall: 11, exam: 15 },
    MTM: { understand: 25, recall: 12, exam: 13 },
    MTX: { understand: 45, recall: 10, exam: 16 },
    PEN: { understand: 35, recall: 12, exam: 14 },
  };
}

function generatePlan(targets, dailyCap, skipDays = new Set()) {
  const plan = {};
  const add = (ds, subj, hours, phase) => { if (hours <= 0) return; if (!plan[ds]) plan[ds] = []; plan[ds].push({ subj, hours: Math.round(hours * 2) / 2, phase }); };

  // Build list of study days
  const allDays = [];
  let d = PD(TODAY); const endD = PD("2026-05-15");
  while (d <= endD) { const ds = DS(d.getFullYear(), d.getMonth(), d.getDate()); if (!inH(ds) && !skipDays.has(ds)) allDays.push(ds); d.setDate(d.getDate() + 1); }

  // Sort modules by exam date
  const sorted = [...MOD_KEYS].sort((a, b) => PD(MODULES[a].exam) - PD(MODULES[b].exam));

  // For each module, compute available days and split into phase windows
  const modWindows = {};
  for (const mod of sorted) {
    const t = targets[mod];
    const examDs = MODULES[mod].exam;
    const avail = allDays.filter(ds => ds < examDs);
    const totalH = t.understand + t.recall + t.exam;
    if (avail.length === 0 || totalH === 0) continue;

    // Split available days into 3 phases proportional to hours
    const uRatio = t.understand / totalH;
    const rRatio = t.recall / totalH;
    const uDays = Math.max(1, Math.round(avail.length * uRatio));
    const rDays = Math.max(1, Math.round(avail.length * rRatio));
    const eDays = Math.max(1, avail.length - uDays - rDays);

    modWindows[mod] = {
      understand: { days: avail.slice(0, uDays), target: t.understand },
      recall: { days: avail.slice(uDays, uDays + rDays), target: t.recall },
      exam: { days: avail.slice(uDays + rDays), target: t.exam },
    };
  }

  // Track remaining hours per (mod, phase)
  const phaseRemaining = {};
  for (const mod of sorted) {
    if (!modWindows[mod]) continue;
    const t = targets[mod];
    phaseRemaining[`${mod}-understand`] = t.understand;
    phaseRemaining[`${mod}-recall`]     = t.recall;
    phaseRemaining[`${mod}-exam`]       = t.exam;
  }

  // Build day → active (mod, phase) pairs lookup
  const dayActive = {};
  for (const ds of allDays) dayActive[ds] = [];
  for (const mod of sorted) {
    if (!modWindows[mod]) continue;
    for (const phase of ["understand", "recall", "exam"]) {
      for (const ds of modWindows[mod][phase].days) {
        dayActive[ds].push({ mod, phase, windowDays: modWindows[mod][phase].days });
      }
    }
  }

  // Day-centric urgency allocation: each day picks the 3 most urgent (mod, phase) pairs
  const dayUsed = {};
  for (const ds of allDays) dayUsed[ds] = 0;

  for (const ds of allDays) {
    const capAvail = dailyCap - dayUsed[ds];
    if (capAvail < 0.25) continue;

    // Find active pairs with remaining hours
    const active = (dayActive[ds] || []).filter(
      ({ mod, phase }) => phaseRemaining[`${mod}-${phase}`] >= 0.25
    );
    if (active.length === 0) continue;

    // Urgency = remaining / days left in window from this day onwards
    const candidates = active.map(({ mod, phase, windowDays }) => {
      const daysLeft = windowDays.filter(d => d >= ds).length;
      const remaining = phaseRemaining[`${mod}-${phase}`];
      return { mod, phase, remaining, urgency: daysLeft > 0 ? remaining / daysLeft : remaining };
    });

    // Sort by urgency descending, pick top 3
    candidates.sort((a, b) => b.urgency - a.urgency);
    const toStudy = candidates.slice(0, 3);

    // Distribute cap proportionally by urgency
    const totalUrgency = toStudy.reduce((s, x) => s + x.urgency, 0);
    let capLeft = capAvail;
    for (const { mod, phase, remaining, urgency } of toStudy) {
      const share = (urgency / totalUrgency) * capAvail;
      const h = Math.min(share, remaining, capLeft);
      if (h >= 0.25) {
        add(ds, mod, h, phase);
        dayUsed[ds] += h;
        phaseRemaining[`${mod}-${phase}`] -= h;
        capLeft -= h;
      }
    }
  }

  // Add exam day markers (0.5h light review on exam day itself)
  for (const mod of MOD_KEYS) {
    const examDs = MODULES[mod].exam;
    const existing = plan[examDs]?.filter(e => e.subj === mod) || [];
    if (existing.length === 0) add(examDs, mod, 0.5, "exam");
  }

  // Holiday entries
  let hd = PD(HOLIDAY.start); const he = PD(HOLIDAY.end);
  while (hd <= he) { const ds = DS(hd.getFullYear(), hd.getMonth(), hd.getDate()); if (!plan[ds]) plan[ds] = []; plan[ds].push({ subj: "HOLIDAY", hours: 0, phase: "holiday" }); hd.setDate(hd.getDate() + 1); }

  return plan;
}

function defaultChecklist() {
  const s = {};
  for (const mod of MOD_KEYS) { s[mod] = []; for (let i = 0; i < 8; i++) s[mod].push({ name: `${i + 1}.`, u: "none", r: "none", e: "none" }); }
  return s;
}

const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600&display=swap');
  :root {
    --surface: #ffffff; --surface-2: #f8fafc; --surface-3: #f1f5f9;
    --border: #e2e8f0; --border-hover: #cbd5e1;
    --text-1: #0f172a; --text-2: #475569; --text-3: #94a3b8;
    --radius: 12px; --radius-sm: 8px; --radius-xs: 6px;
    --rag-none: #e2e8f0; --rag-none-text: #64748b;
    --holiday-bg: #ecfdf5;
  }
  :root.dark {
    --surface: #1e293b; --surface-2: #0f172a; --surface-3: #273549;
    --border: #334155; --border-hover: #475569;
    --text-1: #f1f5f9; --text-2: #94a3b8; --text-3: #64748b;
    --rag-none: #334155; --rag-none-text: #94a3b8;
    --holiday-bg: #064e3b33;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'DM Sans', system-ui, sans-serif; zoom:1.5 ; color: var(--text-1); background: var(--surface-2); -webkit-font-smoothing: antialiased; }
  .fade-in { animation: fadeIn 0.3s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes slideDown { from { opacity: 0; max-height: 0; } to { opacity: 1; max-height: 400px; } }
  .slide-down { animation: slideDown 0.25s ease; overflow: hidden; }
  select, input[type=number] { font-family: 'DM Sans', system-ui, sans-serif; }
  input[type=number] { -moz-appearance: textfield; }
  input[type=number]::-webkit-outer-spin-button,
  input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  textarea.note-input {
    font-family: 'DM Sans', system-ui, sans-serif; resize: vertical; color: var(--text-1);
    background: transparent; border: 1.5px solid var(--border); border-radius: 8px;
    padding: 8px 10px; font-size: 12.5px; line-height: 1.5; width: 100%; outline: none; transition: border-color 0.15s;
  }
  textarea.note-input:focus { border-color: #3B82F6; }
  textarea.note-input::placeholder { color: var(--text-3); }
  .md-preview { font-size: 12.5px; color: var(--text-2); line-height: 1.6; }
  .md-preview p { margin: 0 0 6px; }
  .md-preview ul { margin: 0 0 6px; padding-left: 18px; }
  .md-preview li { margin-bottom: 3px; }
  .md-preview br { display: block; margin: 3px 0; }
  .cal-cell:not([data-sel="true"]):hover { border-color: var(--border-hover) !important; background: var(--surface-3) !important; }
`;

function sm2Update(ef, interval, reps, quality) {
  if (quality < 3) return { ef: Math.max(1.3, ef - 0.2), interval: 1, reps: 0 };
  const newEf = Math.max(1.3, ef + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  const newInterval = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(interval * ef);
  return { ef: newEf, interval: newInterval, reps: reps + 1 };
}
const SR_QUALITY = { none: 0, red: 1, amber: 3, green: 5 };

function mdPreview(text) {
  const escaped = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const lines = escaped.split("\n");
  let html = "", inList = false;
  for (const line of lines) {
    if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${fmt(line.slice(2))}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += line.trim() ? `<p>${fmt(line)}</p>` : "<br/>";
    }
  }
  if (inList) html += "</ul>";
  return html;
  function fmt(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
      .replace(/\*(.+?)\*/g,"<em>$1</em>")
      .replace(/`(.+?)`/g,"<code style='background:var(--surface-3);padding:0 3px;border-radius:3px;font-family:monospace'>$1</code>");
  }
}

function Pill({ active, color, children, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "6px 16px", borderRadius: 99, fontSize: 12.5, fontWeight: 500, cursor: "pointer",
      border: "1.5px solid", transition: "all 0.2s ease",
      borderColor: active ? color : "var(--border)",
      background: active ? color + "15" : "transparent",
      color: active ? color : "var(--text-3)",
    }}>{children}</button>
  );
}

function RagSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);
  const dropRef = useRef(null);
  const opt = RAG_MAP[value] || RAG_MAP.none;

  const handleOpen = () => {
    if (btnRef.current) {
      const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom / zoom + 4, left: (r.left + r.width / 2) / zoom });
    }
    setOpen(o => !o);
  };

  useEffect(() => {
    if (!open) return;
    const handler = e => {
      if (dropRef.current && !dropRef.current.contains(e.target) &&
          btnRef.current && !btnRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <>
      <button ref={btnRef} onClick={handleOpen} style={{
        fontSize: 10.5, fontWeight: 600, padding: "4px 10px", borderRadius: 99,
        border: "none", cursor: "pointer", width: 90, outline: "none",
        background: value === "none" ? "var(--rag-none)" : opt.bg,
        color: value === "none" ? "var(--rag-none-text)" : opt.text,
        transition: "opacity 0.15s",
      }}>{opt.label}</button>
      {open && (
        <div ref={dropRef} className="fade-in" style={{
          position: "fixed", top: pos.top, left: pos.left, transform: "translateX(-50%)",
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)", boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
          zIndex: 1000, minWidth: 120, overflow: "hidden",
        }}>
          {RAG.map(r => (
            <button key={r.value} onClick={() => { onChange(r.value); setOpen(false); }} style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "8px 12px", border: "none", cursor: "pointer", textAlign: "left",
              background: value === r.value ? "var(--surface-3)" : "transparent",
              fontSize: 12, fontWeight: value === r.value ? 600 : 500,
              color: "var(--text-1)", transition: "background 0.1s",
            }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--surface-3)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = value === r.value ? "var(--surface-3)" : "transparent"; }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                background: r.value === "none" ? "var(--rag-none)" : r.bg }} />
              {r.label}
              {value === r.value && (
                <svg style={{ marginLeft: "auto" }} width="10" height="10" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const CL_KEY = "exam-planner-v3";
const TGT_KEY = "exam-planner-targets-v2";
const CAP_KEY = "exam-planner-cap-v1";
const CAL_NOTES_KEY = "exam-planner-calnotes-v1";
const CH_NOTES_KEY = "exam-planner-chnotes-v1";
const WEAK_KEY = "exam-planner-weak-v1";
const SKIP_KEY = "exam-planner-skip-v1";
const PP_KEY   = "exam-planner-pp-v1";
const SR_KEY   = "exam-planner-sr-v1";
const GITHUB_SYNC_DELAY = 3000;

export default function App() {
  const [view, setView] = useState("calendar");
  const [month, setMonth] = useState(2);
  const [year, setYear] = useState(2026);
  const [selDay, setSelDay] = useState(null);
  const [activeMod, setActiveMod] = useState("CFO");
  const [cl, setCl] = useState(null);
  const [targets, setTargets] = useState(null);
  const [dailyCap, setDailyCap] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [calNotes, setCalNotes] = useState({});
  const [chNotes, setChNotes] = useState({});
  const [expandedNotes, setExpandedNotes] = useState({});
  const [calNoteEdit, setCalNoteEdit] = useState("");
  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem("theme");
    if (stored) return stored === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [weakMods, setWeakMods] = useState(() => {
    try { const v = localStorage.getItem(WEAK_KEY); if (v) return new Set(JSON.parse(v)); } catch {}
    return new Set(MOD_KEYS.filter(m => MODULES[m].weak));
  });
  const [showSettings, setShowSettings] = useState(false);
  const [skipDays, setSkipDays] = useState(() => {
    try { const v = localStorage.getItem(SKIP_KEY); if (v) return new Set(JSON.parse(v)); } catch {}
    return new Set();
  });
  const [ppData, setPpData] = useState({});
  const [ppForm, setPpForm] = useState({ paper: "", score: "", notes: "" });
  const [editingNote, setEditingNote] = useState({});
  const [srData, setSrData] = useState(() => {
    try { const v = localStorage.getItem(SR_KEY); if (v) return JSON.parse(v); } catch {}
    return {};
  });
  const [srMod, setSrMod] = useState("CFO");
  const [srLog, setSrLog] = useState({});
  const [showWeakOnly, setShowWeakOnly] = useState(false);
  const inputRef = useRef(null);
  const saveNoteTimer = useRef(null);
  const settingsRef = useRef(null);
  const dayPopupRef = useRef(null);
  const syncTimer = useRef(null);

  useEffect(() => {
    const loadFromStorage = () => {
      try { const v = localStorage.getItem(CL_KEY); if (v) { const p = JSON.parse(v); const d = defaultChecklist(); for (const m of MOD_KEYS) { if (!p[m]) p[m] = d[m]; else p[m] = p[m].map(ch => ({ ...ch, name: ch.name.replace(/^Chapter (\d+)$/, '$1.') })); } setCl(p); } else setCl(defaultChecklist()); } catch { setCl(defaultChecklist()); }
      try { const v = localStorage.getItem(TGT_KEY); if (v) setTargets(JSON.parse(v)); else setTargets(defaultTargets()); } catch { setTargets(defaultTargets()); }
      try { const v = localStorage.getItem(CAP_KEY); if (v) setDailyCap(JSON.parse(v)); else setDailyCap(7); } catch { setDailyCap(7); }
      try { const v = localStorage.getItem(CAL_NOTES_KEY); if (v) setCalNotes(JSON.parse(v)); } catch {}
      try { const v = localStorage.getItem(CH_NOTES_KEY); if (v) setChNotes(JSON.parse(v)); } catch {}
      try { const v = localStorage.getItem(PP_KEY); if (v) setPpData(JSON.parse(v)); } catch {}
    };
    fetch("/api/data")
      .then(r => r.ok ? r.json() : null)
      .then(remote => {
        if (remote && Object.keys(remote).length > 0) {
          const d = defaultChecklist();
          const cl = remote.cl || d;
          for (const m of MOD_KEYS) { if (!cl[m]) cl[m] = d[m]; else cl[m] = cl[m].map(ch => ({ ...ch, name: ch.name.replace(/^Chapter (\d+)$/, '$1.') })); }
          setCl(cl);
          setTargets(remote.targets || defaultTargets());
          setDailyCap(remote.dailyCap ?? 7);
          setCalNotes(remote.calNotes || {});
          setChNotes(remote.chNotes || {});
          setPpData(remote.ppData || {});
          if (remote.weakMods) setWeakMods(new Set(remote.weakMods));
          if (remote.skipDays) setSkipDays(new Set(remote.skipDays));
          if (remote.srData) setSrData(remote.srData);
        } else {
          loadFromStorage();
        }
      })
      .catch(() => loadFromStorage())
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!selDay) return;
    setCalNoteEdit(calNotes[selDay] || "");
    const firstMod = (PLAN[selDay] || []).find(e => e.subj !== "HOLIDAY")?.subj;
    if (firstMod) { setSrMod(firstMod); setSrLog({}); }
  }, [selDay]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("theme", darkMode ? "dark" : "light");
  }, [darkMode]);
  useEffect(() => {
    if (!showSettings) return;
    const handler = e => { if (settingsRef.current && !settingsRef.current.contains(e.target)) setShowSettings(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSettings]);
  useEffect(() => {
    const handler = e => { if (e.key === "Escape") setSelDay(null); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (selDay && dayPopupRef.current) dayPopupRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selDay]);

  const saveCl = useCallback(d => { try { localStorage.setItem(CL_KEY, JSON.stringify(d)); } catch {} }, []);
  const saveTgt = useCallback(d => { try { localStorage.setItem(TGT_KEY, JSON.stringify(d)); } catch {} }, []);
  const saveCap = useCallback(d => { try { localStorage.setItem(CAP_KEY, JSON.stringify(d)); } catch {} }, []);

  const toggleWeak = useCallback(mod => {
    setWeakMods(prev => {
      const next = new Set(prev);
      if (next.has(mod)) next.delete(mod); else next.add(mod);
      try { localStorage.setItem(WEAK_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const toggleSkip = useCallback(dateStr => {
    setSkipDays(prev => {
      const next = new Set(prev);
      if (next.has(dateStr)) next.delete(dateStr); else next.add(dateStr);
      try { localStorage.setItem(SKIP_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const logStudy = useCallback((date) => {
    setSrData(prev => {
      const next = { ...prev };
      for (const [chIdxStr, quality] of Object.entries(srLog)) {
        const key = `${srMod}-${chIdxStr}`;
        const cur = prev[key] || { ef: 2.5, interval: 1, reps: 0 };
        const q = SR_QUALITY[quality] ?? 0;
        const { ef, interval, reps } = sm2Update(cur.ef, cur.interval, cur.reps, q);
        const nextDate = new Date(date);
        nextDate.setDate(nextDate.getDate() + interval);
        const nextReview = DS(nextDate.getFullYear(), nextDate.getMonth(), nextDate.getDate());
        next[key] = { ef, interval, reps, nextReview, lastStudied: date };
      }
      try { localStorage.setItem(SR_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    setSrLog({});
  }, [srLog, srMod]);

  const saveCalNote = useCallback((dateStr, text) => {
    if (saveNoteTimer.current) clearTimeout(saveNoteTimer.current);
    saveNoteTimer.current = setTimeout(() => {
      setCalNotes(prev => {
        const n = { ...prev }; if (text.trim()) n[dateStr] = text; else delete n[dateStr];
        try { localStorage.setItem(CAL_NOTES_KEY, JSON.stringify(n)); } catch {}
        return n;
      });
    }, 500);
  }, []);

  const saveChNote = useCallback((key, text) => {
    if (saveNoteTimer.current) clearTimeout(saveNoteTimer.current);
    saveNoteTimer.current = setTimeout(() => {
      setChNotes(prev => {
        const n = { ...prev }; if (text.trim()) n[key] = text; else delete n[key];
        try { localStorage.setItem(CH_NOTES_KEY, JSON.stringify(n)); } catch {}
        return n;
      });
    }, 500);
  }, []);

  const savePP = useCallback(d => { try { localStorage.setItem(PP_KEY, JSON.stringify(d)); } catch {} }, []);

  const syncToGitHub = useCallback((data) => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).catch(() => {});
    }, GITHUB_SYNC_DELAY);
  }, []);

  useEffect(() => {
    if (!loaded || !cl || !targets || dailyCap === null) return;
    syncToGitHub({ cl, targets, dailyCap, calNotes, chNotes, ppData, weakMods: [...weakMods], skipDays: [...skipDays], srData });
  }, [cl, targets, dailyCap, calNotes, chNotes, ppData, weakMods, skipDays, srData, loaded, syncToGitHub]); // eslint-disable-line react-hooks/exhaustive-deps

  const addPP = useCallback((mod, form) => {
    if (!form.paper.trim()) return;
    setPpData(prev => {
      const entry = { id: Date.now(), date: TODAY, paper: form.paper.trim(),
        score: form.score === "" ? null : Math.min(100, Math.max(0, Number(form.score))), notes: form.notes.trim() };
      const next = { ...prev, [mod]: [...(prev[mod] || []), entry] };
      savePP(next); return next;
    });
    setPpForm({ paper: "", score: "", notes: "" });
  }, [savePP]);

  const removePP = useCallback((mod, id) => {
    setPpData(prev => {
      const next = { ...prev, [mod]: (prev[mod] || []).filter(e => e.id !== id) };
      savePP(next); return next;
    });
  }, [savePP]);

  const updateCl = useCallback((mod, idx, phase, val) => { setCl(prev => { const n = { ...prev, [mod]: prev[mod].map((c, i) => i === idx ? { ...c, [phase]: val } : c) }; saveCl(n); return n; }); }, [saveCl]);
  const renameFn = useCallback((mod, idx, name) => { setCl(prev => { const n = { ...prev, [mod]: prev[mod].map((c, i) => i === idx ? { ...c, name } : c) }; saveCl(n); return n; }); }, [saveCl]);
  const addCh = useCallback(mod => { setCl(prev => { const n = { ...prev, [mod]: [...prev[mod], { name: `${prev[mod].length + 1}.`, u: "none", r: "none", e: "none" }] }; saveCl(n); return n; }); }, [saveCl]);
  const removeCh = useCallback((mod, idx) => { setCl(prev => { if (prev[mod].length <= 1) return prev; const n = { ...prev, [mod]: prev[mod].filter((_, i) => i !== idx) }; saveCl(n); return n; }); }, [saveCl]);
  const resetCl = useCallback(() => { const f = defaultChecklist(); setCl(f); saveCl(f); }, [saveCl]);

  const updateTarget = useCallback((mod, phase, val) => {
    setTargets(prev => { const n = { ...prev, [mod]: { ...prev[mod], [phase]: Math.max(0, Math.round(val * 10) / 10) } }; saveTgt(n); return n; });
  }, [saveTgt]);

  const updateCap = useCallback(val => { const v = Math.max(1, Math.min(16, Math.round(val * 10) / 10)); setDailyCap(v); saveCap(v); }, [saveCap]);

  const resetSettings = useCallback(() => { const t = defaultTargets(); setTargets(t); saveTgt(t); setDailyCap(7); saveCap(7); }, [saveTgt, saveCap]);

  const targetsKey = targets ? JSON.stringify(targets) : "";
  const PLAN = useMemo(() => (targets && dailyCap != null) ? generatePlan(targets, dailyCap, skipDays) : {}, [targetsKey, dailyCap, skipDays]);

  if (!loaded || !cl || !targets || dailyCap == null) return <div style={{ padding: "3rem", color: "var(--text-3)" }}>Loading...</div>;

  const stats = mod => { const chs = cl[mod] || []; let done = 0; for (const c of chs) { if (c.u !== "none") done++; if (c.r !== "none") done++; if (c.e !== "none") done++; } return { done, total: chs.length * 3, pct: chs.length ? Math.round(done / (chs.length * 3) * 100) : 0 }; };
  const conf = mod => { const chs = cl[mod] || []; let g=0,a=0,r=0,n=0; for (const c of chs) for (const p of ["u","r","e"]) { if(c[p]==="green")g++;else if(c[p]==="amber")a++;else if(c[p]==="red")r++;else n++;} return{green:g,amber:a,red:r,none:n,total:g+a+r+n}; };

  let gd=0,gt=0; for(const m of MOD_KEYS){const s=stats(m);gd+=s.done;gt+=s.total;} const overallPct=gt?Math.round(gd/gt*100):0;
  const monthNames=["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dim=new Date(year,month+1,0).getDate();
  const fdow=(new Date(year,month,1).getDay()+6)%7;
  const dayEntries=selDay?(PLAN[selDay]||[]):[];
  const srDueCounts = {};
  for (const [, entry] of Object.entries(srData)) { if (entry.nextReview) srDueCounts[entry.nextReview] = (srDueCounts[entry.nextReview] || 0) + 1; }
  const reviewsDueToday = Object.values(srData).filter(e => e.nextReview && e.nextReview <= TODAY).length;

  // allocated hours
  const allocated = {};
  for (const mod of MOD_KEYS) allocated[mod] = { understand: 0, recall: 0, exam: 0 };
  for (const entries of Object.values(PLAN)) for (const e of entries) { if (e.subj !== "HOLIDAY" && allocated[e.subj]) allocated[e.subj][e.phase] += e.hours; }

  // grand totals
  let grandAlloc = 0; for (const mod of MOD_KEYS) grandAlloc += allocated[mod].understand + allocated[mod].recall + allocated[mod].exam;
  let grandTarget = 0; for (const mod of MOD_KEYS) grandTarget += targets[mod].understand + targets[mod].recall + targets[mod].exam;
  const studyDays = Object.keys(PLAN).filter(ds => !inH(ds) && PLAN[ds].some(e => e.subj !== "HOLIDAY")).length;

  const ProgressBar = ({ mod }) => {
    const c = conf(mod), s = stats(mod);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: MODULES[mod].color, minWidth: 32 }}>{mod}</span>
        <div style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden", display: "flex" }}>
          {c.total > 0 && <>
            <div style={{ height: "100%", width: `${(c.green/c.total)*100}%`, background: "#6EE7B7", transition: "width 0.4s" }} />
            <div style={{ height: "100%", width: `${(c.amber/c.total)*100}%`, background: "#FCD34D", transition: "width 0.4s" }} />
            <div style={{ height: "100%", width: `${(c.red/c.total)*100}%`, background: "#FCA5A5", transition: "width 0.4s" }} />
          </>}
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, minWidth: 30, textAlign: "right", color: "var(--text-3)" }}>{s.pct}%</span>
      </div>
    );
  };

  const NumInput = ({ value, onChange, color, width, min, max, step }) => {
    const [local, setLocal] = useState(String(value));
    const ref = useRef(null);
    useEffect(() => { if (ref.current !== document.activeElement) setLocal(String(value)); }, [value]);
    const commit = () => { const v = parseFloat(local); if (!isNaN(v)) onChange(v); else setLocal(String(value)); };
    return (
      <input ref={ref} type="number" value={local} min={min||0} max={max||99} step={step||1}
        onChange={e => setLocal(e.target.value)}
        onBlur={e => { commit(); e.target.style.borderColor = "var(--border)"; }}
        onKeyDown={e => { if (e.key === "Enter") { commit(); e.target.blur(); } }}
        style={{ width: width || 52, fontSize: 13, fontWeight: 600, textAlign: "center", padding: "5px 4px", borderRadius: "var(--radius-xs)", border: "1.5px solid var(--border)", background: "transparent", color: color || "var(--text-1)", outline: "none", transition: "border-color 0.15s" }}
        onFocus={e => e.target.style.borderColor = color || "#3B82F6"} />
    );
  };

  return (
    <>
      <style>{css}</style>
      <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", color: "var(--text-1)", margin: "30px" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div style={{ display: "flex", gap: 3, background: "var(--surface-3)", borderRadius: 99, padding: 3 }}>
            {[["calendar","Calendar"],["gantt","Gantt"],["checklist","Checklist"]].map(([v,l]) => (
              <button key={v} onClick={() => setView(v)} style={{
                padding: "7px 22px", borderRadius: 99, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "none",
                background: view===v ? "var(--surface)" : "transparent",
                color: view===v ? "var(--text-1)" : "var(--text-3)",
                transition: "all 0.2s", boxShadow: view===v ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
              }}>{l}</button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {reviewsDueToday > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, padding: "4px 9px", borderRadius: 99, background: "#F59E0B20", color: "#92400e", border: "1px solid #F59E0B40" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#F59E0B", flexShrink: 0 }} />
                {reviewsDueToday} review{reviewsDueToday > 1 ? "s" : ""} due
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>Progress</span>
              <div style={{ position: "relative", width: 40, height: 40 }}>
                <svg width="40" height="40" viewBox="0 0 40 40" style={{ transform: "rotate(-90deg)" }}>
                  <circle cx="20" cy="20" r="16" fill="none" stroke="var(--border)" strokeWidth="3.5" />
                  <circle cx="20" cy="20" r="16" fill="none" stroke="#3B82F6" strokeWidth="3.5" strokeDasharray={`${overallPct * 1.005} 100.5`} strokeLinecap="round" style={{ transition: "stroke-dasharray 0.6s ease" }} />
                </svg>
                <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 600, color: "var(--text-2)" }}>{overallPct}%</span>
              </div>
            </div>
            {/* Settings */}
            <div style={{ position: "relative" }} ref={settingsRef}>
              <button onClick={() => setShowSettings(s => !s)} style={{ width: 34, height: 34, borderRadius: 99, border: "1.5px solid var(--border)", background: showSettings ? "var(--surface-3)" : "transparent", color: "var(--text-3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border-hover)"; e.currentTarget.style.color = "var(--text-2)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-3)"; }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>
              {showSettings && (
                <div className="fade-in" style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 220, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: "12px 14px", zIndex: 100 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Settings</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        {darkMode
                          ? <><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></>
                          : <><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></>
                        }
                      </svg>
                      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-1)" }}>{darkMode ? "Dark mode" : "Light mode"}</span>
                    </div>
                    <button onClick={() => setDarkMode(d => !d)} style={{ position: "relative", width: 38, height: 22, borderRadius: 99, border: "none", cursor: "pointer", background: darkMode ? "#3B82F6" : "var(--border)", transition: "background 0.2s", flexShrink: 0, padding: 0 }}>
                      <span style={{ position: "absolute", top: 3, left: darkMode ? 19 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                    </button>
                  </div>
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Weak modules</div>
                    {MOD_KEYS.map(mod => (
                      <div key={mod} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ width: 7, height: 7, borderRadius: "50%", background: MODULES[mod].color, flexShrink: 0 }} />
                          <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-1)" }}>{mod}</span>
                        </div>
                        <button onClick={() => toggleWeak(mod)} style={{ position: "relative", width: 34, height: 20, borderRadius: 99, border: "none", cursor: "pointer", background: weakMods.has(mod) ? "#EF4444" : "var(--border)", transition: "background 0.2s", flexShrink: 0, padding: 0 }}>
                          <span style={{ position: "absolute", top: 3, left: weakMods.has(mod) ? 17 : 3, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ===== CALENDAR ===== */}
        {view === "calendar" && (
          <div className="fade-in">
            <div style={{ display: "flex", gap: 5, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              {MOD_KEYS.map(m => (<span key={m} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-2)", padding: "3px 9px", borderRadius: 99, background: MODULES[m].color + "10", fontWeight: 500 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: MODULES[m].color }} />{m}</span>))}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-2)", padding: "3px 9px", borderRadius: 99, background: "var(--holiday-bg)", fontWeight: 500 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: "#10B981" }} />Holiday</span>
              <span style={{ fontSize: 10.5, color: "var(--text-3)", marginLeft: 2 }}>U=understand R=recall E=exam</span>
            </div>
            {(() => {
              const todayEntries = (PLAN[TODAY] || []).filter(e => e.subj !== "HOLIDAY");
              const todayByMod = todayEntries.reduce((acc, e) => { acc[e.subj] = (acc[e.subj] || 0) + e.hours; return acc; }, {});
              return (
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: "var(--radius)", background: "var(--surface-3)", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: todayEntries.length ? 7 : 0 }}>
                    Today — {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}
                  </div>
                  {todayEntries.length === 0
                    ? <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>No study scheduled</div>
                    : <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {Object.entries(todayByMod).map(([mod, hrs]) => (
                          <div key={mod} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, padding: "4px 10px", borderRadius: 99, background: MODULES[mod].color + "15", color: MODULES[mod].color, fontWeight: 600 }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: MODULES[mod].color }} />
                            {mod} · {Math.round(hrs * 10) / 10}h
                          </div>
                        ))}
                      </div>
                  }
                </div>
              );
            })()}
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
              <button onClick={() => { let nm=month-1,ny=year; if(nm<0){nm=11;ny--;} setMonth(nm);setYear(ny);setSelDay(null); }} style={{ width: 30, height: 30, borderRadius: 99, border: "1px solid var(--border)", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-2)" }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg></button>
              <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.02em", minWidth: 140, textAlign: "center" }}>{monthNames[month]} {year}</span>
              <button onClick={() => { let nm=month+1,ny=year; if(nm>11){nm=0;ny++;} setMonth(nm);setYear(ny);setSelDay(null); }} style={{ width: 30, height: 30, borderRadius: 99, border: "1px solid var(--border)", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-2)" }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg></button>
              {(month !== new Date().getMonth() || year !== new Date().getFullYear()) && (
                <button onClick={() => { setMonth(new Date().getMonth()); setYear(new Date().getFullYear()); setSelDay(null); }} style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 99, border: "1px solid var(--border)", background: "transparent", cursor: "pointer", color: "var(--text-3)", transition: "all 0.15s" }} onMouseEnter={e => { e.currentTarget.style.borderColor="#3B82F6"; e.currentTarget.style.color="#3B82F6"; }} onMouseLeave={e => { e.currentTarget.style.borderColor="var(--border)"; e.currentTarget.style.color="var(--text-3)"; }}>Today</button>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3, marginBottom: 4 }}>
              {["Mo","Tu","We","Th","Fr","Sa","Su"].map((d, i) => <div key={d} style={{ fontSize: 11, color: i >= 5 ? "var(--text-2)" : "var(--text-3)", textAlign: "center", fontWeight: i >= 5 ? 600 : 500, padding: "3px 0" }}>{d}</div>)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
              {Array.from({ length: fdow }, (_, i) => <div key={`e${i}`} />)}
              {Array.from({ length: dim }, (_, i) => {
                const d=i+1, ds=DS(year,month,d), entries=PLAN[ds]||[], isHol=inH(ds), isSel=selDay===ds, today=ds===TODAY, isSkipped=skipDays.has(ds), dow=new Date(year,month,d).getDay(), isWeekend=dow===0||dow===6;
                const shown = new Set();
                const hasNote = !!calNotes[ds];
                return (
                  <div key={d} className="cal-cell" data-sel={isSel} onClick={() => setSelDay(ds===selDay?null:ds)} style={{ borderRadius: "var(--radius-xs)", padding: "4px 4px 3px", minHeight: 72, cursor: "pointer", border: isSel ? "1.5px solid var(--text-1)" : today ? "1.5px solid #3B82F6" : "1px solid var(--border)", background: isSkipped ? "var(--surface-3)" : isHol ? "var(--holiday-bg)" : isWeekend ? "rgba(148,163,184,0.06)" : "transparent", transition: "all 0.12s" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 2, marginBottom: 2 }}>
                      <span style={{ fontSize: 11, fontWeight: today ? 600 : 500, color: today ? "#3B82F6" : "var(--text-3)" }}>{d}</span>
                      {hasNote && <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#3B82F6", flexShrink: 0 }} />}
                    </div>
                    {entries.map((e, idx) => {
                      if (shown.has(e.subj)) return null; shown.add(e.subj);
                      if (e.subj === "HOLIDAY") return <div key={idx} style={{ fontSize: 8.5, padding: "1.5px 4px", borderRadius: 3, background: "#6EE7B7", color: "#064E3B", fontWeight: 600, marginBottom: 1 }}>Greece</div>;
                      const isEx = EXAM_DATES[ds]===e.subj, mod = MODULES[e.subj];
                      return <div key={idx} style={{ fontSize: 8.5, padding: "1.5px 4px", borderRadius: 3, marginBottom: 1, fontWeight: 600, background: isEx ? mod.color : mod.color+"12", color: isEx ? "#fff" : mod.color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{isEx ? `${e.subj} EXAM` : `${e.subj} [${PHASE_META[e.phase].short}]`}</div>;
                    })}
                    {srDueCounts[ds] > 0 && <div style={{ fontSize: 7.5, padding: "1px 4px", borderRadius: 3, background: "#F59E0B22", color: "#92400e", fontWeight: 700, marginBottom: 1 }}>{srDueCounts[ds]} review{srDueCounts[ds] > 1 ? "s" : ""} due</div>}
                    {isSkipped && <div style={{ fontSize: 7.5, padding: "1px 4px", borderRadius: 3, background: "#94A3B820", color: "var(--text-3)", fontWeight: 600, marginBottom: 1 }}>day off</div>}
                  </div>
                );
              })}
            </div>
            {selDay && (
              <div ref={dayPopupRef} className="slide-down" style={{ marginTop: 10, background: "var(--surface-3)", borderRadius: "var(--radius)", padding: "14px 18px", border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{(() => { const p=selDay.split("-"); return new Date(+p[0],+p[1]-1,+p[2]).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"}); })()}</div>
                  <button onClick={() => toggleSkip(selDay)} style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 99, cursor: "pointer", border: "1.5px solid", flexShrink: 0, borderColor: skipDays.has(selDay) ? "#94A3B8" : "var(--border)", background: skipDays.has(selDay) ? "#94A3B815" : "transparent", color: skipDays.has(selDay) ? "#64748B" : "var(--text-3)" }}>
                    {skipDays.has(selDay) ? "Unmark day off" : "Mark day off"}
                  </button>
                </div>
                {dayEntries.length > 0 && (() => {
                  const merged={}; let totalH=0;
                  for (const e of dayEntries) { if(e.subj==="HOLIDAY"){merged.HOLIDAY={hours:0,phases:["holiday"]};continue;} if(!merged[e.subj])merged[e.subj]={hours:0,phases:[]}; merged[e.subj].hours+=e.hours; if(!merged[e.subj].phases.includes(e.phase))merged[e.subj].phases.push(e.phase); if(EXAM_DATES[selDay]!==e.subj)totalH+=e.hours; }
                  return <>{Object.entries(merged).map(([subj,info]) => (<div key={subj} style={{ display:"flex",alignItems:"center",gap:7,marginBottom:5,fontSize:12.5 }}>{subj==="HOLIDAY" ? <span style={{color:"#10B981",fontWeight:500}}>Greece holiday</span> : <><span style={{width:5,height:5,borderRadius:"50%",background:MODULES[subj]?.color,flexShrink:0}} /><span style={{fontWeight:600}}>{subj}</span><span style={{color:"var(--text-3)"}}>{EXAM_DATES[selDay]===subj?"EXAM DAY":`${Math.round(info.hours*10)/10}h`}</span>{info.phases.map(p => <span key={p} style={{fontSize:10,padding:"2px 6px",borderRadius:99,background:PHASE_META[p].color+"15",color:PHASE_META[p].color,fontWeight:600}}>{PHASE_META[p].label}</span>)}</>}</div>))}{totalH>0 && <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid var(--border)",fontWeight:600,fontSize:12.5,marginBottom:10}}>Total: ~{Math.round(totalH*10)/10} hours</div>}</>;
                })()}
                {(() => {
                  const due = Object.entries(srData).filter(([,e]) => e.nextReview === selDay).map(([key]) => { const [mod, idx] = key.split("-"); const ch = cl[mod]?.[+idx]; return ch ? { mod, name: ch.name } : null; }).filter(Boolean);
                  if (!due.length) return null;
                  return (
                    <div style={{ marginBottom: 10, padding: "8px 10px", borderRadius: "var(--radius-xs)", background: "#F59E0B15", border: "1px solid #F59E0B40" }}>
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: "#92400e", marginBottom: 5 }}>Due for review</div>
                      {due.map(({ mod, name }) => (
                        <div key={`${mod}-${name}`} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--text-2)", marginBottom: 3 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: MODULES[mod].color }} />
                          <span style={{ fontWeight: 600 }}>{mod}</span>
                          <span>{name}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <div style={{ marginTop: dayEntries.length === 0 ? 0 : 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={calNotes[selDay] ? "#3B82F6" : "var(--text-3)"} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                    Notes
                  </div>
                  <textarea className="note-input" rows={3}
                    placeholder="Add notes for this day..."
                    value={calNoteEdit}
                    onChange={e => { setCalNoteEdit(e.target.value); saveCalNote(selDay, e.target.value); }}
                  />
                </div>
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Log study</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                    {MOD_KEYS.map(m => (
                      <button key={m} onClick={() => { setSrMod(m); setSrLog({}); }} style={{ fontSize: 10.5, fontWeight: 600, padding: "3px 9px", borderRadius: 99, border: "1.5px solid", cursor: "pointer", borderColor: srMod === m ? MODULES[m].color : "var(--border)", background: srMod === m ? MODULES[m].color + "15" : "transparent", color: srMod === m ? MODULES[m].color : "var(--text-3)" }}>{m}</button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr repeat(4, auto)", gap: "4px 6px", alignItems: "center", marginBottom: 8 }}>
                    {(cl[srMod] || []).map((ch, idx) => (
                      <Fragment key={idx}>
                        <span style={{ fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ch.name}
                          {srData[`${srMod}-${idx}`]?.lastStudied && <span style={{ fontSize: 9.5, color: "var(--text-3)", marginLeft: 5 }}>Last: {srData[`${srMod}-${idx}`].lastStudied}</span>}
                        </span>
                        {RAG.map(r => (
                          <button key={r.value} onClick={() => setSrLog(prev => prev[idx] === r.value ? (() => { const n={...prev}; delete n[idx]; return n; })() : { ...prev, [idx]: r.value })} style={{ fontSize: 9.5, fontWeight: 600, padding: "2px 7px", borderRadius: 99, border: "none", cursor: "pointer", transition: "opacity 0.1s", background: r.value === "none" ? "var(--rag-none)" : r.bg, color: r.value === "none" ? "var(--rag-none-text)" : r.text, opacity: srLog[idx] === r.value ? 1 : srLog[idx] !== undefined ? 0.3 : 0.8, outline: srLog[idx] === r.value ? "2px solid currentColor" : "none" }}>{r.label}</button>
                        ))}
                      </Fragment>
                    ))}
                  </div>
                  {Object.keys(srLog).length > 0 && (
                    <button onClick={() => logStudy(selDay)} style={{ fontSize: 11.5, fontWeight: 600, padding: "5px 14px", borderRadius: 99, border: "none", cursor: "pointer", background: "#3B82F6", color: "#fff" }}>
                      Save {Object.keys(srLog).length} review{Object.keys(srLog).length > 1 ? "s" : ""}
                    </button>
                  )}
                </div>
              </div>
            )}
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Confidence</div>
              {MOD_KEYS.map(mod => <ProgressBar key={mod} mod={mod} />)}
            </div>
          </div>
        )}

        {/* ===== GANTT ===== */}
        {view === "gantt" && (
          <div className="fade-in">
            {(() => {
              const START = TODAY, END = "2026-05-16";
              const startD = PD(START), endD = PD(END);
              const phaseRanges = {};
              for (const mod of MOD_KEYS) { phaseRanges[mod] = { understand: {}, recall: {}, exam: {} }; }
              for (const [ds, entries] of Object.entries(PLAN)) { for (const e of entries) { if (e.subj === "HOLIDAY" || !phaseRanges[e.subj]) continue; const pr = phaseRanges[e.subj][e.phase]; if (!pr.start || ds < pr.start) pr.start = ds; if (!pr.end || ds > pr.end) pr.end = ds; } }
              const pct = ds => { const d = PD(ds); return Math.max(0, Math.min(100, ((d - startD) / (endD - startD)) * 100)); };
              const monthMarkers = []; const seenM = new Set(); let md = new Date(startD);
              while (md <= endD) { const k = `${md.getFullYear()}-${md.getMonth()}`; if (!seenM.has(k)) { seenM.add(k); const f = new Date(md.getFullYear(), md.getMonth(), 1); const ds = f < startD ? START : DS(f.getFullYear(), f.getMonth(), f.getDate()); monthMarkers.push({ pct: pct(ds), label: monthNames[md.getMonth()].slice(0, 3) }); } md.setDate(md.getDate() + 1); }
              const weekMarkers = []; let wd = new Date(startD); while (wd <= endD) { if (wd.getDay() === 1) weekMarkers.push({ pct: pct(DS(wd.getFullYear(), wd.getMonth(), wd.getDate())), day: wd.getDate() }); wd.setDate(wd.getDate() + 1); }
              const holSP = pct(HOLIDAY.start), holEP = pct(HOLIDAY.end), todayP = pct(TODAY);
              const phC = { understand: "#3B82F6", recall: "#F59E0B", exam: "#EF4444" };
              const LW = 52, RH = 56;
              return (
                <div>
                  <div style={{ display: "flex", gap: 14, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
                    {["understand","recall","exam"].map(p => (<div key={p} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-2)" }}><div style={{ width: 20, height: 8, borderRadius: 4, background: phC[p] }} />{PHASE_META[p].label}</div>))}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-2)" }}><div style={{ width: 20, height: 8, borderRadius: 4, background: "#10B98125", border: "1px dashed #10B981" }} />Holiday</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-2)" }}><div style={{ width: 2, height: 12, background: "#3B82F6" }} />Today</div>
                  </div>
                  <div style={{ display: "flex" }}><div style={{ width: LW, flexShrink: 0 }} /><div style={{ flex: 1, position: "relative", height: 22 }}>{monthMarkers.map((m, i) => { const nP = i < monthMarkers.length - 1 ? monthMarkers[i+1].pct : 100; return <div key={i} style={{ position: "absolute", left: `${m.pct}%`, width: `${nP - m.pct}%`, fontSize: 12, fontWeight: 600, color: "var(--text-2)", paddingLeft: 2 }}>{m.label}</div>; })}</div></div>
                  <div style={{ display: "flex" }}><div style={{ width: LW, flexShrink: 0 }} /><div style={{ flex: 1, position: "relative", height: 18, borderBottom: "1px solid var(--border)" }}>{weekMarkers.map((w, i) => <div key={i} style={{ position: "absolute", left: `${w.pct}%`, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center" }}><span style={{ fontSize: 9.5, color: "var(--text-3)", marginBottom: 2 }}>{w.day}</span><div style={{ width: 1, height: 4, background: "var(--border)" }} /></div>)}</div></div>
                  {MOD_KEYS.map((mod, mi) => {
                    const exP = pct(MODULES[mod].exam);
                    return (
                      <div key={mod} style={{ display: "flex", alignItems: "stretch", height: RH, background: mi % 2 === 0 ? "var(--surface-3)" : "transparent", borderBottom: "1px solid var(--border)" }}>
                        <div style={{ width: LW, flexShrink: 0, display: "flex", flexDirection: "column", justifyContent: "center", paddingRight: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: MODULES[mod].color, textAlign: "right" }}>{mod}</span>
                          <span style={{ fontSize: 9, color: "var(--text-3)", textAlign: "right", marginTop: 1 }}>{MODULES[mod].examLabel.split(",")[0]}</span>
                        </div>
                        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
                          {weekMarkers.map((w, i) => <div key={i} style={{ position: "absolute", left: `${w.pct}%`, top: 0, bottom: 0, width: 1, background: "var(--border)", opacity: 0.5 }} />)}
                          <div style={{ position: "absolute", left: `${holSP}%`, width: `${holEP - holSP}%`, top: 0, bottom: 0, background: "#10B98110", borderLeft: "1px dashed #10B981", borderRight: "1px dashed #10B981" }} />
                          <div style={{ position: "absolute", left: `${todayP}%`, top: 0, bottom: 0, width: 2, background: "#3B82F6", opacity: 0.6, zIndex: 2 }} />
                          {["understand","recall","exam"].map((phase, pi) => {
                            const rng = phaseRanges[mod][phase]; if (!rng.start) return null;
                            const l = pct(rng.start), r = pct(rng.end), w = Math.max(r - l, 0.8);
                            const bH = 10, tBH = 3*bH+2*3, tO = (RH-tBH)/2+pi*(bH+3);
                            return <div key={phase} style={{ position: "absolute", left: `${l}%`, width: `${w}%`, top: tO, height: bH, borderRadius: 99, background: phC[phase], opacity: 0.8, zIndex: 1, transition: "opacity 0.15s" }} title={`${mod} ${PHASE_META[phase].label}: ${rng.start} → ${rng.end}`} onMouseEnter={e => e.currentTarget.style.opacity="1"} onMouseLeave={e => e.currentTarget.style.opacity="0.8"} />;
                          })}
                          <div style={{ position: "absolute", left: `${exP}%`, top: "50%", transform: "translate(-50%, -50%) rotate(45deg)", width: 9, height: 9, background: MODULES[mod].color, borderRadius: 2, zIndex: 3 }} title={`${mod} Exam: ${MODULES[mod].examLabel}`} />
                        </div>
                      </div>
                    );
                  })}

                  {/* Summary cards */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginTop: 20 }}>
                    <div style={{ background: "var(--surface-3)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}><div style={{ fontSize: 10.5, color: "var(--text-3)" }}>Target total</div><div style={{ fontSize: 18, fontWeight: 600 }}>{Math.round(grandTarget)}h</div></div>
                    <div style={{ background: "var(--surface-3)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}><div style={{ fontSize: 10.5, color: "var(--text-3)" }}>Allocated</div><div style={{ fontSize: 18, fontWeight: 600 }}>{Math.round(grandAlloc)}h</div></div>
                    <div style={{ background: "var(--surface-3)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}><div style={{ fontSize: 10.5, color: "var(--text-3)" }}>Study days</div><div style={{ fontSize: 18, fontWeight: 600 }}>{studyDays}</div></div>
                    <div style={{ background: "var(--surface-3)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}><div style={{ fontSize: 10.5, color: "var(--text-3)" }}>Avg/day</div><div style={{ fontSize: 18, fontWeight: 600 }}>{studyDays > 0 ? (Math.round(grandAlloc / studyDays * 10) / 10) : 0}h</div></div>
                  </div>

                  {/* Settings panel */}
                  <div style={{ marginTop: 24 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Study hours settings</div>
                      <button onClick={resetSettings} style={{ fontSize: 11, color: "var(--text-3)", cursor: "pointer", background: "transparent", border: "1px solid var(--border)", borderRadius: 99, padding: "3px 10px", transition: "all 0.15s" }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor="#FCA5A5";e.currentTarget.style.color="#DC2626"; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.color="var(--text-3)"; }}>
                        Reset defaults
                      </button>
                    </div>

                    {/* Daily cap */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, padding: "10px 14px", background: "var(--surface-3)", borderRadius: "var(--radius-sm)" }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-2)" }}>Daily cap</span>
                      <NumInput value={dailyCap} onChange={updateCap} color="#3B82F6" width={60} min={1} max={16} step={0.5} />
                      <span style={{ fontSize: 12, color: "var(--text-3)" }}>hours/day</span>
                    </div>

                    {/* Per module targets */}
                    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) repeat(3,minmax(0,1fr)) minmax(0,0.8fr)", background: "var(--surface-3)", padding: "8px 14px", fontSize: 10.5, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        <div>Module</div><div style={{textAlign:"center"}}>Understand</div><div style={{textAlign:"center"}}>Recall</div><div style={{textAlign:"center"}}>Exam prep</div><div style={{textAlign:"center"}}>Total</div>
                      </div>
                      {MOD_KEYS.map((mod, idx) => {
                        const t = targets[mod], a = allocated[mod];
                        const tT = t.understand + t.recall + t.exam;
                        const aT = Math.round((a.understand + a.recall + a.exam) * 10) / 10;
                        return (
                          <div key={mod} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) repeat(3,minmax(0,1fr)) minmax(0,0.8fr)", alignItems: "center", padding: "8px 14px", borderTop: "1px solid var(--border)", background: idx % 2 === 0 ? "transparent" : "var(--surface-3)" }}>
                            <div><span style={{ fontSize: 13, fontWeight: 600, color: MODULES[mod].color }}>{mod}</span>{weakMods.has(mod) && <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 99, background: "#FCA5A5", color: "#7F1D1D", fontWeight: 600 }}>weak</span>}</div>
                            {["understand","recall","exam"].map(phase => (
                              <div key={phase} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                <NumInput value={t[phase]} onChange={v => updateTarget(mod, phase, v)} color={MODULES[mod].color} />
                                <span style={{ fontSize: 9.5, color: Math.round(a[phase]) >= t[phase] * 0.9 ? "#10B981" : "var(--text-3)" }}>{Math.round(a[phase])}h scheduled</span>
                              </div>
                            ))}
                            <div style={{ textAlign: "center" }}>
                              <div style={{ fontSize: 14, fontWeight: 600 }}>{Math.round(tT)}h</div>
                              <div style={{ fontSize: 9.5, color: aT >= tT * 0.9 ? "#10B981" : "#F59E0B" }}>{aT}h actual</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-3)" }}>
                      The curated schedule scales proportionally to your targets. Adjust hours and daily cap — the calendar updates live.
                    </div>
                  </div>

                  <div style={{ marginTop: 18 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Exam dates</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {MOD_KEYS.map(mod => (<span key={mod} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, padding: "4px 10px", borderRadius: 99, background: MODULES[mod].color + "12", color: MODULES[mod].color, fontWeight: 600 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: MODULES[mod].color }} />{mod}: {MODULES[mod].examLabel}</span>))}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ===== CHECKLIST ===== */}
        {view === "checklist" && (
          <div className="fade-in">
            <div style={{ display: "flex", gap: 5, marginBottom: 14, flexWrap: "wrap" }}>
              {MOD_KEYS.map(mod => <Pill key={mod} active={activeMod===mod} color={MODULES[mod].color} onClick={() => setActiveMod(mod)}>{mod} · {stats(mod).pct}%</Pill>)}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>Exam: <span style={{ fontWeight: 600, color: "var(--text-2)" }}>{MODULES[activeMod].examLabel}</span>{weakMods.has(activeMod) && <span style={{ marginLeft: 8, fontSize: 10.5, padding: "2px 8px", borderRadius: 99, background: "#FCA5A5", color: "#7F1D1D", fontWeight: 600 }}>Needs attention</span>}{(() => { const dl = Math.ceil((PD(MODULES[activeMod].exam) - PD(TODAY)) / (1000*60*60*24)); return <span style={{ marginLeft: 8, fontSize: 10.5, padding: "2px 8px", borderRadius: 99, fontWeight: 600, background: dl <= 7 ? "#FEE2E2" : dl <= 21 ? "#FEF3C7" : MODULES[activeMod].color + "15", color: dl <= 7 ? "#DC2626" : dl <= 21 ? "#92400E" : MODULES[activeMod].color }}>{dl > 0 ? `${dl}d to exam` : dl === 0 ? "Exam today!" : "Exam passed"}</span>; })()}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ display: "flex", gap: 6 }}>{RAG.map(r => <div key={r.value} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10.5, color: "var(--text-3)" }}><div style={{ width: 7, height: 7, borderRadius: "50%", background: r.value==="none"?"var(--rag-none)":r.bg }} />{r.label}</div>)}</div>
                <button onClick={() => setShowWeakOnly(v => !v)} style={{ fontSize: 10.5, fontWeight: 600, padding: "3px 9px", borderRadius: 99, border: "1.5px solid", cursor: "pointer", borderColor: showWeakOnly ? "#EF4444" : "var(--border)", background: showWeakOnly ? "#FEE2E2" : "transparent", color: showWeakOnly ? "#DC2626" : "var(--text-3)", transition: "all 0.15s" }}>
                  {showWeakOnly ? "Showing weak" : "Show weak only"}
                </button>
              </div>
            </div>
            <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2.2fr) repeat(3,minmax(0,1fr)) 28px 28px", background: "var(--surface-3)", padding: "9px 14px", fontSize: 10.5, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}><div>Chapter</div><div style={{textAlign:"center"}}>Understand</div><div style={{textAlign:"center"}}>Recall</div><div style={{textAlign:"center"}}>Exam prep</div><div/><div/></div>
              {(cl[activeMod]||[]).flatMap((ch, idx) => {
                if (showWeakOnly && ch.u === "green" && ch.r === "green" && ch.e === "green") return [];
                const noteKey = `${activeMod}-${idx}`;
                const hasNote = !!chNotes[noteKey];
                const isExpanded = !!expandedNotes[noteKey];
                return (
                  <div key={idx} style={{ borderTop: "1px solid var(--border)" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2.2fr) repeat(3,minmax(0,1fr)) 28px 28px", alignItems: "center", padding: "9px 14px", background: idx%2===0 ? "transparent" : "var(--surface-3)" }}>
                      <div>{editing===`${activeMod}-${idx}` ? (<input ref={inputRef} type="text" value={editVal} onChange={e => setEditVal(e.target.value)} onBlur={() => { renameFn(activeMod,idx,editVal||ch.name); setEditing(null); }} onKeyDown={e => { if(e.key==="Enter"){renameFn(activeMod,idx,editVal||ch.name);setEditing(null);} }} style={{ fontSize: 13, fontWeight: 500, border: "none", borderBottom: "2px solid #3B82F6", background: "transparent", color: "var(--text-1)", width: "100%", outline: "none", padding: "2px 0", fontFamily: "'DM Sans', system-ui" }} />) : (<div onClick={() => { setEditing(`${activeMod}-${idx}`); setEditVal(ch.name); }} style={{ fontSize: 13, fontWeight: 500, cursor: "text", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "2px 0" }}>{ch.name}</div>)}</div>
                      {["u","r","e"].map(phase => (<div key={phase} style={{ display: "flex", justifyContent: "center" }}><RagSelect value={ch[phase]} onChange={v => updateCl(activeMod,idx,phase,v)} /></div>))}
                      <div style={{ display: "flex", justifyContent: "center" }}><button onClick={() => removeCh(activeMod,idx)} style={{ width: 22, height: 22, borderRadius: 99, background: "transparent", border: "none", cursor: "pointer", color: "var(--text-3)", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }} onMouseEnter={e => { e.currentTarget.style.background="#FEE2E2";e.currentTarget.style.color="#DC2626"; }} onMouseLeave={e => { e.currentTarget.style.background="transparent";e.currentTarget.style.color="var(--text-3)"; }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>
                      <div style={{ display: "flex", justifyContent: "center" }}><button onClick={() => setExpandedNotes(prev => ({ ...prev, [noteKey]: !prev[noteKey] }))} style={{ width: 22, height: 22, borderRadius: 99, background: isExpanded ? "#EFF6FF" : "transparent", border: "none", cursor: "pointer", color: hasNote ? "#3B82F6" : "var(--text-3)", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }} title={isExpanded ? "Hide note" : "Add note"}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></button></div>
                    </div>
                    {isExpanded && (
                      <div style={{ padding: "6px 14px 12px", background: idx%2===0 ? "var(--surface-2)" : "var(--surface-3)", borderTop: "1px dashed var(--border)" }}>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4, gap: 4 }}>
                          {["Edit","Preview"].map(mode => (
                            <button key={mode} onClick={() => setEditingNote(prev => ({ ...prev, [noteKey]: mode === "Edit" }))} style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 99, border: "none", cursor: "pointer", background: (editingNote[noteKey] ?? true) === (mode === "Edit") ? "var(--border)" : "transparent", color: "var(--text-3)" }}>{mode}</button>
                          ))}
                        </div>
                        {(editingNote[noteKey] ?? true)
                          ? <textarea className="note-input" autoFocus rows={4}
                              placeholder={`Notes for ${ch.name}...\n\nSupports **bold**, *italic*, \`code\`, and - bullets`}
                              defaultValue={chNotes[noteKey] || ""}
                              onChange={e => saveChNote(noteKey, e.target.value)}
                            />
                          : <div className="md-preview" dangerouslySetInnerHTML={{ __html: mdPreview(chNotes[noteKey] || "") || '<span style="color:var(--text-3);font-size:12px">No notes yet</span>' }} />
                        }
                      </div>
                    )}
                  </div>
                );
              })}
              <div style={{ borderTop: "1px solid var(--border)", padding: 4 }}><button onClick={() => addCh(activeMod)} style={{ width: "100%", padding: "9px", fontSize: 12.5, fontWeight: 500, background: "transparent", border: "1.5px dashed var(--border)", borderRadius: "var(--radius-xs)", cursor: "pointer", color: "var(--text-3)", transition: "all 0.15s" }} onMouseEnter={e => { e.currentTarget.style.borderColor=MODULES[activeMod].color; e.currentTarget.style.color=MODULES[activeMod].color; }} onMouseLeave={e => { e.currentTarget.style.borderColor="var(--border)"; e.currentTarget.style.color="var(--text-3)"; }}>+ Add chapter</button></div>
            </div>
            <div style={{ marginTop: 22 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>All modules</div>
              {MOD_KEYS.map(mod => (<div key={mod} onClick={() => setActiveMod(mod)} style={{ cursor: "pointer", padding: "5px 8px", borderRadius: "var(--radius-xs)", background: activeMod===mod ? "var(--surface-3)" : "transparent", transition: "background 0.15s" }}><ProgressBar mod={mod} /></div>))}
            </div>
            {/* Past paper tracker */}
            <div style={{ marginTop: 24 }}>
              {(() => {
                const scored = (ppData[activeMod] || []).filter(e => e.score != null);
                const avg = scored.length ? Math.round(scored.reduce((s, e) => s + e.score, 0) / scored.length) : null;
                return (
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: 8 }}>
                    Past Papers — {activeMod}
                    {avg !== null && <span style={{ fontSize: 11.5, fontWeight: 600, padding: "2px 9px", borderRadius: 99, textTransform: "none", letterSpacing: 0, background: avg >= 70 ? "#6EE7B730" : avg >= 50 ? "#FCD34D30" : "#FCA5A530", color: avg >= 70 ? "#065F46" : avg >= 50 ? "#78350F" : "#7F1D1D" }}>Avg {avg}%</span>}
                  </div>
                );
              })()}
              {(ppData[activeMod] || []).length === 0
                ? <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 10 }}>No papers logged yet</div>
                : <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", marginBottom: 10 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 56px 1fr 28px", background: "var(--surface-3)", padding: "8px 12px", fontSize: 10.5, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      <div>Date</div><div>Paper</div><div style={{textAlign:"center"}}>Score</div><div>Notes</div><div/>
                    </div>
                    {(ppData[activeMod] || []).map(e => (
                      <div key={e.id} style={{ display: "grid", gridTemplateColumns: "80px 1fr 56px 1fr 28px", alignItems: "center", padding: "8px 12px", fontSize: 12.5, borderTop: "1px solid var(--border)" }}>
                        <div style={{ color: "var(--text-3)", fontSize: 11.5 }}>{e.date}</div>
                        <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.paper}</div>
                        <div style={{ textAlign: "center", fontWeight: 600, color: e.score == null ? "var(--text-3)" : e.score >= 70 ? "#10B981" : e.score >= 50 ? "#F59E0B" : "#EF4444" }}>{e.score == null ? "—" : `${e.score}%`}</div>
                        <div style={{ fontSize: 11.5, color: "var(--text-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.notes || "—"}</div>
                        <div><button onClick={() => removePP(activeMod, e.id)} style={{ width: 22, height: 22, borderRadius: 99, background: "transparent", border: "none", cursor: "pointer", color: "var(--text-3)", display: "flex", alignItems: "center", justifyContent: "center" }} onMouseEnter={el => { el.currentTarget.style.background="#FEE2E2"; el.currentTarget.style.color="#DC2626"; }} onMouseLeave={el => { el.currentTarget.style.background="transparent"; el.currentTarget.style.color="var(--text-3)"; }}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>
                      </div>
                    ))}
                  </div>
              }
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input placeholder="Paper name" value={ppForm.paper} onChange={e => setPpForm(p => ({...p, paper: e.target.value}))} style={{ flex: 2, minWidth: 110, fontSize: 12.5, padding: "6px 10px", borderRadius: "var(--radius-xs)", border: "1.5px solid var(--border)", background: "transparent", color: "var(--text-1)", outline: "none" }} />
                <input placeholder="Score %" value={ppForm.score} type="number" min={0} max={100} onChange={e => setPpForm(p => ({...p, score: e.target.value}))} style={{ width: 72, fontSize: 12.5, padding: "6px 8px", borderRadius: "var(--radius-xs)", textAlign: "center", border: "1.5px solid var(--border)", background: "transparent", color: "var(--text-1)", outline: "none" }} />
                <input placeholder="Notes (optional)" value={ppForm.notes} onChange={e => setPpForm(p => ({...p, notes: e.target.value}))} style={{ flex: 3, minWidth: 110, fontSize: 12.5, padding: "6px 10px", borderRadius: "var(--radius-xs)", border: "1.5px solid var(--border)", background: "transparent", color: "var(--text-1)", outline: "none" }} />
                <button onClick={() => addPP(activeMod, ppForm)} style={{ fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 99, border: "none", cursor: "pointer", background: MODULES[activeMod].color, color: "#fff" }}>Add</button>
              </div>
            </div>
            <button onClick={resetCl} style={{ marginTop: 14, fontSize: 11.5, color: "var(--text-3)", cursor: "pointer", background: "transparent", border: "1px solid var(--border)", borderRadius: 99, padding: "5px 14px", transition: "all 0.15s" }} onMouseEnter={e => { e.currentTarget.style.borderColor="#FCA5A5";e.currentTarget.style.color="#DC2626"; }} onMouseLeave={e => { e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.color="var(--text-3)"; }}>Reset all progress</button>
          </div>
        )}
      </div>
    </>
  );
}
