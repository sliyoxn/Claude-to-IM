/**
 * QQ Sticker Manager — handles base64 upload + file_info caching for QQ C2C
 * rich media messages.
 *
 * Reuses the same manifest at ~/.claude/skills/persona/汐羽/sticker/manifest.json
 * as the Feishu sticker manager. The marker scanning helpers
 * (splitByStickers / hasStickerMarker / STICKER_MARKER_*) are exported by
 * feishu-stickers.ts; we depend on them here to avoid divergence in marker
 * format.
 *
 * Caching strategy differs from Feishu: QQ file_info is openid-scoped and has
 * a TTL (default ~10 min). Cache key = `${openid}:${stickerId}`. We refresh
 * 60 s before expiry to avoid races.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { uploadFileBase64 } from './qq-api.js';
import type { StickerEntry } from './feishu-stickers.js';

/** Default manifest path (汐羽 persona, shared with Feishu). */
const DEFAULT_MANIFEST_PATH = path.join(
  os.homedir(),
  '.claude',
  'skills',
  'persona',
  '汐羽',
  'sticker',
  'manifest.json',
);

/** Default cache path. */
const DEFAULT_CACHE_PATH = path.join(
  os.homedir(),
  '.claude-to-im',
  'data',
  'qq-stickers-cache.json',
);

interface StickerManifest {
  version: number;
  stickers: StickerEntry[];
}

interface QQStickerCacheEntry {
  file_info: string;
  expires_at: number; // epoch-ms
  uploaded_at: string;
}

export class QQStickerManager {
  private manifestPath: string;
  private cachePath: string;
  private manifest: Map<string, StickerEntry> = new Map();
  /** Cache keyed by `${openid}:${stickerId}`. */
  private cache: Map<string, QQStickerCacheEntry> = new Map();
  /** In-flight upload promises, keyed by `${openid}:${stickerId}`. */
  private uploadPromises: Map<string, Promise<string | null>> = new Map();
  private loaded = false;

  constructor(manifestPath?: string, cachePath?: string) {
    this.manifestPath = manifestPath || DEFAULT_MANIFEST_PATH;
    this.cachePath = cachePath || DEFAULT_CACHE_PATH;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      if (fs.existsSync(this.manifestPath)) {
        const raw = fs.readFileSync(this.manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as StickerManifest;
        if (parsed && Array.isArray(parsed.stickers)) {
          for (const entry of parsed.stickers) {
            if (entry && typeof entry.id === 'string' && typeof entry.file === 'string') {
              this.manifest.set(entry.id, entry);
            }
          }
        }
        console.log(`[qq-stickers] Loaded manifest: ${this.manifest.size} stickers from ${this.manifestPath}`);
      } else {
        console.warn(`[qq-stickers] Manifest not found: ${this.manifestPath}`);
      }
    } catch (err) {
      console.warn('[qq-stickers] Failed to load manifest:', err instanceof Error ? err.message : err);
    }

    try {
      if (fs.existsSync(this.cachePath)) {
        const raw = fs.readFileSync(this.cachePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, QQStickerCacheEntry>;
        if (parsed && typeof parsed === 'object') {
          for (const [key, entry] of Object.entries(parsed)) {
            if (entry && typeof entry.file_info === 'string' && typeof entry.expires_at === 'number') {
              this.cache.set(key, entry);
            }
          }
        }
        console.log(`[qq-stickers] Loaded cache: ${this.cache.size} entries from ${this.cachePath}`);
      }
    } catch (err) {
      console.warn('[qq-stickers] Failed to load cache:', err instanceof Error ? err.message : err);
    }
  }

  getEntry(id: string): StickerEntry | undefined {
    if (!this.loaded) this.load();
    return this.manifest.get(id);
  }

  /**
   * Get a valid file_info for `(openid, stickerId)`. Returns cached value if
   * not expired, otherwise re-uploads via base64 and caches the new file_info.
   * Returns null on failure (manifest missing, file missing, upload error).
   */
  async getFileInfo(
    accessToken: string,
    openid: string,
    stickerId: string,
  ): Promise<string | null> {
    if (!this.loaded) this.load();

    const cacheKey = `${openid}:${stickerId}`;
    const cached = this.cache.get(cacheKey);
    // Refresh 60 s before expiry to avoid races
    if (cached && cached.expires_at - 60_000 > Date.now()) {
      return cached.file_info;
    }

    const inflight = this.uploadPromises.get(cacheKey);
    if (inflight) return inflight;

    const promise = this.doUpload(accessToken, openid, stickerId);
    this.uploadPromises.set(cacheKey, promise);
    promise.finally(() => this.uploadPromises.delete(cacheKey));
    return promise;
  }

  private async doUpload(
    accessToken: string,
    openid: string,
    stickerId: string,
  ): Promise<string | null> {
    const entry = this.manifest.get(stickerId);
    if (!entry) {
      console.warn(`[qq-stickers] Unknown sticker id: ${stickerId}`);
      return null;
    }
    if (!fs.existsSync(entry.file)) {
      console.warn(`[qq-stickers] Sticker file missing: ${entry.file}`);
      return null;
    }

    try {
      const buffer = fs.readFileSync(entry.file);
      const base64 = buffer.toString('base64');
      const result = await uploadFileBase64(accessToken, openid, 1, base64);

      const cacheKey = `${openid}:${stickerId}`;
      const cacheEntry: QQStickerCacheEntry = {
        file_info: result.fileInfo,
        expires_at: Date.now() + result.ttl * 1000,
        uploaded_at: new Date().toISOString(),
      };
      this.cache.set(cacheKey, cacheEntry);
      this.persistCache();
      console.log(`[qq-stickers] Uploaded ${stickerId} for ${openid.slice(0, 8)} (ttl=${result.ttl}s)`);
      return result.fileInfo;
    } catch (err) {
      console.warn(
        `[qq-stickers] Upload failed for ${stickerId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private persistCache(): void {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const obj: Record<string, QQStickerCacheEntry> = {};
      for (const [key, entry] of this.cache) obj[key] = entry;
      fs.writeFileSync(this.cachePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[qq-stickers] Failed to persist cache:', err instanceof Error ? err.message : err);
    }
  }
}
