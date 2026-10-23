"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// The landing-page "Qube": a 3×3×3 lattice of gold and blue cubelets (the logo's colours)
// that breathes, sends a teal hash-pulse through itself and twists a layer now and then,
// while particles stream in from outside (rented hashrate flowing to the pool) and rings
// of rigs orbit it. Follows the pointer, pauses off-screen, renders one still frame for
// prefers-reduced-motion, and re-colours itself when the theme changes.

const SPACING = 0.7;
const CUBE = 0.62;
const STREAM_COUNT = 420;
const TWIST_EVERY = 4.5; // seconds between layer turns
const TWIST_TIME = 0.9;

type Theme = "dark" | "light";
const themeNow = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

const PALETTE = {
  dark: { accent: 0x4fd1c5, blue: 0x1a7dff, gold: 0xf0c014, cage: 0x4fd1c5, cageOpacity: 0.35, exposure: 1.15, additive: true },
  light: { accent: 0x0d9488, blue: 0x1765e6, gold: 0xb58900, cage: 0x0d9488, cageOpacity: 0.45, exposure: 1.0, additive: false },
};

interface Cubelet {
  mesh: THREE.Mesh<RoundedBoxGeometry, THREE.MeshPhysicalMaterial>;
  grid: THREE.Vector3; // logical position, each axis in {-1, 0, 1}
}

