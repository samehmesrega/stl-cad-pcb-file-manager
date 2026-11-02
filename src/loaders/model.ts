// Loads every supported 3D format into a three.js object. Loaders are imported on demand to keep startup light.
import * as THREE from 'three';
import { msg } from '../../shared/i18n.ts';

export interface LoadedModel {
  object: THREE.Object3D;
  /** CAD and printing formats are Z-up, while three.js scenes are Y-up. */
  zUp: boolean;
  triangles: number;
  meshes: number;
}

export const clayMaterial = () =>
  new THREE.MeshStandardMaterial({ color: 0xc9c4b6, roughness: 0.55, metalness: 0.08, side: THREE.DoubleSide });

function occtFormat(ext: string): string {
  if (ext === 'step' || ext === 'stp') return 'step';
  if (ext === 'iges' || ext === 'igs') return 'iges';
  return 'brep';
}

/** STEP, IGES and BREP go through OpenCascade in its own worker because tessellation can take a long time. */
function readWithOcct(ext: string, buffer: ArrayBuffer): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/vendor/occt/occt-import-js-worker.js');
    worker.onmessage = (event) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || msg('Could not read the CAD file')));
    };
    const params = {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5,
    };
    const bytes = new Uint8Array(buffer);
    worker.postMessage({ format: occtFormat(ext), buffer: bytes, params }, [bytes.buffer]);
  });
}

async function loadOcct(ext: string, buffer: ArrayBuffer): Promise<THREE.Object3D> {
  const result = await readWithOcct(ext, buffer);
  if (!result?.success || !result.meshes?.length) throw new Error(msg('This file has no model to display'));
  const group = new THREE.Group();
  for (const mesh of result.meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3));
    if (mesh.attributes.normal) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3));
    } else {
      geometry.computeVertexNormals();
    }
    if (mesh.index) geometry.setIndex(new THREE.Uint32BufferAttribute(mesh.index.array, 1));
    const material = clayMaterial();
    if (mesh.color) material.color.setRGB(mesh.color[0], mesh.color[1], mesh.color[2], THREE.SRGBColorSpace);
    const object = new THREE.Mesh(geometry, material);
    object.name = mesh.name ?? '';
    group.add(object);
  }
  return group;
}

function meshFrom(geometry: THREE.BufferGeometry): THREE.Object3D {
  if (!geometry.index && !geometry.attributes.position?.count) throw new Error(msg('This file has no model'));
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, clayMaterial());
}

async function parseByExtension(ext: string, buffer: ArrayBuffer): Promise<{ object: THREE.Object3D; zUp: boolean }> {
  const text = () => new TextDecoder().decode(buffer);
  switch (ext) {
    case 'stl': {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      return { object: meshFrom(new STLLoader().parse(buffer)), zUp: true };
    }
    case 'obj': {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      const object = new OBJLoader().parse(text());
      object.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).material = clayMaterial();
      });
      return { object, zUp: false };
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
      return { object: new ThreeMFLoader().parse(buffer), zUp: true };
    }
    case 'amf': {
      const { AMFLoader } = await import('three/addons/loaders/AMFLoader.js');
      return { object: new AMFLoader().parse(buffer), zUp: true };
    }
    case 'ply': {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      const geometry = new PLYLoader().parse(buffer);
      if (!geometry.index) {
        return { object: new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xc9c4b6, size: 0.002, sizeAttenuation: true })), zUp: true };
      }
      return { object: meshFrom(geometry), zUp: true };
    }
    case 'glb':
    case 'gltf': {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().parseAsync(buffer, '');
      return { object: gltf.scene, zUp: false };
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      return { object: new FBXLoader().parse(buffer, ''), zUp: false };
    }
    case '3ds': {
      const { TDSLoader } = await import('three/addons/loaders/TDSLoader.js');
      return { object: new TDSLoader().parse(buffer, ''), zUp: true };
    }
    case 'wrl': {
      const { VRMLLoader } = await import('three/addons/loaders/VRMLLoader.js');
      return { object: new VRMLLoader().parse(text(), ''), zUp: false };
    }
    case 'dae': {
      const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
      const collada = new ColladaLoader().parse(text(), '');
      if (!collada) throw new Error(msg('Could not read the DAE file'));
      return { object: collada.scene, zUp: false };
    }
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
    case 'brep':
    case 'brp':
      return { object: await loadOcct(ext, buffer), zUp: true };
    default:
      throw new Error(`Unsupported format: ${ext}`);
  }
}

/**
 * Only one file is uploaded, so textures that formats like FBX and 3DS keep beside the model are missing and
 * render black. A black part on the dark stage is unreadable too. Both fall back to the neutral material.
 */
function visibleMaterial(material: THREE.Material, ext: string): THREE.Material {
  const standard = material as THREE.MeshStandardMaterial;
  const brokenTexture = Boolean(standard.map) && ext !== 'glb' && ext !== 'gltf' && ext !== '3mf';
  const color = standard.color;
  const nearBlack = !standard.map && Boolean(color) && color.r + color.g + color.b < 0.06;
  if (!brokenTexture && !nearBlack) return material;
  material.dispose();
  return clayMaterial();
}

export async function loadModel(ext: string, buffer: ArrayBuffer): Promise<LoadedModel> {
  const { object, zUp } = await parseByExtension(ext, buffer).catch((error) => {
    // Loaders read past the end of damaged files, and their messages mean nothing to a user.
    if (error instanceof RangeError || error instanceof TypeError) throw new Error(msg('This file is damaged or incomplete'));
    throw error;
  });
  if (new THREE.Box3().setFromObject(object).isEmpty()) throw new Error(msg('This file has no model to display'));
  let triangles = 0;
  let meshes = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((m) => visibleMaterial(m, ext));
    else mesh.material = visibleMaterial(mesh.material, ext);
    const geometry = mesh.geometry;
    triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
  });
  return { object, zUp, triangles: Math.round(triangles), meshes };
}

export function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) material.dispose();
  });
}
