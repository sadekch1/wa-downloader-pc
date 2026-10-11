// يجمّع المحرك (Baileys وكل اعتماداته) في ملف واحد dist/engine.js
const esbuild = require('esbuild');
esbuild.build({
    entryPoints: ['src/engine.js'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: 'dist/engine.js',
    external: ['sharp', 'jimp', 'link-preview-js', 'bufferutil', 'utf-8-validate',
               'audio-decode', 'qrcode-terminal', '@ffmpeg-installer/ffmpeg', 'electron'],
    logLevel: 'warning'
}).then(() => console.log('engine bundled → dist/engine.js'))
  .catch(() => process.exit(1));