function ringPoints(radius: number, count: number, jitter: number): THREE.BufferGeometry {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = radius + (Math.random() - 0.5) * jitter;
    pos.set([Math.cos(a) * r, (Math.random() - 0.5) * jitter * 0.4, Math.sin(a) * r], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export default function QubeScene({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = "block";
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;

    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 0.4, 10);

    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(4, 6, 5);
    const rim = new THREE.PointLight(0x4fd1c5, 18, 20);
    rim.position.set(-4, -2, -3);
    scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.15));

    // ---- The Qube ----
    const world = new THREE.Group();
    world.rotation.set(0.55, -0.6, 0);
    scene.add(world);
    const qube = new THREE.Group();
    world.add(qube);

    const geo = new RoundedBoxGeometry(CUBE, CUBE, CUBE, 4, 0.09);
    const cubelets: Cubelet[] = [];
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          if (x === 0 && y === 0 && z === 0) continue;
          // Gold on the left and top, blue on the right: the logo's split.
          const gold = x < 0 || (x === 0 && y >= 0);
          const mat = new THREE.MeshPhysicalMaterial({
            color: gold ? 0xf0b90b : 0x1a6dff,
            metalness: 0.95,
            roughness: gold ? 0.26 : 0.3,
            clearcoat: 0.6,
            clearcoatRoughness: 0.2,
            emissive: 0x4fd1c5,
            emissiveIntensity: 0,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(x, y, z).multiplyScalar(SPACING);
          qube.add(mesh);
          cubelets.push({ mesh, grid: new THREE.Vector3(x, y, z) });
        }

    // Wireframe cage and corner nodes.
    const cageMat = new THREE.LineBasicMaterial({ transparent: true });
    const cage = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2.9, 2.9, 2.9)), cageMat);
    world.add(cage);
    const outerMat = new THREE.LineBasicMaterial({ transparent: true });
    const outer = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(2.9)), outerMat);
    world.add(outer);

    // Orbiting rig rings.
    const ringMats = [0, 1, 2].map(() => new THREE.PointsMaterial({ size: 0.035, transparent: true, depthWrite: false }));
    const rings = [
      new THREE.Points(ringPoints(3.1, 520, 0.25), ringMats[0]),
      new THREE.Points(ringPoints(3.7, 380, 0.35), ringMats[1]),
      new THREE.Points(ringPoints(4.4, 300, 0.5), ringMats[2]),
    ];
    rings[0].rotation.set(1.2, 0, 0.3);
    rings[1].rotation.set(0.4, 0, -0.9);
    rings[2].rotation.set(-0.7, 0, 0.5);
    rings.forEach((r) => scene.add(r));

    // Hash streams: particles fall from a shell into the Qube and respawn.
    const streamPos = new Float32Array(STREAM_COUNT * 3);
    const streamDir: THREE.Vector3[] = [];
    const streamR = new Float32Array(STREAM_COUNT);
    const streamV = new Float32Array(STREAM_COUNT);
    const spawn = (i: number, initial: boolean) => {
      streamDir[i] = new THREE.Vector3().randomDirection();
      streamR[i] = initial ? 1.6 + Math.random() * 5 : 5.5 + Math.random() * 1.5;
      streamV[i] = 1.2 + Math.random() * 1.8;
    };
    for (let i = 0; i < STREAM_COUNT; i++) spawn(i, true);
    const streamGeo = new THREE.BufferGeometry();
    streamGeo.setAttribute("position", new THREE.BufferAttribute(streamPos, 3));
    const streamMat = new THREE.PointsMaterial({ size: 0.045, transparent: true, depthWrite: false });
    const stream = new THREE.Points(streamGeo, streamMat);
    world.add(stream);

    // ---- Theme ----
    const applyTheme = () => {
      const p = PALETTE[themeNow()];
      renderer.toneMappingExposure = p.exposure;
      cageMat.color.set(p.cage);
      cageMat.opacity = p.cageOpacity;
      outerMat.color.set(p.blue);
      outerMat.opacity = p.cageOpacity * 0.45;
      const blending = p.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
      [p.accent, p.blue, p.gold].forEach((c, i) => {
        ringMats[i].color.set(c);
        ringMats[i].blending = blending;
        ringMats[i].opacity = p.additive ? 0.9 : 0.7;
        ringMats[i].needsUpdate = true;
      });
      streamMat.color.set(p.accent);
      streamMat.blending = blending;
      streamMat.opacity = p.additive ? 0.95 : 0.8;
      streamMat.needsUpdate = true;
      rim.color.set(p.accent);
      cubelets.forEach((c) => c.mesh.material.emissive.set(p.accent));
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // ---- Sizing ----
    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      // Pull back on narrow screens so the rings stay in frame.
      camera.position.z = w / h < 1 ? 13 : 10;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // ---- Pointer parallax ----
    const pointer = new THREE.Vector2();
    const onPointer = (e: PointerEvent) => {
      pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    // ---- Layer twists ----
    let twist: { pivot: THREE.Object3D; axis: "x" | "y" | "z"; dir: number; start: number } | null = null;
    let nextTwist = 2;
    const startTwist = (t: number) => {
      const axis = (["x", "y", "z"] as const)[Math.floor(Math.random() * 3)];
      const layer = Math.floor(Math.random() * 3) - 1;
      const pivot = new THREE.Object3D();
      qube.add(pivot);
      for (const c of cubelets) if (Math.round(c.grid[axis]) === layer) pivot.attach(c.mesh);
      twist = { pivot, axis, dir: Math.random() < 0.5 ? 1 : -1, start: t };
    };
    const finishTwist = () => {
      if (!twist) return;
      twist.pivot.rotation[twist.axis] = (twist.dir * Math.PI) / 2;
      twist.pivot.updateMatrixWorld();
      for (const c of [...twist.pivot.children] as THREE.Mesh[]) qube.attach(c);
      qube.remove(twist.pivot);
      for (const c of cubelets) {
        c.grid.copy(c.mesh.position).divideScalar(SPACING).round();
        c.mesh.position.copy(c.grid).multiplyScalar(SPACING);
      }
      twist = null;
    };

    // ---- Loop ----
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clock = new THREE.Clock();
    let raf = 0;
    let visible = true;
    let elapsed = 0;
    const pulseDir = new THREE.Vector3(1, 0.6, 0.3).normalize();
    const tmp = new THREE.Vector3();

    const frame = (dt: number) => {
      elapsed += dt;
      const t = elapsed;

      // Twist scheduling; no breathing while a layer turns so the lattice stays aligned.
      if (!twist && t > nextTwist) startTwist(t);
      if (twist) {
        const k = Math.min(1, (t - twist.start) / TWIST_TIME);
        twist.pivot.rotation[twist.axis] = (twist.dir * Math.PI * easeInOut(k)) / 2;
        if (k >= 1) {
          finishTwist();
          nextTwist = t + TWIST_EVERY;
        }
      } else {
        const breathe = 1 + 0.05 * (0.5 + 0.5 * Math.sin(t * 1.1));
        for (const c of cubelets) c.mesh.position.copy(c.grid).multiplyScalar(SPACING * breathe);
      }

      // Hash pulse: a teal wave sweeping through the cubelets.
      for (const c of cubelets) {
        const d = c.grid.dot(pulseDir);
        const wave = Math.max(0, Math.sin(t * 2.2 - d * 1.6));
        c.mesh.material.emissiveIntensity = Math.pow(wave, 12) * 0.35;
      }

      // Streams fall inward and respawn at the shell.
      for (let i = 0; i < STREAM_COUNT; i++) {
        streamR[i] -= streamV[i] * dt;
        if (streamR[i] < 1.3) spawn(i, false);
        tmp.copy(streamDir[i]).multiplyScalar(streamR[i]);
        streamPos.set([tmp.x, tmp.y, tmp.z], i * 3);
      }
      streamGeo.attributes.position.needsUpdate = true;

      rings[0].rotation.y += dt * 0.25;
      rings[1].rotation.y -= dt * 0.18;
      rings[2].rotation.y += dt * 0.1;
      outer.rotation.y -= dt * 0.12;
      outer.rotation.x += dt * 0.05;

      // Slow spin plus pointer parallax, eased.
      world.rotation.y += dt * 0.22;
      const tx = 0.55 + pointer.y * 0.25;
      world.rotation.x += (tx - world.rotation.x) * Math.min(1, dt * 3);
      camera.position.x += (pointer.x * 0.9 - camera.position.x) * Math.min(1, dt * 2.5);
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      frame(Math.min(clock.getDelta(), 1 / 20));
    };
    const play = () => {
      if (reduced || raf || !visible || document.hidden) return;
      clock.getDelta();
      loop();
    };
    const pause = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    if (reduced) {
      frame(0.8); // one composed, still frame
    } else {
      play();
    }
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) play();
      else pause();
    });
    io.observe(el);
    const onVis = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", onVis);
    // Re-render the still frame on theme change when not animating.
    const themeRedraw = new MutationObserver(() => reduced && renderer.render(scene, camera));
    themeRedraw.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      pause();
      io.disconnect();
      ro.disconnect();
      themeObserver.disconnect();
      themeRedraw.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onPointer);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
      geo.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  if (failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src="/logo.png" alt="BitQube" className={className} style={{ objectFit: "contain", padding: "15%" }} />;
  }
  return <div ref={host} className={className} aria-hidden="true" />;
}
