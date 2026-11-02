import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Toolpath } from '../loaders/gcode.ts';

export type ViewName = 'iso' | 'top' | 'front' | 'right';

export const STAGE_COLOR = 0x15191c;

const environments = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

export function environmentFor(renderer: THREE.WebGLRenderer): THREE.Texture {
  let texture = environments.get(renderer);
  if (!texture) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    environments.set(renderer, texture);
  }
  return texture;
}

/** Puts the object in a Y-up scene, resting on the grid and centred on the origin. */
export function stageObject(scene: THREE.Scene, object: THREE.Object3D, zUp: boolean) {
  const root = new THREE.Group();
  if (zUp) root.rotation.x = -Math.PI / 2;
  root.add(object);
  scene.add(root);
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.set(-center.x, -box.min.y, -center.z);
  root.updateMatrixWorld(true);
  box.setFromObject(root);
  return { root, box };
}

export function addGrid(scene: THREE.Scene, box: THREE.Box3): THREE.GridHelper {
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 1e-3) * 1.6;
  // Snap cell size to 1, 2 or 5 times a power of ten so the grid reads like a ruler.
  const rough = span / 16;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = [1, 2, 5, 10].find((m) => m * power >= rough)! * power;
  const divisions = Math.ceil(span / unit);
  const grid = new THREE.GridHelper(divisions * unit, divisions, 0x46525a, 0x2a3338);
  grid.position.y = box.min.y;
  scene.add(grid);
  return grid;
}

export function frameCamera(camera: THREE.PerspectiveCamera, box: THREE.Box3, view: ViewName, target: THREE.Vector3) {
  const center = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1e-3);
  const fov = (camera.fov * Math.PI) / 180;
  const fitFov = camera.aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) * camera.aspect) : fov;
  const distance = (radius / Math.sin(fitFov / 2)) * 1.08;

  const directions: Record<ViewName, THREE.Vector3> = {
    iso: new THREE.Vector3(1, 0.8, 1.2),
    top: new THREE.Vector3(0, 1, 0.0001),
    front: new THREE.Vector3(0, 0, 1),
    right: new THREE.Vector3(1, 0, 0),
  };
  camera.position.copy(center).addScaledVector(directions[view].normalize(), distance);
  camera.near = Math.max(distance / 1000, 1e-4);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  target.copy(center);
}

const lowColor = new THREE.Color(0xff5a1f);
const highColor = new THREE.Color(0xffd08a);

/** Feed moves are coloured by height, so the build-up of layers is visible. */
export function toolpathObjects(toolpath: Toolpath) {
  const range = Math.max(toolpath.max[2] - toolpath.min[2], 1e-6);
  const colors = new Float32Array(toolpath.feed.length);
  const color = new THREE.Color();
  for (let i = 0; i < toolpath.feed.length; i += 3) {
    color.copy(lowColor).lerp(highColor, (toolpath.feed[i + 2] - toolpath.min[2]) / range);
    colors[i] = color.r;
    colors[i + 1] = color.g;
    colors[i + 2] = color.b;
  }
  const feedGeometry = new THREE.BufferGeometry();
  feedGeometry.setAttribute('position', new THREE.BufferAttribute(toolpath.feed, 3));
  feedGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const feed = new THREE.LineSegments(feedGeometry, new THREE.LineBasicMaterial({ vertexColors: true }));

  const travelGeometry = new THREE.BufferGeometry();
  travelGeometry.setAttribute('position', new THREE.BufferAttribute(toolpath.travel, 3));
  const travel = new THREE.LineSegments(
    travelGeometry,
    new THREE.LineBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.35 }),
  );
  const group = new THREE.Group();
  group.add(feed, travel);
  return { group, feed, travel };
}

/** Box of the feed moves only, so long travels to the park position do not shrink the view. */
export function toolpathBox(toolpath: Toolpath, root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3(
    new THREE.Vector3(...toolpath.min),
    new THREE.Vector3(...toolpath.max),
  );
  root.updateMatrixWorld(true);
  return box.applyMatrix4(root.matrixWorld);
}
