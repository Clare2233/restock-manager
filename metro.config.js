// Learn more: https://docs.expo.dev/versions/v57.0.0/config/metro/
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

/**
 * expo-sqlite 的 Web 实现是「主线程 + Web Worker + WebAssembly」三段式，
 * 而 worker 会直接 import 一个 .wasm 资源：
 *
 *   node_modules/expo-sqlite/web/worker.ts
 *     -> import wasmModule from './wa-sqlite/wa-sqlite.wasm';
 *
 * Metro 默认的 resolver.assetExts（见 metro-config/src/defaults/defaults.js）
 * 里没有 'wasm'，@expo/metro-config 也没有补。于是这个 import 解析失败，
 * worker 模块无法被收集成独立 chunk，web 打包时 serializer 断言失败：
 *
 *   Worker chunk not found for: .../expo-sqlite/web/worker.ts
 *   (node_modules/@expo/metro-config/build/serializer/serializeChunks.js:525)
 *
 * 官方文档要求把 wasm 显式注册为「资源」扩展名（不是 sourceExts，否则会被当成 JS 解析）。
 * 注意：'wasm' 在 web 上要作为资源 URL 使用（worker 里 locateFile 需要的是 URL）。
 */
config.resolver.assetExts.push('wasm');

module.exports = config;
