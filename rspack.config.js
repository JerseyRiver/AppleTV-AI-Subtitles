import { defineConfig } from '@rspack/cli';
import rspack from '@rspack/core';
import NodePolyfillPlugin from 'node-polyfill-webpack-plugin';
import fs from 'node:fs';
import path from 'node:path';

class SaveModuleNames {
  apply(compiler) {
    compiler.hooks.done.tap('SaveModuleNames', stats => {
      fs.mkdirSync('dist', { recursive: true });
      const data = stats.toJson({ all: false, modules: true, nestedModules: true });
      fs.writeFileSync('dist/modules.json', JSON.stringify(data.modules));
    });
  }
}

export default defineConfig({
  resolve: { alias: {
    '@nsnanocat/util': path.resolve('vendor/nsnanocat-util/index.js'),
    '@nsnanocat/url': path.resolve('vendor/nsnanocat-url/URL.mjs'),
  } },
  entry: {
    'Composite.Subtitles.response': './src/Composite.Subtitles.response.js',
    'Manifest.response': './src/Manifest.response.js',
    'Translate.response': './src/Translate.Apple.response.js',
  },
  output: { chunkFormat: false, filename: '[name].bundle.js', library: { type: 'module' } },
  plugins: [
    new NodePolyfillPlugin(),
    new rspack.BannerPlugin({ banner: 'AppleTV AI Subtitles v1.0.0 — JerseyRiver\nModified from DualSubs Universal (VirgilClyne). GPL-3.0-only combined distribution.\nSource: https://github.com/JerseyRiver/AppleTV-AI-Subtitles\nThird-party licenses: plugin/scripts/LICENSES.txt and NOTICE in that repository.' }),
    new SaveModuleNames(),
  ],
  devtool: false,
  performance: false,
});
