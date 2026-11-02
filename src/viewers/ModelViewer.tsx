import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fetchBuffer } from '../loaders/parseClient.ts';
import { disposeObject, loadModel } from '../loaders/model.ts';
import { ViewerError, ViewerLoading, formatNumber } from './common.tsx';
import { STAGE_COLOR, addGrid, environmentFor, frameCamera, stageObject } from './scene3d.ts';
import type { ViewName } from './scene3d.ts';
import { t } from '../i18n.ts';

const VIEWS: [ViewName, string][] = [
  ['iso', t('Perspective')],
  ['top', t('Top')],
  ['front', t('Front')],
  ['right', t('Side')],
];

interface Stats {
  size: [number, number, number];
  triangles: number;
  meshes: number;
}

export function ModelViewer({ url, ext }: { url: string; ext: string }) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<{ setView: (view: ViewName) => void; setWireframe: (on: boolean) => void } | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<ViewName>('iso');
  const [wireframe, setWireframe] = useState(false);

  useEffect(() => {
    const container = host.current!;
    let cancelled = false;
    let cleanup = () => {};

    (async () => {
      try {
        const model = await loadModel(ext, await fetchBuffer(url));
        if (cancelled) {
          disposeObject(model.object);
          return;
        }

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        container.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(STAGE_COLOR);
        scene.environment = environmentFor(renderer);
        const { box } = stageObject(scene, model.object, model.zUp);
        const grid = addGrid(scene, box);

        const camera = new THREE.PerspectiveCamera(32, 1);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.12;

        let frame = 0;
        const render = () => {
          frame = 0;
          // Damping keeps moving the camera after release, so keep rendering until it settles.
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

        const applyView = (name: ViewName) => {
          frameCamera(camera, box, name, controls.target);
          controls.update();
          schedule();
        };
        applyView('iso');

        controller.current = {
          setView: applyView,
          setWireframe: (on) => {
            model.object.traverse((child) => {
              const mesh = child as THREE.Mesh;
              if (!mesh.isMesh) return;
              const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              for (const material of materials) (material as THREE.MeshStandardMaterial).wireframe = on;
            });
            schedule();
          },
        };

        const size = box.getSize(new THREE.Vector3());
        // Z-up files were rotated into the scene, so report their sizes in the file's own axes.
        setStats({
          size: model.zUp ? [size.x, size.z, size.y] : [size.x, size.y, size.z],
          triangles: model.triangles,
          meshes: model.meshes,
        });

        cleanup = () => {
          if (frame) cancelAnimationFrame(frame);
          observer.disconnect();
          controls.dispose();
          grid.geometry.dispose();
          (grid.material as THREE.Material).dispose();
          disposeObject(model.object);
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
      controller.current = null;
      cleanup();
    };
  }, [url, ext]);

  return (
    <div className="stage" ref={host}>
      {!stats && !error && <ViewerLoading label={t('Preparing the model')} />}
      {error && <ViewerError message={error} />}
      {stats && (
        <>
          <div className="hud hud-top">
            <div className="seg" role="group" aria-label={t('View angle')}>
              {VIEWS.map(([name, label]) => (
                <button
                  key={name}
                  className={view === name ? 'on' : ''}
                  onClick={() => {
                    setView(name);
                    controller.current?.setView(name);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              className={`hud-btn ${wireframe ? 'on' : ''}`}
              aria-pressed={wireframe}
              onClick={() => {
                controller.current?.setWireframe(!wireframe);
                setWireframe(!wireframe);
              }}
            >{t('Wireframe')}</button>
          </div>
          <div className="hud hud-bottom readout" dir="ltr">
            <span>{stats.size.map((v) => formatNumber(v)).join(' × ')}</span>
            <span>{stats.triangles.toLocaleString('en-US')} tri</span>
            {stats.meshes > 1 && <span>{stats.meshes} parts</span>}
          </div>
        </>
      )}
    </div>
  );
}
