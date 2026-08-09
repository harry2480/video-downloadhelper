/**
 * Offscreen Document のエントリ兼 Composition Root。
 *
 * Manifest V3 の Service Worker では URL.createObjectURL が使えないため、
 * セグメント結合・Blob 生成・オブジェクト URL 発行・ffmpeg.wasm 実行はここで行う。
 * Service Worker が停止しても処理が継続する場所でもある。
 */

console.info('[vdh] offscreen document loaded');

export {};
