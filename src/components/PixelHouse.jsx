import React, { useMemo, useRef } from "react";

/**
 * PixelHouse.jsx
 * Tiny pixel‑art house that builds up as pct (0–100) increases.
 *
 * Props
 *  - pct   : number 0..100  (progress within current level or overall)
 *  - size  : number          (CSS pixels; default 192)
 *  - label : string          (optional caption under the house)
 *
 * Layers unlock order (thresholds %):
 *   ground(0) → foundation(5) → walls(15) → roof(30) → door+windows(45)
 *   → chimney(60) → tree(75) → smoke(90) → sparkle(100)
 */
export default function PixelHouse({ pct = 0, size = 192, label }) {
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
  const P = clamp(pct);
  const prevPct = useRef(P);
  const poppedSince = useRef(0);
  if (P > prevPct.current) { poppedSince.current = Date.now(); prevPct.current = P; }

  const grid = 16; // 16x16 pixel art
  const unit = size / grid;

  // helper to place a pixel at (x,y) with a color
  const px = (x, y, color, key, animate = false) => (
    <div
      key={key}
      className={`absolute rounded-[2px] ${animate ? "animate-pulse-scale" : ""}`}
      style={{ left: x * unit, top: y * unit, width: unit, height: unit, background: color }}
    />
  );

  // palette (NES-ish)
  const C = {
    sky: "#cbe7ff",
    grass: "#6bbf59",
    dirt: "#8d5a35",
    wall: "#d8b38a",
    roof: "#cf4e4e",
    shadow: "#b99977",
    door: "#7b4a2e",
    window: "#8fd7ff",
    trunk: "#6b4423",
    leaf: "#2fa34f",
    smoke: "#eeeeee",
    stone: "#b9b9b9",
  };

  // --- LAYERS ---
  const layers = useMemo(() => {
    const L = [];

    // 1) Ground (grass + dirt)
    const ground = [];
    for (let x = 0; x < grid; x++) {
      ground.push({ x, y: 13, c: C.grass });
      ground.push({ x, y: 14, c: C.dirt });
      ground.push({ x, y: 15, c: C.dirt });
    }
    L.push({ name: "ground", t: 0, pixels: ground });

    // 2) Foundation (stones)
    const foundation = [];
    for (let x = 3; x <= 12; x++) foundation.push({ x, y: 12, c: C.stone });
    L.push({ name: "foundation", t: 5, pixels: foundation });

    // 3) Walls (beige)
    const walls = [];
    for (let y = 7; y <= 11; y++)
      for (let x = 4; x <= 11; x++) walls.push({ x, y, c: (y % 2 === 0 && x % 2 === 0) ? C.shadow : C.wall });
    L.push({ name: "walls", t: 15, pixels: walls });

    // 4) Roof (red triangle)
    const roof = [];
    let left = 3, right = 12;
    for (let y = 3; y <= 6; y++) {
      for (let x = left; x <= right; x++) roof.push({ x, y, c: C.roof });
      left++; right--;
    }
    L.push({ name: "roof", t: 30, pixels: roof });

    // 5) Door + windows
    const deco = [];
    // door
    for (let y = 9; y <= 11; y++) for (let x = 7; x <= 8; x++) deco.push({ x, y, c: C.door });
    // windows
    for (let y = 8; y <= 9; y++) for (let x = 5; x <= 6; x++) deco.push({ x, y, c: C.window });
    for (let y = 8; y <= 9; y++) for (let x = 9; x <= 10; x++) deco.push({ x, y, c: C.window });
    L.push({ name: "details", t: 45, pixels: deco });

    // 6) Chimney
    const chimney = [];
    for (let y = 2; y <= 4; y++) for (let x = 10; x <= 11; x++) chimney.push({ x, y, c: C.stone });
    L.push({ name: "chimney", t: 60, pixels: chimney });

    // 7) Tree (trunk + leaves)
    const tree = [];
    for (let y = 10; y <= 12; y++) tree.push({ x: 1, y, c: C.trunk });
    for (let y = 8; y <= 10; y++) for (let x = 0; x <= 2; x++) tree.push({ x, y, c: C.leaf });
    L.push({ name: "tree", t: 75, pixels: tree });

    // 8) Smoke puffs
    const smoke = [ { x: 12, y: 1, c: C.smoke }, { x: 13, y: 0, c: C.smoke } ];
    L.push({ name: "smoke", t: 90, pixels: smoke });

    // 9) Sparkle on 100
    const sparkle = [ { x: 8, y: 2, c: "#ffffff" }, { x: 2, y: 6, c: "#ffffff" }, { x: 14, y: 6, c: "#ffffff" } ];
    L.push({ name: "sparkle", t: 100, pixels: sparkle });

    return L;
  }, []);

  // which layers are currently visible by pct
  const visible = layers.filter((L) => P >= L.t);

  // any new layer appeared recently? add a pop animation for ~600ms
  const animatePop = Date.now() - poppedSince.current < 600;

  return (
    <div className="w-full flex flex-col items-center select-none">
      <div
        className="relative rounded-xl border bg-white overflow-hidden pixelated"
        style={{ width: size, height: size, boxShadow: "inset 0 0 0 4px #ffffff" }}
      >
        {/* sky background */}
        <div className="absolute inset-0" style={{ background: "#eaf6ff" }} />
        {/* draw pixels */}
        {visible.map((L) =>
          L.pixels.map((p, i) => px(p.x, p.y, p.c, `${L.name}-${i}`, animatePop))
        )}
      </div>
      {label && <div className="mt-2 text-sm text-slate-700">{label}</div>}
      <div className="mt-1 text-xs text-slate-500">{P}%</div>
      <style>{`
        .pixelated { image-rendering: pixelated; image-rendering: crisp-edges; }
        @keyframes pulse-scale { 0%{transform:scale(0.6);} 60%{transform:scale(1.15);} 100%{transform:scale(1);} }
        .animate-pulse-scale { animation: pulse-scale 0.35s ease-out; }
      `}</style>
    </div>
  );
}
