import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float, MeshTransmissionMaterial, Environment, Sparkles } from "@react-three/drei";
import type { Mesh } from "three";

/** 悬浮玻璃球：外层透射玻璃 + 内层流光体，缓慢旋转、上下悬浮 */
function GlassOrb() {
  const inner = useRef<Mesh>(null);
  useFrame((state, delta) => {
    if (inner.current) {
      inner.current.rotation.y += delta * 0.35;
      inner.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.4) * 0.25;
    }
  });
  return (
    <Float speed={2.2} rotationIntensity={0.4} floatIntensity={1.6}>
      {/* 内层流光体 */}
      <mesh ref={inner} scale={0.78}>
        <icosahedronGeometry args={[1, 5]} />
        <meshPhysicalMaterial
          color="#a78bfa"
          emissive="#7c3aed"
          emissiveIntensity={0.55}
          roughness={0.15}
          metalness={0.35}
          iridescence={1}
          iridescenceIOR={1.6}
        />
      </mesh>
      {/* 外层玻璃罩 */}
      <mesh>
        <sphereGeometry args={[1, 64, 64]} />
        <MeshTransmissionMaterial
          transmission={1}
          thickness={0.6}
          roughness={0.08}
          ior={1.45}
          chromaticAberration={0.35}
          anisotropy={0.3}
          distortion={0.25}
          distortionScale={0.6}
          temporalDistortion={0.15}
          color="#e9d5ff"
          attenuationColor="#c4b5fd"
          attenuationDistance={2.5}
        />
      </mesh>
    </Float>
  );
}

/** WebGL 不可用时的降级方案 */
class GLBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) {
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-44 w-44 animate-pulse rounded-full bg-[radial-gradient(circle_at_35%_30%,#f5d0fe_0%,#a78bfa_45%,#4c1d95_100%)] shadow-[0_0_60px_20px_rgba(167,139,250,0.45)]" />
        </div>
      );
    }
    return this.props.children;
  }
}

function useCountUp(target: number, duration = 900) {
  const [value, setValue] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    const from = prev.current;
    prev.current = target;
    if (from === target) { setValue(target); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

export function EnergyOrb(props: {
  kwh: number;
  label: string;
}) {
  const display = useCountUp(props.kwh);
  return (
    <div className="relative h-[300px] w-full select-none">
      {/* 底部辉光 */}
      <div className="absolute left-1/2 top-[62%] h-10 w-56 -translate-x-1/2 rounded-[100%] bg-violet-500/30 blur-2xl" />
      <GLBoundary>
        <Canvas camera={{ position: [0, 0, 3.4], fov: 42 }} dpr={[1, 2]} gl={{ alpha: true, antialias: true }}>
          <ambientLight intensity={0.6} />
          <pointLight position={[4, 4, 4]} intensity={30} color="#c4b5fd" />
          <pointLight position={[-4, -2, 3]} intensity={18} color="#67e8f9" />
          <Suspense fallback={null}>
            <GlassOrb />
            <Sparkles count={42} scale={5} size={2.2} speed={0.35} color="#ddd6fe" opacity={0.55} />
            <Environment preset="city" />
          </Suspense>
        </Canvas>
      </GLBoundary>
      {/* 中央数字 */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[11px] font-medium tracking-[0.3em] text-violet-200/80">{props.label}</div>
        <div className="mt-1 text-4xl font-black tabular-nums text-white drop-shadow-[0_2px_12px_rgba(139,92,246,0.65)]">
          {Math.round(display).toLocaleString("zh-CN")}
        </div>
        <div className="mt-0.5 text-xs font-medium text-violet-200/90">kWh · 度</div>
      </div>
    </div>
  );
}
