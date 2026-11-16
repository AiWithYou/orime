/** App state regression tests with mocked hooks, network and ComfyUI; no GPU required. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';
import * as recipeModule from '../adapters/recipes.mjs';
import { recipeBindings, inspectBindings } from '../frontend/graph.mjs';
import { reconcileJob, cancelJob } from '../frontend/jobs.mjs';
import { recipeImageBindings } from '../frontend/canvas-inputs.mjs';
import { compositeMasked } from '../frontend/recipe-options.mjs';

const root = new URL('../', import.meta.url);
const clone = (value) => structuredClone(value);
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

async function createAppHarness({ api = async () => ({}) } = {}) {
  let source = await fs.readFile(new URL('frontend/main.jsx', root), 'utf8');
  const rootRender = /createRoot\(document[^\n]+\);\s*$/;
  const returnMain = /  return \(\r?\n    <main>/;
  assert.match(source, rootRender, 'App root mount must be found');
  assert.match(source, returnMain, 'App JSX return must be found');
  source = source.replace(rootRender, 'globalThis.__renderApp = App;');
  source = source.replace(
    returnMain,
    `  globalThis.__testApp = {
      sync, switchMode, update, editControl, save, archive, restoreDraft, newRecipe, openImageTool,
      setters: { setReady, setInfo, setCaps, setJobs, setSource, setMaskSource,
        setSettings, setActiveJob, setBusy, setMode, setCustom },
      refs: { workflow, bindings, bridge, canvas, dirty, changed,
        imageBindings },
      values: { settings, mode, custom, jobs, busy, activeJob, error, message, source, maskSource }
    };
  return (
    <main>`,
  );
  // The browser-only recipe URL is an injected dependency, not a code path mock.
  source = source.replace(
    /import\(\/\* @vite-ignore \*\/ (\w+)\)/g,
    'globalThis.__loadModule($1)',
  );
  const compiled = await transform(source, {
    loader: 'jsx', format: 'cjs', target: 'es2022',
  });

  const states = [], refs = [], effects = [], downloads = [], posts = [], uploads = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: (effect) => { effects[effectIndex++] = effect; },
    useState(initial) {
      const i = stateIndex++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], (value) => {
        states[i] = typeof value === 'function' ? value(states[i]) : value;
      }];
    },
    useRef(initial) {
      return refs[refIndex++] ??= { current: initial };
    },
  };
  const modules = {
    react,
    'react-dom/client': { createRoot: () => ({ render() {} }) },
    'lucide-react': {},
    './Canvas.jsx': () => null,
    './ImageTools.jsx': () => null,
    './ResultPreview.jsx': () => null,
    './ShutdownButton.jsx': () => null,
    './style.css': {},
    './api.mjs': {
      api,
      async post(path, data) {
        posts.push([path, clone(data)]);
        if (path === '/canvas-api/drafts') return { ...clone(data), id: 'fixture-draft', created: 1 };
        throw Error(`Unexpected real-operation path in App state harness: ${path}`);
      },
      download(name, data) { downloads.push({ name, data: clone(data) }); },
      imageURL: (image) => `/view?filename=${encodeURIComponent(image.filename)}&type=${image.type || 'output'}`,
      async upload(blob, name) { uploads.push({ blob, name }); return name; },
      createBridge: () => { throw Error('Do not run the live bridge effect in this harness'); },
    },
  };
  for (const match of source.matchAll(/from ["'](\.\/[^"']+\.mjs)["']/g)) {
    const name = match[1];
    if (!(name in modules)) {
      modules[name] = await import(new URL(`frontend/${name.slice(2)}`, root));
    }
  }
  const context = {
    require(name) {
      assert.ok(name in modules, `Unexpected dependency: ${name}`);
      return modules[name];
    },
    console,
    localStorage: { getItem: () => null, setItem() {} },
    module: { exports: {} }, exports: {}, Set, structuredClone,
    crypto: globalThis.crypto,
    __loadModule: async (name) => {
      assert.equal(name, '/canvas-api/recipes.mjs');
      return recipeModule;
    },
  };
  vm.createContext(context);
  vm.runInContext(compiled.code, context, { filename: 'main.jsx (App state harness)' });
  const render = () => {
    stateIndex = refIndex = effectIndex = 0;
    context.__renderApp();
    return context.__testApp;
  };
  let app = render();
  app.setters.setReady(true);
  app.setters.setCaps(recipeModule.recipeCapabilities.sdxl);
  const fixture = recipeModule.buildRecipe('sdxl', { prompt: 'fixture', checkpoint: 'fixture.safetensors' });
  app.setters.setInfo(Object.fromEntries(Object.values(fixture).map((n) => [n.class_type, { input: {} }])));
  app.refs.canvas.current = {
    hasMask: () => false,
    imageBlob: async (mask = false) => ({ fixture: mask ? 'mask' : 'image' }),
    size: [1024, 1024],
  };
  render();
  return { render, effects, downloads, posts, uploads };
}

function createFixtureBridge(initialPrompt = recipeModule.buildRecipe('sdxl', { prompt: 'COMFY OLD' })) {
  let prompt = clone(initialPrompt), graphId = 'fixture-graph-0', sequence = 0;
  const calls = [];
  const snapshot = () => ({
    graphId, prompt: clone(prompt), controls: [],
    workflow: {
      extra: { aikimiGraphId: graphId },
      nodes: Object.entries(prompt).map(([id, n]) => ({
        id, type: n.class_type, fixtureInputs: clone(n.inputs),
      })),
    },
  });
  return {
    calls, snapshot,
    async call(action, payload = {}) {
      calls.push({ action, payload: clone(payload) });
      if (action === 'load-api') {
        prompt = clone(payload.prompt);
        graphId = `fixture-graph-${++sequence}`;
      } else if (action === 'load-workflow') {
        prompt = Object.fromEntries(payload.workflow.nodes.map((n) => [n.id, {
          class_type: n.type, inputs: clone(n.fixtureInputs),
        }]));
        graphId = payload.workflow.extra?.aikimiGraphId || `fixture-graph-${++sequence}`;
      } else if (action === 'patch') {
        assert.equal(payload.graphId, graphId, 'App must send the current graph identity');
        for (const binding of payload.bindings) {
          if (!(binding.key in payload.values)) continue;
          const node = prompt[binding.nodeId];
          assert.equal(node.class_type, binding.type);
          assert.ok(!Array.isArray(node.inputs[binding.input]));
          node.inputs[binding.input] = payload.values[binding.key];
        }
      } else assert.equal(action, 'snapshot');
      return snapshot();
    },
  };
}

function attachBuiltRecipe(harness, bridge) {
  const app = harness.render();
  app.refs.bridge.current = bridge;
  app.refs.workflow.current = bridge.snapshot();
  app.refs.bindings.current = recipeBindings(bridge.snapshot().prompt);
  app.refs.dirty.current = false;
  return harness.render();
}

test('last pinned input wins without dropping unrelated pending form changes', async () => {
  const h = await createAppHarness();
  const bridge = createFixtureBridge();
  let app = attachBuiltRecipe(h, bridge);
  const binding = app.refs.bindings.current.find((b) => b.key === 'prompt');
  app.update('prompt', 'FORM B');
  app.update('seed', 73);
  app = h.render();
  await app.editControl({ ...binding, key: `${binding.nodeId}.${binding.input}` }, 'PIN C');
  app = h.render();
  assert.equal(app.values.settings.prompt, 'PIN C');
  assert.equal(app.refs.changed.current.has('prompt'), false);
  assert.equal(app.refs.changed.current.has('seed'), true);
  const snap = await app.sync();
  assert.equal(snap.prompt[binding.nodeId].inputs[binding.input], 'PIN C');
  assert.equal(Object.values(snap.prompt).find((n) => n.class_type === 'KSampler').inputs.seed, 73);
});

test('disk history appears offline and preserves jobs submitted during recovery', async () => {
  let releaseDisk;
  const disk = new Promise((resolve) => { releaseDisk = resolve; });
  const h = await createAppHarness({
    api: async (path) => {
      if (path === '/canvas-api/jobs') return disk;
      throw Error('ComfyUI is offline');
    },
  });
  const recover = h.effects.find((f) => f.toString().includes('async function recover'));
  assert.ok(recover, 'Actual recovery effect must be found');
  const cleanup = recover();
  await flush();
  let app = h.render();
  app.setters.setJobs([{ id: 'new', status: '生成中', created: 2 }]);
  releaseDisk([{ id: 'old', status: '完了', created: 1 }]);
  await flush();
  app = h.render();
  assert.deepEqual(Array.from(app.values.jobs, (job) => job.id), ['new', 'old']);
  cleanup();
});

test('changing workflow in the node editor clears canvas input before generation', async () => {
  const h = await createAppHarness();
  const original = recipeModule.buildRecipe('sdxl', { image: 'input.png' });
  const bridge = createFixtureBridge(original);
  let app = attachBuiltRecipe(h, bridge);
  app.refs.imageBindings.current = recipeImageBindings(original, 'input.png');
  app.setters.setSource('input.png');
  app.setters.setMaskSource('mask.png');
  app.setters.setMode('nodes');
  await bridge.call('load-api', {prompt: recipeModule.buildRecipe('sdxl', {prompt: 'new graph'})});
  await h.render().switchMode('canvas');
  app = h.render();
  assert.equal(app.values.source, null);
  assert.equal(app.values.maskSource, null);
  assert.deepEqual((await app.sync()).prompt, bridge.snapshot().prompt);
});

test('saving and running a masked graph preserves a node-driven width and editable height', async () => {
  const h = await createAppHarness();
  const base = recipeModule.buildRecipe('sdxl', {image: 'input.png', mask: 'mask.png'});
  const graph = compositeMasked(base, {image: 'input.png', mask: 'mask.png', width: 64, height: 64});
  const bindings = recipeImageBindings(graph, 'input.png', 'mask.png');
  const scale = bindings.find((b) => b.key === 'imageWidth').nodeId;
  graph[scale].inputs.width = ['999', 0];
  graph['999'] = {class_type: 'PrimitiveInt', inputs: {value: 64}};
  const bridge = createFixtureBridge(graph);
  const app = attachBuiltRecipe(h, bridge);
  app.refs.bindings.current = recipeBindings(base);
  app.refs.imageBindings.current = bindings;
  app.setters.setSource('input.png');
  await h.render().save();
  assert.equal(h.downloads.length, 1, h.render().values.error);
  const result = await h.render().sync();
  assert.deepEqual(result.prompt[scale].inputs.width, ['999', 0]);
  assert.equal(result.prompt[scale].inputs.height, 1024);
  await h.render().newRecipe();
  assert.equal(h.render().refs.workflow.current, null);
});

test('clicking the already selected mode preserves unsent form edits', async () => {
  const h = await createAppHarness();
  const bridge = createFixtureBridge();
  let app = attachBuiltRecipe(h, bridge);
  app.update('prompt', 'UNSENT FORM');
  app = h.render();
  await app.switchMode('canvas');
  app = h.render();
  assert.equal(app.values.settings.prompt, 'UNSENT FORM');
  assert.equal(app.refs.changed.current.has('prompt'), true);
  assert.equal(bridge.calls.length, 0);
});

test('first node round trip before generation compiles and preserves the draft', async () => {
  const h = await createAppHarness();
  const bridge = createFixtureBridge();
  let app = h.render();
  app.refs.bridge.current = bridge;
  app.update('prompt', 'FIRST DRAFT');
  app.update('checkpoint', 'fixture.safetensors');
  app = h.render();
  await app.switchMode('nodes');
  app = h.render();
  assert.equal(app.values.error, '');
  assert.equal(app.values.mode, 'nodes');
  assert.ok(bridge.calls.some((call) => call.action === 'load-api'));
  const positive = app.refs.bindings.current.find((b) => b.key === 'prompt');
  assert.equal(bridge.snapshot().prompt[positive.nodeId].inputs[positive.input], 'FIRST DRAFT');
  await app.switchMode('canvas');
  app = h.render();
  assert.equal(app.values.mode, 'canvas');
  assert.equal(app.values.custom, false);
  assert.equal(app.values.settings.prompt, 'FIRST DRAFT');
  assert.equal(app.refs.dirty.current, false);
});

test('positive/negative rewiring blocks those bindings without blocking seed', () => {
  const prompt = recipeModule.buildRecipe('sdxl', { prompt: 'positive', negative: 'negative' });
  const bindings = recipeBindings(prompt);
  const sampler = Object.values(prompt).find((node) => node.class_type === 'KSampler');
  [sampler.inputs.positive, sampler.inputs.negative] = [sampler.inputs.negative, sampler.inputs.positive];
  const checked = inspectBindings(prompt, bindings);
  assert.ok(checked.blocked.prompt);
  assert.ok(checked.blocked.negative);
  assert.equal(checked.blocked.seed, undefined);
});

test('PreviewImage temp output remains visible in completed results', () => {
  const image = { filename: 'fixture-preview.png', type: 'temp', subfolder: '' };
  const job = reconcileJob({ id: 'preview' }, {
    preview: { status: { completed: true, status_str: 'success' }, outputs: { 9: { images: [image] } } },
  }, {});
  assert.equal(job.status, '完了');
  assert.deepEqual(job.images, [image]);
});

test('cancel uses the atomic job endpoint; no global interrupt is requested', async () => {
  const posts = [];
  await cancelJob(async () => ({}), async (...args) => { posts.push(args); }, 'fixture-id');
  assert.deepEqual(posts, [['/api/jobs/fixture-id/cancel', {}]]);
});

test('restored mask draft preserves its graph until explicit new recipe creation', async () => {
  const h = await createAppHarness();
  const prompt = recipeModule.buildRecipe('sdxl', { prompt: 'edit', image: 'old-input.png' });
  const bridge = createFixtureBridge(prompt);
  let app = attachBuiltRecipe(h, bridge);
  app.refs.imageBindings.current = recipeImageBindings(prompt, 'old-input.png');
  app.refs.canvas.current.hasMask = () => true;
  app.setters.setSource('data:image/png;base64,fixture');
  const classes = new Set([
    ...Object.values(prompt).map((n) => n.class_type),
    'SetLatentNoiseMask', 'ImageScale', 'ImageCompositeMasked',
  ]);
  app.setters.setInfo(Object.fromEntries([...classes].map((name) => [name, { input: {} }])));
  app = h.render();
  await app.save();
  const draft = h.downloads.at(-1)?.data;
  assert.equal(draft.aikimiDraft, true);
  assert.equal(draft.needsCanvasCompile, true);
  assert.equal(draft.nodes, undefined);
  await app.restoreDraft(draft);
  app = h.render();
  assert.ok(app.values.maskSource, 'Saved mask must remain selected after restore');
  assert.equal(app.refs.dirty.current, false, 'Restoring an existing graph must not schedule a rebuild');
  assert.match(app.values.message, /新規レシピ/);
  assert.deepEqual(bridge.snapshot().prompt, prompt, 'Restore must preserve all existing graph nodes');
  await assert.rejects(app.sync(), /マスク処理がありません/);
  assert.deepEqual(bridge.snapshot().prompt, prompt, 'Blocked synchronization must preserve the graph');
  await app.newRecipe();
  app = h.render();
  assert.equal(app.refs.dirty.current, true);
  assert.equal(app.refs.workflow.current, null);
  assert.ok(app.values.maskSource, 'Explicit new recipe creation must retain the restored mask');
  const synchronized = await app.sync();
  assert.ok(Object.values(synchronized.prompt).some((n) => n.class_type === 'ImageCompositeMasked'));
});

for (const explicitCustom of [true, false]) {
  test(`restored custom graph with unbound source preserves nodes (custom=${explicitCustom})`, async () => {
    const h = await createAppHarness();
    const prompt = recipeModule.buildRecipe('sdxl', { prompt: 'preserve custom graph' });
    const output = Object.values(prompt).find((n) => n.class_type === 'SaveImage');
    assert.ok(output, 'Fixture must have a real output path');
    prompt['9001'] = {
      class_type: 'FixtureCustomImageEffect',
      inputs: { image: clone(output.inputs.images), strength: 0.25 },
    };
    output.inputs.images = ['9001', 0];
    const bridge = createFixtureBridge(prompt);
    let app = attachBuiltRecipe(h, bridge);
    if (explicitCustom) app.refs.bindings.current = [];
    app.setters.setCustom(explicitCustom);
    app.setters.setSource('data:image/png;base64,fixture');
    // A standard recipe can keep valid bindings after a custom node is added.
    // Include image-recipe classes so an unwanted rebuild cannot hide behind
    // a deliberately incomplete object_info fixture.
    const classes = new Set([
      ...Object.values(prompt).map((n) => n.class_type), 'VAEEncode', 'LoadImage',
    ]);
    app.setters.setInfo(Object.fromEntries([...classes].map((name) => [name, { input: {} }])));
    app = h.render();
    await app.save();
    const draft = h.downloads.at(-1)?.data;
    assert.equal(draft.needsCanvasCompile, true);
    assert.equal(draft.custom, explicitCustom);
    assert.ok(draft.workflow.nodes.some((n) => n.id === '9001'));
    await app.restoreDraft(draft);
    app = h.render();
    assert.equal(app.refs.dirty.current, false, 'Existing custom graph must not be automatically rebuilt');
    assert.match(app.values.message, /新規レシピ/);
    assert.ok(app.values.source, 'Unbound source must remain available after restore');
    assert.deepEqual(bridge.snapshot().prompt, prompt);
    const callsBeforeSync = bridge.calls.length;
    await assert.rejects(app.sync(), /画像入力は未指定/);
    assert.deepEqual(bridge.snapshot().prompt, prompt, 'Unbound source must not erase any custom nodes or edges');
    assert.equal(bridge.calls.slice(callsBeforeSync).some((call) => call.action === 'load-api'), false);
  });
}

test('image tool opening archives original work and preserves explicit image bindings on round trip', async () => {
  const info={LoadImage:{input:{}},SaveImage:{input:{}},CannyEdgePreprocessor:{output:['IMAGE'],input:{required:{image:['IMAGE'],resolution:['INT',{default:512,min:64,max:4096}]}}}};
  const h=await createAppHarness({api:async path=>{assert.equal(path,'/object_info');return info;}});
  const bridge=createFixtureBridge();
  let app=attachBuiltRecipe(h,bridge);
  app.setters.setSource('fixture-original-image');
  app=h.render();
  const original=bridge.snapshot().prompt;
  await app.openImageTool('canny',{resolution:768});
  app=h.render();
  assert.equal(h.posts[0][0],'/canvas-api/drafts');
  assert.equal(h.posts[0][1].workflow.nodes.length,Object.keys(original).length);
  assert.equal(app.values.source,'fixture-original-image');
  assert.equal(app.values.custom,true);
  assert.equal(app.refs.dirty.current,false);
  assert.equal(bridge.snapshot().prompt['2'].inputs.resolution,768);
  const graphId=bridge.snapshot().graphId;
  await app.switchMode('nodes');app=h.render();
  await app.switchMode('canvas');app=h.render();
  await app.sync();
  assert.equal(bridge.snapshot().graphId,graphId);
  assert.equal(bridge.snapshot().prompt['2'].inputs.resolution,768);
  assert.equal(bridge.snapshot().prompt['1'].inputs.image,h.uploads.at(-1).name);
});

test('invalid image tool schema does not replace the current graph or archive it', async () => {
  const h=await createAppHarness({api:async()=>({})});
  const bridge=createFixtureBridge();
  let app=attachBuiltRecipe(h,bridge);
  app.setters.setSource('fixture-image');app=h.render();
  const original=bridge.snapshot();
  await assert.rejects(app.openImageTool('canny',{}),/未導入/);
  assert.deepEqual(bridge.snapshot(),original);
  assert.equal(h.posts.length,0);
});
