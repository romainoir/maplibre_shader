const THREE_MODULE_URL = 'https://unpkg.com/three@0.150.0/build/three.module.js';

async function loadThreeNamespace() {
  const threeModule = await import(THREE_MODULE_URL);
  const namespace = {};
  const defaultExport = threeModule?.default;
  if (defaultExport && typeof defaultExport === 'object') {
    Object.assign(namespace, defaultExport);
  }
  Object.assign(namespace, threeModule);
  delete namespace.default;
  return namespace;
}

function ensureThreeGlobal() {
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }
  if (window.THREE && typeof window.THREE === 'object') {
    return Promise.resolve(window.THREE);
  }
  return loadThreeNamespace().then((namespace) => {
    window.THREE = namespace;
    return namespace;
  });
}

const existingReady = (typeof window !== 'undefined' && window.__threeReady && typeof window.__threeReady.then === 'function')
  ? window.__threeReady
  : null;

const readyPromise = (existingReady ? existingReady.then(() => ensureThreeGlobal()) : ensureThreeGlobal())
  .catch((error) => {
    console.error('Failed to load Three.js module', error);
    throw error;
  });

if (typeof window !== 'undefined') {
  window.__threeReady = readyPromise;
}
