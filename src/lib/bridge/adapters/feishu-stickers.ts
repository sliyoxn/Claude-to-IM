/**
 * Feishu Sticker Manager — handles sticker upload, image_key caching, and
 * marker scanning for the Feishu adapter.
 *
 * Stickers are loaded lazily: the first time a sticker id is referenced via
 * a [[sticker:NN_M]] marker, its file is uploaded via im.image.create and
 * the returned image_key is persisted to a JSON cache so subsequent sends
 * reuse the same key. Feishu image_keys are valid long-term, so we trust
 * the cache without revalidation (see feishu-adapter.ts integration).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type * as lark from '@larksuiteoapi/node-sdk';

/** Marker pattern (global, for splitting). lastIndex must be reset before use. */
export const STICKER_MARKER_RE = /\[\[sticker:([0-9]{2}_[0-9])\]\]/g;
/** Same pattern, non-stateful — safe for one-shot detection via .test(). */
export const STICKER_MARKER_DETECT_RE = /\[\[sticker:[0-9]{2}_[0-9]\]\]/;

/** Cheap detection helper — returns true if any sticker marker is present. */
export function hasStickerMarker(text: string): boolean {
  return STICKER_MARKER_DETECT_RE.test(text);
}

/** Default manifest path (汐羽 persona). */
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
  'stickers-cache.json',
);

/** Manifest entry shape. */
export interface StickerEntry {
  id: string;
  file: string;
  emotion: string;
  desc?: string;
  tags?: string[];
}

/** Manifest file shape. */
interface StickerManifest {
  version: number;
  stickers: StickerEntry[];
}

/** Cache entry shape. */
interface StickerCacheEntry {
  image_key: string;
  uploaded_at: string;
}

/** Scanned marker token. */
export type StickerSegment =
  | { type: 'text'; value: string }
  | { type: 'sticker'; id: string };

/**
 * Split text by sticker markers into ordered segments.
 * Empty text segments (when markers are adjacent or at start/end) are dropped.
 */
export function splitByStickers(text: string): StickerSegment[] {
  const segments: StickerSegment[] = [];
  let lastIndex = 0;
  STICKER_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STICKER_MARKER_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const slice = text.slice(lastIndex, match.index).trim();
      if (slice.length > 0) segments.push({ type: 'text', value: slice });
    }
    segments.push({ type: 'sticker', id: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const slice = text.slice(lastIndex).trim();
    if (slice.length > 0) segments.push({ type: 'text', value: slice });
  }
  return segments;
}

export class StickerManager {
  private manifestPath: string;
  private cachePath: string;
  private manifest: Map<string, StickerEntry> = new Map();
  private cache: Map<string, StickerCacheEntry> = new Map();
  /** In-flight upload promises, keyed by sticker id. */
  private uploadPromises: Map<string, Promise<string | null>> = new Map();
  private loaded = false;

  constructor(manifestPath?: string, cachePath?: string) {
    this.manifestPath = manifestPath || DEFAULT_MANIFEST_PATH;
    this.cachePath = cachePath || DEFAULT_CACHE_PATH;
  }

  /**
   * Load manifest + cache from disk. Safe to call multiple times.
   * Failures are logged but never throw — sticker support degrades to
   * fallback text in the adapter.
   */
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
        console.log(`[feishu-stickers] Loaded manifest: ${this.manifest.size} stickers from ${this.manifestPath}`);
      } else {
        console.warn(`[feishu-stickers] Manifest not found: ${this.manifestPath}`);
      }
    } catch (err) {
      console.warn('[feishu-stickers] Failed to load manifest:', err instanceof Error ? err.message : err);
    }

    try {
      if (fs.existsSync(this.cachePath)) {
        const raw = fs.readFileSync(this.cachePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, StickerCacheEntry>;
        if (parsed && typeof parsed === 'object') {
          for (const [id, entry] of Object.entries(parsed)) {
            if (entry && typeof entry.image_key === 'string') {
              this.cache.set(id, entry);
            }
          }
        }
        console.log(`[feishu-stickers] Loaded cache: ${this.cache.size} entries from ${this.cachePath}`);
      }
    } catch (err) {
      console.warn('[feishu-stickers] Failed to load cache:', err instanceof Error ? err.message : err);
    }
  }

  /** Look up entry metadata (used for fallback text on failure). */
  getEntry(id: string): StickerEntry | undefined {
    if (!this.loaded) this.load();
    return this.manifest.get(id);
  }

  /**
   * Get an image_key for the given sticker id. Returns cached key if
   * available, otherwise uploads via SDK and caches the result. Returns
   * null on failure (manifest missing, file missing, upload error).
   */
  async getImageKey(restClient: lark.Client, id: string): Promise<string | null> {
    if (!this.loaded) this.load();

    const cached = this.cache.get(id);
    if (cached) return cached.image_key;

    // Coalesce concurrent requests for the same sticker
    const inflight = this.uploadPromises.get(id);
    if (inflight) return inflight;

    const promise = this.doUpload(restClient, id);
    this.uploadPromises.set(id, promise);
    promise.finally(() => this.uploadPromises.delete(id));
    return promise;
  }

  private async doUpload(restClient: lark.Client, id: string): Promise<string | null> {
    const entry = this.manifest.get(id);
    if (!entry) {
      console.warn(`[feishu-stickers] Unknown sticker id: ${id}`);
      return null;
    }
    if (!fs.existsSync(entry.file)) {
      console.warn(`[feishu-stickers] Sticker file missing: ${entry.file}`);
      return null;
    }

    try {
      const stream = fs.createReadStream(entry.file);
      const res = await restClient.im.image.create({
        data: {
          image_type: 'message',
          image: stream,
        },
      });
      const imageKey = res?.image_key;
      if (!imageKey) {
        console.warn(`[feishu-stickers] image.create returned no image_key for ${id}`);
        return null;
      }
      const cacheEntry: StickerCacheEntry = {
        image_key: imageKey,
        uploaded_at: new Date().toISOString(),
      };
      this.cache.set(id, cacheEntry);
      this.persistCache();
      console.log(`[feishu-stickers] Uploaded ${id} -> ${imageKey}`);
      return imageKey;
    } catch (err) {
      console.warn(
        `[feishu-stickers] Upload failed for ${id}:`,
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
      const obj: Record<string, StickerCacheEntry> = {};
      for (const [id, entry] of this.cache) obj[id] = entry;
      fs.writeFileSync(this.cachePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[feishu-stickers] Failed to persist cache:', err instanceof Error ? err.message : err);
    }
  }
}
