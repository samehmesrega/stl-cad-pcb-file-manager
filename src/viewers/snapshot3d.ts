// One-shot 3D renders for thumbnails, kept apart from thumbs.ts so three.js stays out of the main bundle.
import * as THREE from 'three';
import { disposeObject, loadModel } from '../loaders/model.ts';
import { fetchBuffer, parseToolpath } from '../loaders/parseClient.ts';
import { STAGE_COLOR, environmentFor, frameCamera, stageObject, toolpathBox, toolpathObjects } from './scene3d.ts';
import type { ViewName } from './scene3d.ts';

type Encode = (canvas: HTMLCanvasElement) => Promise<Blob>;

/** One renderer serves all thumbnails, because browsers cap the number of WebGL contexts. */
let renderer: THREE.WebGLRenderer | null = null;
function thumbRenderer(width: number, height: number) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }
  renderer.setSize(width, height, false);
  return renderer;
}

function shoot(scene: THREE.Scene, box: THREE.Box3, view: ViewName, width: number, height: number, encode: Encode) {
  const r = thumbRenderer(width, height);
  scene.background = new THREE.Color(STAGE_COLOR);
  scene.environment = environmentFor(r);
  const camera = new THREE.PerspectiveCamera(32, width / height);
  frameCamera(camera, box, view, new THREE.Vector3());
  r.render(scene, camera);
  return encode(r.domElement);
}

export async function snapshotModel(url: string, ext: string, width: number, height: number, encode: Encode): Promise<Blob> {
  const model = await loadModel(ext, await fetchBuffer(url));
  try {
    const scene = new THREE.Scene();
    const { box } = stageObject(scene, model.object, model.zUp);
    return await shoot(scene, box, 'iso', width, height, encode);
  } finally {
    disposeObject(model.object);
  }
}

export async function snapshotToolpath(url: string, width: number, height: number, encode: Encode): Promise<Blob> {
  const toolpath = await parseToolpath(await fetchBuffer(url));
  const { group, feed, travel } = toolpathObjects(toolpath);
  try {
    const scene = new THREE.Scene();
    group.rotation.x = -Math.PI / 2;
    travel.visible = false;
    scene.add(group);
    return await shoot(scene, toolpathBox(toolpath, group), toolpath.flat ? 'top' : 'iso', width, height, encode);
  } finally {
    feed.geometry.dispose();
    travel.geometry.dispose();
  }
}
