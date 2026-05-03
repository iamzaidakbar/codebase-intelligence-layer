import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const extConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', '@cil/daemon', '@cil/daemon/*'],
  sourcemap: true,
  logLevel: 'info',
};

const webviewConfig = {
  entryPoints: ['src/webview/client/main.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ext = await esbuild.context(extConfig);
  const wv = await esbuild.context(webviewConfig);
  await Promise.all([ext.watch(), wv.watch()]);
  console.log('watching...');
} else {
  await Promise.all([
    esbuild.build(extConfig),
    esbuild.build(webviewConfig),
  ]);
}
