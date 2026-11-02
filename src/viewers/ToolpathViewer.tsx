import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Toolpath } from '../loaders/gcode.ts';
import { fetchBuffer, parseToolpath } from '../loaders/parseClient.ts';
import { ViewerError, ViewerLoading, formatNumber } from './common.tsx';
import { STAGE_COLOR, addGrid, frameCamera, toolpathBox, toolpathObjects } from './scene3d.ts';
import { t } from '../i18n.ts';

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function ToolpathViewer({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const applyRange = useRef<(layer: number, travels: boolean) => void>(() => {});
  const [toolpath, setToolpath] = useState<Toolpath | null>(null);
  const [error, setError] = useState('');
  const [layer, setLayer] = useState(0);
  const [travels, setTravels] = useState(false);

  useEffect(() => {
    const container = host.current!;
    let cancelled = false;
    let cleanup = () => {};

    (async () => {
      try {
        const parsed = await parseToolpath(await fetchBuffer(url));
        if (cancelled) return;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(STAGE_COLOR);
        const { group, feed, travel } = toolpathObjects(parsed);
        group.rotation.x = -Math.PI / 2;
        scene.add(group);

        // Rest the path on the grid and centre it on the origin, as the model viewer does.
        const box = toolpathBox(parsed, group);
        const center = box.getCenter(new THREE.Vector3());
        group.position.set(-center.x, -box.min.y, -center.z);
        const framed = toolpathBox(parsed, group);
        const grid = addGrid(scene, framed);

        const camera = new THREE.PerspectiveCamera(32, 1);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.12;

        let frame = 0;
        const render = () => {
          frame = 0;
          if (controls.update()) schedule();
          renderer.render(scene, camera);
        };
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(render);
        };
        controls.addEventListener('change', schedule);

        const resize = () => {
          const { clientWidth: width, clientHeight: height } = container;
          if (!width || !height) return;
          renderer.setSize(width, height);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          schedule();
        };
        const observer = new ResizeObserver(resize);
        observer.observe(container);
        resize();
        frameCamera(camera, framed, parsed.flat ? 'top' : 'iso', controls.target);
        controls.update();

        applyRange.current = (index, showTravels) => {
          const end = parsed.layers[index];
          feed.geometry.setDrawRange(0, end ? end.feedEnd : Infinity);
          travel.visible = showTravels;
          travel.geometry.setDrawRange(0, end ? end.travelEnd : Infinity);
          schedule();
        };

        const lastLayer = Math.max(0, parsed.layers.length - 1);
        const showTravels = parsed.mode === 'cut';
        applyRange.current(lastLayer, showTravels);
        setLayer(lastLayer);
        setTravels(showTravels);
        setToolpath(parsed);

        cleanup = () => {
          if (frame) cancelAnimationFrame(frame);
          observer.disconnect();
          controls.dispose();
          feed.geometry.dispose();
          travel.geometry.dispose();
          (feed.material as THREE.Material).dispose();
          (travel.material as THREE.Material).dispose();
          grid.geometry.dispose();
          (grid.material as THREE.Material).dispose();
          renderer.dispose();
          renderer.forceContextLoss();
          renderer.domElement.remove();
        };
      } catch (loadError) {
        console.warn(loadError);
        if (!cancelled) setError((loadError as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [url]);

  const lastLayer = toolpath ? Math.max(0, toolpath.layers.length - 1) : 0;

  return (
    <div className="stage" ref={host}>
      {!toolpath && !error && <ViewerLoading label={t('Reading the toolpath')} />}
      {error && <ViewerError message={error} />}
      {toolpath && (
        <>
          <div className="hud hud-top">
            <label className="hud-btn hud-check">
              <input
                type="checkbox"
                checked={travels}
                onChange={(event) => {
                  setTravels(event.target.checked);
                  applyRange.current(layer, event.target.checked);
                }}
              />{t('Travel moves')}</label>
          </div>
          {lastLayer > 0 && (
            <div className="layer-slider" dir="ltr">
              <input
                type="range"
                min={0}
                max={lastLayer}
                value={layer}
                aria-label={t('Layer')}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setLayer(value);
                  applyRange.current(value, travels);
                }}
              />
              <span>Layer {layer + 1} / {lastLayer + 1} · Z {formatNumber(toolpath.layers[layer]?.z ?? 0)}</span>
            </div>
          )}
          <div className="hud hud-bottom readout" dir="ltr">
            <span>
              {formatNumber(toolpath.max[0] - toolpath.min[0])} × {formatNumber(toolpath.max[1] - toolpath.min[1])} × {formatNumber(toolpath.max[2] - toolpath.min[2])} mm
            </span>
            <span>{formatNumber(toolpath.feedLength / 1000)} m path</span>
            {toolpath.seconds > 0 && <span>≈ {formatDuration(toolpath.seconds)}</span>}
            <span>{toolpath.mode === 'print' ? '3D print' : 'CNC / laser'}</span>
          </div>
        </>
      )}
    </div>
  );
}
